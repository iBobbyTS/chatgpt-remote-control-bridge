import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, after } from "node:test";
import WebSocket from "ws";
import { BridgeAuthManager } from "../src/auth/manager.ts";
import { makeTestJwt } from "../src/auth/jwt.ts";
import { writeAuthStore, type AuthDotJson } from "../src/auth/store.ts";
import { MockWhamServer, type MockWhamOptions } from "../src/wham/mockServer.ts";
import { WhamClient, WhamError } from "../src/wham/client.ts";
import { WhamTunnel, ENROLLMENT_FILENAME } from "../src/wham/tunnel.ts";
import {
  REST_PATHS,
  WS_HEADERS,
  environmentClientPath,
  type ClientEnvelope,
  type EnrollRemoteServerResponse,
  type ServerEnvelope,
} from "../src/wham/protocol.ts";
import type {
  AgentApp,
  AgentClientKey,
  AgentClientState,
  AgentNotification,
  JsonRpcOutcome,
} from "../src/agents/types.ts";

const cleanupDirs: string[] = [];
after(async () => {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(slug: string): Promise<string> {
  const base = join(process.cwd(), ".agent-work", "tmp", "wham-tests");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, `${slug}-`));
  cleanupDirs.push(dir);
  return dir;
}

interface Started {
  server: MockWhamServer;
  port: number;
  jsonlPath: string;
}

async function startMock(overrides: Partial<MockWhamOptions> = {}): Promise<Started> {
  const dir = await tempDir("home");
  const jsonlPath = join(dir, "frames.jsonl");
  const server = new MockWhamServer({
    port: 0,
    jsonlPath,
    autoScript: false,
    log: () => {},
    ...overrides,
  });
  await server.start();
  return { server, port: server.port, jsonlPath };
}

function fakeAuth(): AuthDotJson {
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const jwt = makeTestJwt({
    exp,
    email: "wham@test",
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "free",
      chatgpt_user_id: "u1",
      chatgpt_account_id: "acc-1",
    },
  });
  return {
    auth_mode: "chatgpt",
    openai_api_key: null,
    tokens: { id_token: jwt, access_token: jwt, refresh_token: "rt-1", account_id: "acc-1" },
    last_refresh: new Date().toISOString(),
  };
}

async function makeAuthManager(): Promise<{ authManager: BridgeAuthManager; home: string }> {
  const home = await tempDir("auth");
  await writeAuthStore(home, fakeAuth());
  return { authManager: new BridgeAuthManager({ codexHome: home }), home };
}

/** 最小 AgentApp stub（AC4/AC6/AC7）：结构化实现，不依赖 sim 类型。 */
class StubAgentApp extends EventEmitter {
  readonly states = new Map<string, AgentClientState>();
  readonly failMethods = new Set<string>();

  clientState(key: AgentClientKey): AgentClientState {
    const id = `${key.clientId}/${key.streamId}`;
    let state = this.states.get(id);
    if (!state) {
      state = { clientInfo: null, optOut: new Set(), unsubscribed: new Set(), initialized: false };
      this.states.set(id, state);
    }
    return state;
  }

  forgetClient(key: AgentClientKey): void {
    this.states.delete(`${key.clientId}/${key.streamId}`);
  }

  pongStatus(): "active" | "unknown" {
    return "unknown";
  }

  close(): void {}

  async handleRequest(
    key: AgentClientKey,
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<JsonRpcOutcome> {
    const state = this.clientState(key);
    if (this.failMethods.has(method)) {
      throw new Error(`stub boom: ${method}`);
    }
    const p = (params ?? {}) as Record<string, any>;
    switch (method) {
      case "initialize":
        state.initialized = true;
        state.clientInfo = p.clientInfo ?? null;
        state.optOut = new Set(p.capabilities?.optOutNotificationMethods ?? []);
        return {
          id,
          result: {
            userAgent: "stub/1.0",
            codexHome: "/tmp/stub",
            platformFamily: "unix",
            platformOs: "macos",
          },
        };
      case "thread/unsubscribe":
        state.unsubscribed.add(p.threadId ?? p.thread_id);
        return { id, result: { status: "unsubscribed" } };
      default:
        return { id, result: { method } };
    }
  }
}

async function startStubTunnel(opts: {
  mock: MockWhamServer;
  logs?: string[];
  pingIntervalMs?: number;
}): Promise<{ tunnel: WhamTunnel; app: StubAgentApp; home: string; authManager: BridgeAuthManager }> {
  const { authManager, home } = await makeAuthManager();
  const app = new StubAgentApp();
  const tunnel = new WhamTunnel({
    authManager,
    app: app as unknown as AgentApp,
    baseUrl: `http://127.0.0.1:${opts.mock.port}`,
    installationDir: home,
    reconnectDelayMs: 0,
    pingIntervalMs: opts.pingIntervalMs ?? 10_000,
    refreshThresholdMs: 60_000,
    log: (line) => opts.logs?.push(line),
  });
  return { tunnel, app, home, authManager };
}

test("REST：enroll → refresh（账号 token + installation-id，token 轮换）→ pair → pair/status", async () => {
  const { server, port } = await startMock();
  try {
    const base = `http://127.0.0.1:${port}`;
    const enroll = await fetch(`${base}${REST_PATHS.enroll}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer acc-token",
        "chatgpt-account-id": "acc-1",
      },
      body: JSON.stringify({
        name: "probe-host",
        os: "macos",
        arch: "arm64",
        app_server_version: "0.156.1",
        installation_id: "inst-1",
      }),
    });
    assert.equal(enroll.status, 200);
    const enrolled = (await enroll.json()) as EnrollRemoteServerResponse;
    assert.ok(enrolled.server_id.startsWith("srv_"));
    assert.ok(enrolled.remote_control_token.startsWith("rct_"));

    // refresh 鉴权=账号 token + x-codex-installation-id（对齐 WhamClient.refresh）→ 新 token
    const refresh = await fetch(`${base}${REST_PATHS.refresh}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer acc-token",
        "chatgpt-account-id": "acc-1",
        "x-codex-installation-id": "inst-1",
      },
      body: JSON.stringify({
        server_id: enrolled.server_id,
        installation_id: "inst-1",
      }),
    });
    assert.equal(refresh.status, 200);
    const refreshed = (await refresh.json()) as EnrollRemoteServerResponse;
    assert.notEqual(refreshed.remote_control_token, enrolled.remote_control_token);
    assert.equal(refreshed.server_id, enrolled.server_id);

    // remote_control_token 不再能 refresh（账号 token 语义）→ 401
    const remoteTokenRefresh = await fetch(`${base}${REST_PATHS.refresh}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${enrolled.remote_control_token}`,
        "x-codex-installation-id": "inst-1",
      },
      body: JSON.stringify({ server_id: enrolled.server_id, installation_id: "inst-1" }),
    });
    assert.equal(remoteTokenRefresh.status, 401);

    // 错误账号 token → 401
    const bad = await fetch(`${base}${REST_PATHS.refresh}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer nope",
        "x-codex-installation-id": "inst-1",
      },
      body: JSON.stringify({ server_id: enrolled.server_id, installation_id: "inst-1" }),
    });
    assert.equal(bad.status, 401);

    // pair（用新 remote_control_token）
    const pair = await fetch(`${base}${REST_PATHS.pair}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${refreshed.remote_control_token}`,
      },
      body: JSON.stringify({ manual_code: true }),
    });
    assert.equal(pair.status, 200);
    const paired = (await pair.json()) as { manual_pairing_code: string | null; claimed?: boolean };
    assert.equal(paired.manual_pairing_code, "123-456");

    // pair/status → claimed
    const status = await fetch(`${base}${REST_PATHS.pairStatus}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code: "pc_1" }),
    });
    assert.deepEqual(await status.json(), { claimed: true });

    assert.ok(server["enrollment"], "enrollment 已保存");
  } finally {
    await server.stop();
  }
});

test("AC1 listClients：分页参数/响应解码/账号鉴权头（非 remote-token bearer）", async () => {
  const { server, port } = await startMock();
  const { authManager } = await makeAuthManager();
  try {
    const client = new WhamClient({ authManager, baseUrl: `http://127.0.0.1:${port}` });
    const enrolled = await client.enroll({ name: "ac1", appServerVersion: "t" });

    server.addClient({ client_id: "c-old", last_seen_at: new Date(Date.now() - 3000).toISOString() });
    server.addClient({ client_id: "c-mid", last_seen_at: new Date(Date.now() - 2000).toISOString() });
    const newest = server.addClient({
      client_id: "c-new",
      display_name: "My iPhone",
      last_seen_at: new Date(Date.now() - 1000).toISOString(),
    });

    const page1 = await client.listClients({
      environmentId: enrolled.environment_id,
      limit: 2,
      order: "desc",
    });
    assert.deepEqual(
      page1.items.map((i) => i.client_id),
      ["c-new", "c-mid"],
    );
    assert.ok(page1.cursor, "第一页应有 cursor");
    assert.equal(page1.items[0]!.display_name, newest.display_name);

    const page2 = await client.listClients({
      environmentId: enrolled.environment_id,
      limit: 2,
      order: "desc",
      cursor: page1.cursor!,
    });
    assert.deepEqual(
      page2.items.map((i) => i.client_id),
      ["c-old"],
    );
    assert.equal(page2.cursor, null, "末页 cursor 为 null");

    // order=asc 反向
    const asc = await client.listClients({ environmentId: enrolled.environment_id, limit: 1, order: "asc" });
    assert.equal(asc.items[0]!.client_id, "c-old");

    // 分页参数原样到达 mock
    const lastGet = [...server.clientsRequests].reverse().find((r) => r.method === "GET")!;
    assert.equal(lastGet.query.limit, "1");
    assert.equal(lastGet.query.order, "asc");
    assert.equal(lastGet.path, `${REST_PATHS.environments}/${enrolled.environment_id}/clients`);

    // 账号鉴权头：Bearer 账号 token（≠ remote_control_token）+ chatgpt-account-id；无 installation 头
    const descReq = server.clientsRequests.find((r) => r.query.order === "desc")!;
    assert.ok(descReq.headers.authorization);
    assert.notEqual(
      descReq.headers.authorization,
      `Bearer ${enrolled.remote_control_token}`,
      "clients 不得用 remote_control_token",
    );
    assert.equal(descReq.headers["chatgpt-account-id"], "acc-1");
    assert.equal(descReq.headers["x-codex-installation-id"], undefined);

    // limit 越界 = 本地 InvalidInput
    await assert.rejects(
      () => client.listClients({ environmentId: enrolled.environment_id, limit: 101 }),
      /between 1 and 100/,
    );
  } finally {
    await server.stop();
  }
});

test("AC2 revokeClient：DELETE 路径/空响应体容忍/错误映射", async () => {
  const { server, port } = await startMock();
  const { authManager } = await makeAuthManager();
  try {
    const client = new WhamClient({ authManager, baseUrl: `http://127.0.0.1:${port}` });
    const enrolled = await client.enroll({ name: "ac2", appServerVersion: "t" });
    server.addClient({ client_id: "c-revoke" });

    // 204 空 body：必须容忍（UTF-8 解析空串会失败，本路径不得解码 body）
    await client.revokeClient({ environmentId: enrolled.environment_id, clientId: "c-revoke" });
    assert.ok(server.revokedClients.has("c-revoke"));
    assert.equal(server.pairedClients.length, 0);

    const del = server.clientsRequests.at(-1)!;
    assert.equal(del.method, "DELETE");
    assert.equal(del.path, environmentClientPath(enrolled.environment_id, "c-revoke"));
    assert.notEqual(del.headers.authorization, `Bearer ${enrolled.remote_control_token}`);
    assert.equal(del.headers["chatgpt-account-id"], "acc-1");

    // 不存在 → WhamError(404)
    await assert.rejects(
      () => client.revokeClient({ environmentId: enrolled.environment_id, clientId: "missing" }),
      (err: unknown) => err instanceof WhamError && err.status === 404,
    );
  } finally {
    await server.stop();
  }
});

test("AC3 installationId(dir)：空目录生成并稳定复用；默认目录行为不变", async () => {
  const { authManager, home } = await makeAuthManager();
  const client = new WhamClient({ authManager });
  const dir = await tempDir("inst");
  const id1 = await client.installationId(dir);
  const id2 = await client.installationId(dir);
  assert.equal(id1, id2, "同目录稳定复用");
  assert.match(id1, /^[0-9a-f-]{36}$/);
  assert.equal((await readFile(join(dir, "installation_id"), "utf8")).trim(), id1);

  // 默认 = authManager.codexHome（现有调用方行为不变）
  const defaultId = await client.installationId();
  assert.equal((await readFile(join(home, "installation_id"), "utf8")).trim(), defaultId);
  assert.notEqual(defaultId, id1);

  // 构造参数 installationDir
  const dir2 = await tempDir("inst2");
  const client2 = new WhamClient({ authManager, installationDir: dir2 });
  const id3 = await client2.installationId();
  assert.equal((await readFile(join(dir2, "installation_id"), "utf8")).trim(), id3);
  assert.notEqual(id3, defaultId);
});

test("AC4 WhamTunnel：initialize→响应→fanOut（跳过 optOut/unsubscribed）→pong", async () => {
  const { server } = await startMock();
  const { tunnel, app } = await startStubTunnel({ mock: server });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);

    const init = (await server.rpc("initialize", {
      clientInfo: { name: "stub", title: "Stub", version: "1" },
      capabilities: { optOutNotificationMethods: ["skip/me"] },
    })) as { result?: { userAgent?: string } };
    assert.equal(init.result?.userAgent, "stub/1.0");

    // fanOut：正常通知到达
    app.emit("event", { method: "notify/keep", params: { x: 1 } } satisfies AgentNotification);
    // optOut 方法被跳过
    app.emit("event", { method: "skip/me", params: {} } satisfies AgentNotification);
    await waitFor(() => server.receivedNotifications.some((n) => n.method === "notify/keep"), 5000);
    assert.ok(!server.receivedNotifications.some((n) => n.method === "skip/me"), "optOut 方法应跳过");

    // unsubscribed 线程被跳过
    await server.rpc("thread/unsubscribe", { threadId: "th-1" });
    app.emit("event", { method: "thread/event", params: {}, threadId: "th-1" } satisfies AgentNotification);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      !server.receivedNotifications.some((n) => n.method === "thread/event"),
      "unsubscribed 线程事件应跳过",
    );

    // pong：ping 帧 → pong（status 来自 app.pongStatus）
    server.sendPing();
    await waitFor(() => server.receivedPongs.length > 0, 5000);
    assert.equal(server.receivedPongs[0]!.status, "unknown");
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("AC6 异步隔离：handleRequest reject → 无 unhandledRejection、tunnel 存活、另一 stream 仍获响应", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const { server } = await startMock();
  const { tunnel, app } = await startStubTunnel({ mock: server });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    app.failMethods.add("boom");

    const failed = (await server.rpc("boom", {}, 5000)) as { error?: { message?: string } };
    assert.ok(failed.error, "rejection 应尽力回 JSON-RPC error");
    assert.match(String(failed.error?.message), /agent error/);

    // 另一 stream 仍获响应（tunnel 未被拖死）
    const otherStream = randomUUID();
    const ok = (await server.rpc("echo", { v: 1 }, 5000, otherStream)) as {
      result?: { method?: string };
    };
    assert.equal(ok.result?.method, "echo");
    assert.equal(tunnel.connected, true);

    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(unhandled, [], "不得产生 unhandledRejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await tunnel.stop();
    await server.stop();
  }
});

test("AC7 临期续期（成功）：WSS 不断线、refresh-first、enroll 增量 0、身份不变", async () => {
  const logs: string[] = [];
  const { server } = await startMock({ tokenTtlMs: 150, refreshTokenTtlMs: 60_000 });
  const { tunnel } = await startStubTunnel({ mock: server, logs, pingIntervalMs: 30 });
  try {
    const enrollments: Array<{ server_id: string; environment_id: string; remote_control_token: string }> = [];
    tunnel.on("enrollment", (e) => enrollments.push(e as (typeof enrollments)[number]));
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);

    const serverId0 = tunnel.serverId;
    const envId0 = tunnel.enrollmentSnapshot!.environment_id;
    const enrollsBefore = server.enrollCount;

    await waitFor(() => server.refreshCount >= 1, 5000);
    await waitFor(() => enrollments.length >= 2, 5000);

    assert.equal(server.enrollCount, enrollsBefore, "续期期间 enroll 调用增量必须为 0");
    assert.equal(tunnel.connected, true, "WSS 必须保持连接");
    assert.equal(tunnel.serverId, serverId0);
    assert.equal(tunnel.enrollmentSnapshot!.environment_id, envId0);

    // 订阅方收到 refresh 通知：server_id/environment_id 恒定，仅 token/expiry 变
    const refreshed = enrollments.at(-1)!;
    assert.equal(refreshed.server_id, serverId0);
    assert.equal(refreshed.environment_id, envId0);
    assert.notEqual(refreshed.remote_control_token, enrollments[0]!.remote_control_token);
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("AC7 临期续期（失败）：refresh 401 → enroll 兜底 + WARN", async () => {
  const logs: string[] = [];
  const { server } = await startMock({ refreshStatusCode: 401 });
  const { tunnel, home } = await startStubTunnel({ mock: server, logs });
  try {
    // 预置 enrollment 记录 → start 走 refresh-first，注入 401 触发兜底
    await writeFile(
      join(home, ENROLLMENT_FILENAME),
      JSON.stringify({
        server_id: "srv_persisted",
        environment_id: "env_persisted",
        remote_control_token: "rct_stale",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);

    assert.equal(server.refreshCount, 1, "start 应尝试 refresh");
    assert.equal(server.enrollCount, 1, "refresh 失败后应 enroll 兜底");
    assert.ok(
      tunnel.warnings.some((w) => w.includes("refresh 失败")),
      `应记录 WARN: ${JSON.stringify(tunnel.warnings)}`,
    );
    assert.ok(logs.some((l) => l.includes("WARN")), "日志应含 WARN");
    assert.ok(tunnel.serverId?.startsWith("srv_"), "兜底 enroll 后 tunnel 仍可用");
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("AC8 mock 幂等：同 (账号, installation_id) 两次 enroll 同 server_id/environment_id", async () => {
  const { server, port } = await startMock();
  const { authManager } = await makeAuthManager();
  try {
    const client = new WhamClient({ authManager, baseUrl: `http://127.0.0.1:${port}` });
    const first = await client.enroll({ name: "idem", appServerVersion: "t" });
    const second = await client.enroll({ name: "idem", appServerVersion: "t" });
    assert.equal(second.server_id, first.server_id);
    assert.equal(second.environment_id, first.environment_id);
    assert.equal(server.enrollCount, 2);
  } finally {
    await server.stop();
  }
});

test("WS：握手头记录、rpc 下发(client_message)、响应(server_message)匹配、ack 回执、分片重组、帧落盘", async () => {
  const { server, port, jsonlPath } = await startMock();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REST_PATHS.websocket}`, {
      headers: {
        [WS_HEADERS.serverId]: "srv_test",
        [WS_HEADERS.name]: Buffer.from("probe-host").toString("base64"),
        [WS_HEADERS.protocolVersion]: "3",
        [WS_HEADERS.installationId]: "inst-1",
      },
    });
    // 测试端扮演 codex：收到 ClientEnvelope，发出 ServerEnvelope
    const receivedClientFrames: ClientEnvelope[] = [];
    ws.on("message", (data) => {
      receivedClientFrames.push(JSON.parse(data.toString()) as ClientEnvelope);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // 模拟手机 rpc：mock 下发 client_message（JSON-RPC 请求）
    const rpcPromise = server.rpc("initialize", { client_info: { name: "t" } }, 5000);
    await waitFor(() => receivedClientFrames.some((f) => f.type === "client_message"));
    const req = receivedClientFrames.find((f) => f.type === "client_message")!;
    assert.ok(req.message && "method" in req.message);
    assert.equal(req.message.method, "initialize");
    assert.equal(req.client_id, server.mobileClientId);
    assert.ok(req.stream_id);

    // codex 方向回 server_message 响应（带 seq_id）
    const rpcId = (req.message as { id: number }).id;
    ws.send(
      JSON.stringify({
        type: "server_message",
        client_id: req.client_id,
        stream_id: req.stream_id!,
        seq_id: 1,
        message: { jsonrpc: "2.0", id: rpcId, result: { user_agent: "test" } },
      } satisfies ServerEnvelope),
    );
    const reply = await rpcPromise;
    assert.deepEqual("result" in reply ? reply.result : null, { user_agent: "test" });

    // mock 应回 ack(seq_id=1)
    await waitFor(() => receivedClientFrames.some((f) => f.type === "ack"));
    const ackFrame = receivedClientFrames.find((f) => f.type === "ack")!;
    assert.equal(ackFrame.seq_id, 1);

    // 分片：codex 发 server_message_chunk × 2，mock 重组后匹配响应
    const rpc2 = server.rpc("thread/list", {}, 5000);
    await waitFor(() => receivedClientFrames.some((f) => f.type === "client_message" && f.message && "method" in f.message && f.message.method === "thread/list"));
    const req2 = receivedClientFrames.find(
      (f) => f.type === "client_message" && f.message && "method" in f.message && f.message.method === "thread/list",
    )!;
    const rpc2Id = (req2.message as { id: number }).id;
    const full = JSON.stringify({ jsonrpc: "2.0", id: rpc2Id, result: { threads: [] } });
    const b64 = Buffer.from(full, "utf8").toString("base64");
    const mid = Math.ceil(b64.length / 2);
    for (const [seg, chunk] of [
      [0, b64.slice(0, mid)],
      [1, b64.slice(mid)],
    ] as const) {
      ws.send(
        JSON.stringify({
          type: "server_message_chunk",
          client_id: req2.client_id,
          stream_id: req2.stream_id!,
          seq_id: 2 + seg,
          segment_id: seg,
          segment_count: 2,
          message_size_bytes: full.length,
          message_chunk_base64: chunk,
        } satisfies ServerEnvelope),
      );
    }
    const reply2 = await rpc2;
    assert.deepEqual("result" in reply2 ? reply2.result : null, { threads: [] });

    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const lines = (await readFile(jsonlPath, "utf8")).trim().split("\n");
    const dirs = new Set(lines.map((l) => (JSON.parse(l) as { dir: string }).dir));
    assert.ok(dirs.has("codex→mock"));
    assert.ok(dirs.has("mock→codex"));
  } finally {
    await server.stop();
  }
});

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor 超时"));
      }
    }, 20);
  });
}
