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
import { SimApp } from "../src/agents/sim/appServer.ts";
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

async function makeAuthManager(): Promise<{
  authManager: BridgeAuthManager;
  home: string;
  auth: AuthDotJson;
}> {
  const home = await tempDir("auth");
  const auth = fakeAuth();
  await writeAuthStore(home, auth);
  return { authManager: new BridgeAuthManager({ codexHome: home }), home, auth };
}

/** 直连 mock 的 enroll（测试注入特定账号 token / installation_id）。 */
async function rawEnroll(
  base: string,
  accountToken: string,
  installationId: string,
  accountId = "acc-1",
): Promise<EnrollRemoteServerResponse> {
  const res = await fetch(`${base}${REST_PATHS.enroll}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${accountToken}`,
      "chatgpt-account-id": accountId,
    },
    body: JSON.stringify({
      name: "raw",
      os: "macos",
      arch: "arm64",
      app_server_version: "t",
      installation_id: installationId,
    }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as EnrollRemoteServerResponse;
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
  reconnectDelayMs?: number;
  streamIdleTimeoutMs?: number;
  backpressureIdleTimeoutMs?: number;
  onFault?: (err: unknown, context: string) => unknown;
}): Promise<{ tunnel: WhamTunnel; app: StubAgentApp; home: string; authManager: BridgeAuthManager }> {
  const { authManager, home } = await makeAuthManager();
  const app = new StubAgentApp();
  const tunnel = new WhamTunnel({
    authManager,
    app: app as unknown as AgentApp,
    baseUrl: `http://127.0.0.1:${opts.mock.port}`,
    installationDir: home,
    reconnectDelayMs: opts.reconnectDelayMs ?? 0,
    pingIntervalMs: opts.pingIntervalMs ?? 10_000,
    streamIdleTimeoutMs: opts.streamIdleTimeoutMs,
    backpressureIdleTimeoutMs: opts.backpressureIdleTimeoutMs,
    refreshThresholdMs: 60_000,
    log: (line) => opts.logs?.push(line),
    onFault: opts.onFault,
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

    server.addClient(enrolled.environment_id, {
      client_id: "c-old",
      last_seen_at: new Date(Date.now() - 3000).toISOString(),
    });
    server.addClient(enrolled.environment_id, {
      client_id: "c-mid",
      last_seen_at: new Date(Date.now() - 2000).toISOString(),
    });
    const newest = server.addClient(enrolled.environment_id, {
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
    server.addClient(enrolled.environment_id, { client_id: "c-revoke" });

    // 204 空 body：必须容忍（UTF-8 解析空串会失败，本路径不得解码 body）
    await client.revokeClient({ environmentId: enrolled.environment_id, clientId: "c-revoke" });
    assert.ok(server.revokedClients.has("c-revoke"));
    assert.equal(server.clientsFor(enrolled.environment_id).length, 0);

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

test("NIT2 故障回调 rejected Promise：不产生 unhandledRejection、tunnel 存活", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const handlerErrors: string[] = [];
  const { server } = await startMock();
  const { tunnel, app } = await startStubTunnel({
    mock: server,
    logs: handlerErrors,
    // 同步抛 + 返回 rejected Promise 两种回调形态
    onFault: (_err, context) =>
      context === "handleRequest(boomSync)"
        ? Promise.reject(new Error("onFault boom (async)"))
        : Promise.reject(new Error("onFault boom")),
  });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    app.failMethods.add("boomSync");
    const failed = (await server.rpc("boomSync", {}, 5000)) as { error?: { message?: string } };
    assert.match(String(failed.error?.message), /agent error/);
    // tunnel 仍存活
    const ok = (await server.rpc("echo", {}, 5000)) as { result?: { method?: string } };
    assert.equal(ok.result?.method, "echo");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(unhandled, [], "onFault rejection 不得成为 unhandledRejection");
    assert.ok(
      handlerErrors.some((l) => l.includes("onFault async")),
      `回调 rejection 应被记录: ${JSON.stringify(handlerErrors)}`,
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await tunnel.stop();
    await server.stop();
  }
});

test("MATERIAL safeEmit 捕获异步监听器：reject 不产生 unhandledRejection、后续监听器仍调用、tunnel 存活", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const logs: string[] = [];
  const { server } = await startMock();
  const { tunnel } = await startStubTunnel({ mock: server, logs });
  let secondCalls = 0;
  let listenerThis: unknown;
  // enrollment 在 start() 内发出：首个 async 监听器 reject，第二个仍必须被调用
  tunnel.on("enrollment", async () => {
    throw new Error("listener boom");
  });
  tunnel.on("enrollment", function (this: unknown) {
    listenerThis = this;
    secondCalls += 1;
  });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(secondCalls >= 1, "首个监听器失败不得阻断后续订阅者");
    assert.equal(listenerThis, tunnel, "监听器 this 应绑定到 tunnel（对齐 emit 语义）");
    assert.deepEqual(unhandled, [], "监听器 rejection 不得成为 unhandledRejection");
    assert.ok(
      logs.some((l) => l.includes("emit enrollment async")),
      `监听器 rejection 应被记录: ${JSON.stringify(logs)}`,
    );
    // tunnel 存活
    const ok = (await server.rpc("echo", {}, 5000)) as { result?: { method?: string } };
    assert.equal(ok.result?.method, "echo");
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

test("BLOCKER1 stop 收敛：在途续期结果被丢弃，stop 后无 enrollment 写入/事件", async () => {
  const { server, port } = await startMock({ refreshDelayMs: 300 });
  const { tunnel, home, authManager } = await startStubTunnel({ mock: server });
  // 先建立 mock 侧 enrollment，并预置本地记录（start 走 refresh-first 且刷新被延迟）
  const seedClient = new WhamClient({ authManager, baseUrl: `http://127.0.0.1:${port}` });
  const enrolled = await seedClient.enroll({ name: "blocker1", appServerVersion: "t" });
  const persisted = {
    server_id: enrolled.server_id,
    environment_id: enrolled.environment_id,
    remote_control_token: "rct_persisted_stale",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
  await writeFile(join(home, ENROLLMENT_FILENAME), JSON.stringify(persisted));
  const events: unknown[] = [];
  tunnel.on("enrollment", (e) => events.push(e));
  const startP = tunnel.start();
  await waitFor(() => server.refreshCount >= 1, 5000); // refresh 已在途（mock 延迟 300ms）
  await tunnel.stop();
  await startP.catch(() => undefined);

  assert.equal(events.length, 0, "stop 后不得再发 enrollment 事件");
  const onDisk = JSON.parse(await readFile(join(home, ENROLLMENT_FILENAME), "utf8"));
  assert.deepEqual(onDisk, persisted, "stop 后不得改写 enrollment.json");
  assert.equal(tunnel.enrollmentSnapshot, null, "在途续期结果不得落入内存身份");
  await server.stop();
});

test("BLOCKER2 refresh 身份漂移：environment_id 变化 → WARN + identityWarnings 可见", async () => {
  const { server, port } = await startMock({
    refreshResponsePatch: { environment_id: "env_drifted" },
  });
  const { tunnel, home, authManager } = await startStubTunnel({ mock: server });
  const seedClient = new WhamClient({ authManager, baseUrl: `http://127.0.0.1:${port}` });
  const enrolled = await seedClient.enroll({ name: "drift", appServerVersion: "t" });
  await writeFile(
    join(home, ENROLLMENT_FILENAME),
    JSON.stringify({
      server_id: enrolled.server_id,
      environment_id: enrolled.environment_id,
      remote_control_token: "rct_stale",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }),
  );
  await tunnel.start();
  await waitFor(() => tunnel.connected, 5000);

  assert.ok(
    tunnel.warnings.some((w) => w.includes("身份漂移")),
    `refresh 身份漂移应 WARN: ${JSON.stringify(tunnel.warnings)}`,
  );
  assert.ok(tunnel.identityWarnings.length >= 1, "identityWarnings 应记录（S04 status 出口）");
  assert.equal(
    tunnel.enrollmentSnapshot!.environment_id,
    "env_drifted",
    "漂移接受但可见（不得静默替换为不可见）",
  );
  assert.equal(tunnel.serverId, enrolled.server_id);
  await tunnel.stop();
  await server.stop();
});

test("NIT1 持续续期：跨多个 ping 周期 refresh 持续、enroll 恒 0", async () => {
  const { server } = await startMock({ tokenTtlMs: 60, refreshTokenTtlMs: 60 });
  const { tunnel } = await startStubTunnel({ mock: server, pingIntervalMs: 20 });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await waitFor(() => server.refreshCount >= 3, 8000);
    assert.equal(server.enrollCount, 1, "持续续期期间 enroll 恒为 1（仅首次）");
    assert.equal(tunnel.connected, true, "持续续期期间 WSS 不断线");
    assert.ok(server.refreshCount >= 3);
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

test("BLOCKER3 mock 账号幂等/token 语义：同账号换 token 同身份；历次 token 有效；未知/remote token 401", async () => {
  // mock 语义（写清）：账号身份 = chatgpt-account-id；refresh/clients 鉴权接受该账号
  // 历次 enroll 登记过的 access token（账号有效性集合），因此轮换后的新旧 token 都可 refresh。
  const { server, port } = await startMock();
  const base = `http://127.0.0.1:${port}`;
  try {
    const first = await rawEnroll(base, "account-token-1", "inst-x");
    const second = await rawEnroll(base, "account-token-2", "inst-x");
    assert.equal(second.server_id, first.server_id, "同账号换 token 仍同 server_id");
    assert.equal(second.environment_id, first.environment_id, "同账号换 token 仍同 environment_id");
    assert.equal(server.enrollCount, 2);

    const refresh = (auth: string) =>
      fetch(`${base}${REST_PATHS.refresh}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${auth}`,
          "chatgpt-account-id": "acc-1",
          "x-codex-installation-id": "inst-x",
        },
        body: JSON.stringify({ server_id: first.server_id, installation_id: "inst-x" }),
      });

    // 当前 token 与历次有效 token 都可 refresh
    assert.equal((await refresh("account-token-2")).status, 200);
    assert.equal((await refresh("account-token-1")).status, 200, "账号历次有效 token 仍可 refresh");
    // 未知 token / remote_control_token → 401
    assert.equal((await refresh("account-token-unknown")).status, 401);
    assert.equal((await refresh(first.remote_control_token)).status, 401);
  } finally {
    await server.stop();
  }
});

test("BLOCKER4 clients 环境隔离：按 env 归属查询/吊销，不跨 env 泄漏", async () => {
  const { server, port } = await startMock();
  const { authManager, auth } = await makeAuthManager();
  const base = `http://127.0.0.1:${port}`;
  try {
    // 同账号两个 installation → 两个 environment
    const accountToken = auth.tokens!.access_token;
    const envA = await rawEnroll(base, accountToken, "inst-a");
    const envB = await rawEnroll(base, accountToken, "inst-b");
    assert.notEqual(envA.environment_id, envB.environment_id);
    server.addClient(envA.environment_id, { client_id: "a-1" });
    server.addClient(envB.environment_id, { client_id: "b-1" });

    const client = new WhamClient({ authManager, baseUrl: base });
    const listA = await client.listClients({ environmentId: envA.environment_id });
    assert.deepEqual(
      listA.items.map((i) => i.client_id),
      ["a-1"],
      "envA 的 list 只应见 envA",
    );
    const listB = await client.listClients({ environmentId: envB.environment_id });
    assert.deepEqual(
      listB.items.map((i) => i.client_id),
      ["b-1"],
      "envB 的 list 只应见 envB",
    );

    // 用 envA 吊销 envB 的 client → 404（不属于该 env）
    await assert.rejects(
      () => client.revokeClient({ environmentId: envA.environment_id, clientId: "b-1" }),
      (err: unknown) => err instanceof WhamError && err.status === 404,
    );
    assert.deepEqual(
      server.clientsFor(envB.environment_id).map((c) => c.client_id),
      ["b-1"],
      "跨 env DELETE 失败不得影响 envB",
    );

    // 吊销 envA 的 client → 只影响 envA
    await client.revokeClient({ environmentId: envA.environment_id, clientId: "a-1" });
    assert.equal(server.clientsFor(envA.environment_id).length, 0);
    assert.deepEqual(
      server.clientsFor(envB.environment_id).map((c) => c.client_id),
      ["b-1"],
      "envB 不受 envA 吊销影响",
    );
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

test("二波3 tunnel.stop：app.close 抛错仍关闭 WS 且 stop() resolve（无旧连接泄漏）", async () => {
  const { server } = await startMock();
  const { authManager } = await makeAuthManager();
  const app = new StubAgentApp();
  app.close = () => {
    throw new Error("close boom");
  };
  const tunnel = new WhamTunnel({
    authManager,
    app: app as unknown as AgentApp,
    baseUrl: `http://127.0.0.1:${server.port}`,
    reconnectDelayMs: 0,
    log: () => {},
  });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    assert.ok(server["codexSocket"], "WSS 已建立");

    // app.close 抛错不得让 stop() reject / 跳过 ws.close()
    await tunnel.stop();
    await waitFor(() => server["codexSocket"] === null, 5000);
    assert.equal(tunnel.connected, false, "stop 后不得仍连接");
    assert.equal(server["codexSocket"], null, "mock 侧旧 WS 必须已关闭");
  } finally {
    await server.stop();
  }
});

// ------------------------------------------------ S02 出站可靠层（seq/ack/重连重放）

/** 去重升序 seq 列表。 */
function uniqueSortedSeqs(seqs: number[]): number[] {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

/** 断言 seq 去重后为连续区间（全序无空洞）。 */
function assertContiguousSeqs(seqs: number[], label: string): void {
  const uniq = uniqueSortedSeqs(seqs);
  assert.ok(uniq.length > 0, `${label}: 无 seq`);
  assert.deepEqual(
    uniq,
    uniq.map((_, index) => uniq[0]! + index),
    `${label}: seq 应全序无空洞，实际 ${JSON.stringify(uniq)}`,
  );
}

/** 重连完成：mock 侧出现新 codex socket 且 tunnel 自认已连接。 */
async function waitReconnect(server: MockWhamServer, tunnel: WhamTunnel): Promise<void> {
  await waitFor(() => server["codexSocket"] !== null && tunnel.connected, 5000);
}

test("T1 未 ack 重放：drop 重连后原 seq 原样重发（receivedSeqIds 出现两次）", async () => {
  const { server } = await startMock({ autoAck: false });
  const { tunnel, app } = await startStubTunnel({ mock: server, reconnectDelayMs: 25 });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } });

    app.emit("event", { method: "replay/me", params: { n: 1 } } satisfies AgentNotification);
    await waitFor(() => server.receivedSeqIds.length >= 2, 5000);
    const seq = server.receivedSeqIds.at(-1)!;
    assert.equal(tunnel.outboundBacklog().buffered, 2, "响应 + 通知均应留在未 ack 缓冲");

    server.dropCodexSocket();
    await waitReconnect(server, tunnel);

    await waitFor(() => server.receivedSeqIds.filter((s) => s === seq).length >= 2, 5000);
    assert.equal(
      server.receivedSeqIds.filter((s) => s === seq).length,
      2,
      "未 ack 的 seq 应原样重发一次（不重置 seq）",
    );
    assert.equal(
      server.receivedSeqIds.filter((s) => s === seq - 1).length,
      2,
      "重放应按 seq 顺序覆盖整段未 ack 缓冲",
    );
    assert.equal(tunnel.outboundBacklog().buffered, 2, "重放不得清空未 ack 缓冲");
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("T2 ack 后不重发：手动 ack 到 N，重连后 N 不再出现、后续事件 seq 连续 N+1", async () => {
  const { server } = await startMock({ autoAck: false });
  const { tunnel, app } = await startStubTunnel({ mock: server, reconnectDelayMs: 25 });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } });

    app.emit("event", { method: "n/1", params: {} } satisfies AgentNotification);
    await waitFor(() => server.dedupedNotifications.some((x) => x.method === "n/1"), 5000);
    const n = server.dedupedNotifications.find((x) => x.method === "n/1")!.seqId;

    server.ack(n); // 手动 ack 到 N（默认 mobile stream）
    await waitFor(() => tunnel.outboundBacklog().buffered === 0, 5000);

    server.dropCodexSocket();
    await waitReconnect(server, tunnel);

    app.emit("event", { method: "n/2", params: {} } satisfies AgentNotification);
    await waitFor(() => server.dedupedNotifications.some((x) => x.method === "n/2"), 5000);

    assert.equal(server.receivedSeqIds.filter((s) => s === n).length, 1, "已 ack 的 seq 不得重发");
    assert.deepEqual(
      server.dedupedNotifications.map((x) => x.seqId),
      [n, n + 1],
      "后续事件 seq 应从 N+1 连续推进（无空洞）",
    );
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("T3 断线 pending：等待段掉线，断线期间事件重连后按序补发且 seq 连续", async () => {
  const authHome = await tempDir("simhome");
  await writeAuthStore(authHome, fakeAuth());
  const authManager = new BridgeAuthManager({ codexHome: authHome });
  const mock = new MockWhamServer({ port: 0, autoScript: false, log: () => {} });
  await mock.start();
  const app = new SimApp({
    codexHome: authHome,
    stepDelayMs: 5,
    deltaIntervalMs: 5,
    deltaChars: 64,
    commandWaitMs: 300,
  });
  const tunnel = new WhamTunnel({
    authManager,
    app,
    baseUrl: `http://127.0.0.1:${mock.port}`,
    installationDir: authHome,
    reconnectDelayMs: 600,
    pingIntervalMs: 60_000,
    refreshThresholdMs: 60_000,
    log: () => {},
  });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await mock.rpc("thread/start", { cwd: "/tmp-sim" })) as {
      result: { thread: { id: string } };
    };
    await mock.rpc("turn/start", {
      threadId: started.result.thread.id,
      input: [{ type: "text", text: "TEST QUEUE" }],
    });

    // 断在第一次 wait 命令期间（turn 仍在进行）
    await waitFor(
      () =>
        mock.dedupedNotifications.some(
          (x) =>
            x.method === "item/started" &&
            (x.params as { item?: { type?: string } }).item?.type === "commandExecution",
        ),
      5000,
      "未进入等待段",
    );
    mock.dropCodexSocket();
    await waitFor(() => tunnel.connected === false, 5000);
    // 断线期间 sim 继续产出 → 进入 pending（不丢、暂不分配 seq）
    await waitFor(() => tunnel.outboundBacklog().pending > 0, 3000, "断线期间未积压 pending");

    await waitReconnect(mock, tunnel);
    await waitFor(
      () =>
        mock.dedupedNotifications.some(
          (x) =>
            x.method === "turn/completed" &&
            (x.params as { turn?: { status?: string } }).turn?.status === "completed",
        ),
      15_000,
      "重连后 turn 未完成",
    );

    const seqs = mock.dedupedNotifications.map((x) => x.seqId);
    assert.equal(new Set(seqs).size, seqs.length, "去重后每条通知恰好一次");
    assertContiguousSeqs(mock.receivedSeqIds, "T3 receivedSeqIds");
    assert.equal(tunnel.outboundBacklog().pending, 0, "重连后 pending 应排空");
  } finally {
    await tunnel.stop();
    await mock.stop();
  }
});

test("T4 去重判据：重放 + pending + 新事件交错，dedupedNotifications 每条一次、seq 全序无空洞", async () => {
  const { server } = await startMock({ autoAck: false });
  const { tunnel, app } = await startStubTunnel({ mock: server, reconnectDelayMs: 200 });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } });

    app.emit("event", { method: "t4/a", params: {} } satisfies AgentNotification);
    app.emit("event", { method: "t4/b", params: {} } satisfies AgentNotification);
    await waitFor(() => server.dedupedNotifications.length >= 2, 5000);

    server.dropCodexSocket();
    await waitFor(() => tunnel.connected === false, 5000);
    app.emit("event", { method: "t4/c", params: {} } satisfies AgentNotification);
    app.emit("event", { method: "t4/d", params: {} } satisfies AgentNotification);
    await waitFor(() => tunnel.outboundBacklog().pending === 2, 3000);

    await waitReconnect(server, tunnel);
    // 重连后再发新事件：与重放缓冲、pending 补发交错
    app.emit("event", { method: "t4/e", params: {} } satisfies AgentNotification);

    await waitFor(() => server.dedupedNotifications.length >= 5, 5000, "t4/a..e 未全部到达");
    assert.deepEqual(
      server.dedupedNotifications.map((x) => x.method),
      ["t4/a", "t4/b", "t4/c", "t4/d", "t4/e"],
      "通知应按序补发（重放不改变顺序、不重复）",
    );
    const seqs = server.dedupedNotifications.map((x) => x.seqId);
    assert.equal(new Set(seqs).size, seqs.length, "每条通知 seq 唯一（每条恰好一次）");
    assertContiguousSeqs(server.receivedSeqIds, "T4 receivedSeqIds");
    assert.ok(
      new Set(server.receivedSeqIds).size < server.receivedSeqIds.length,
      "重放应产生重复帧（原始序）但去重后无重复",
    );
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("T5 client_closed：清流状态（缓冲清零、后续通知不再分发）", async () => {
  const { server } = await startMock({ autoAck: false });
  const { tunnel, app } = await startStubTunnel({ mock: server });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } });
    app.emit("event", { method: "t5/before", params: {} } satisfies AgentNotification);
    await waitFor(() => server.dedupedNotifications.some((x) => x.method === "t5/before"), 5000);
    assert.ok(tunnel.outboundBacklog().buffered >= 2, "关流前缓冲应有未 ack 帧");

    server.sendClientEnvelope({
      type: "client_closed",
      client_id: server.mobileClientId,
      stream_id: server.mobileStreamId,
    });
    await waitFor(() => tunnel.outboundBacklog().buffered === 0, 5000);

    const before = server.receivedSeqIds.length;
    app.emit("event", { method: "t5/after", params: {} } satisfies AgentNotification);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(server.receivedSeqIds.length, before, "关流后不得再分发通知");
    assert.ok(!server.dedupedNotifications.some((x) => x.method === "t5/after"));
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("T6 cursor 头：手机 envelope 带 cursor 后重连握手携带 x-codex-subscribe-cursor", async () => {
  const { server } = await startMock();
  const { tunnel } = await startStubTunnel({ mock: server, reconnectDelayMs: 25 });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await waitFor(() => server["codexSocket"] !== null, 5000);
    assert.equal(
      server["codexHeaders"][WS_HEADERS.subscribeCursor],
      undefined,
      "无 cursor 时不得发送订阅游标头",
    );

    const cursor = "cursor-abc-1";
    server.sendClientEnvelope(
      { type: "ping", client_id: server.mobileClientId, stream_id: server.mobileStreamId },
      cursor,
    );
    // pong 回来 = 该入站信封已被处理（cursor 已记录，last-writer-wins）
    await waitFor(() => server.receivedPongs.length > 0, 5000);

    server.dropCodexSocket();
    await waitReconnect(server, tunnel);
    await waitFor(
      () => server["codexHeaders"][WS_HEADERS.subscribeCursor] === cursor,
      5000,
      "重连握手应带最近 cursor",
    );
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("T7 容量闭环：128 缓冲满 + pending 合并/丢最旧 + 已发缓冲不丢、seq 无空洞", async () => {
  const { server } = await startMock({ autoAck: false });
  const { tunnel, app } = await startStubTunnel({ mock: server });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } }); // seq 1 入缓冲

    // 灌满全局未 ack 缓冲（128）：1 个响应 + 127 条通知，其余进 pending
    for (let i = 0; i < 200; i += 1) {
      app.emit("event", { method: `fill/${i}`, params: {} } satisfies AgentNotification);
    }
    await waitFor(() => server.receivedSeqIds.length >= 128, 5000);
    assert.equal(tunnel.outboundBacklog().buffered, 128, "缓冲应恰好灌满 128");
    assert.equal(server.receivedSeqIds.length, 128, "缓冲满后不得再发送新帧（背压）");
    assert.equal(tunnel.outboundBacklog().pending, 73, "溢出部分应留在 pending");

    // 相邻同 itemId delta 合并：pending 不超上限、内容不丢
    for (let i = 0; i < 400; i += 1) {
      app.emit("event", {
        method: "item/agentMessage/delta",
        params: { threadId: "th-1", turnId: "tu-1", itemId: "it-1", delta: `d${i}` },
        threadId: "th-1",
      } satisfies AgentNotification);
    }
    assert.ok(tunnel.outboundBacklog().merged > 0, "相邻同 itemId delta 应被合并");
    assert.ok(tunnel.outboundBacklog().pending <= 256, "pending 不得超过上限");

    // 不可合并事件持续涌入 → 丢最旧 pending + WARN
    for (let i = 0; i < 400; i += 1) {
      app.emit("event", { method: `uniq/${i}`, params: {} } satisfies AgentNotification);
    }
    const backlog = tunnel.outboundBacklog();
    assert.ok(backlog.dropped > 0, "无法合并时应丢最旧 pending");
    assert.ok(backlog.pending <= 256, "pending 始终有界");
    assert.equal(backlog.buffered, 128, "已发送未 ack 缓冲任何路径都不得丢弃");
    assert.ok(
      tunnel.warnings.some((w) => w.includes("pending 溢出")),
      `应记录 WARN: ${JSON.stringify(tunnel.warnings.slice(-2))}`,
    );
    assert.equal(server.receivedSeqIds.length, 128, "丢弃/合并不得产生新的已发送帧");
    assertContiguousSeqs(server.receivedSeqIds, "T7 receivedSeqIds");
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("T8 stop：迟到出站帧丢弃不抛错、无帧发送、缓冲已清", async () => {
  const { server } = await startMock();
  const { tunnel, app } = await startStubTunnel({ mock: server });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } });
    app.emit("event", { method: "t8/before", params: {} } satisfies AgentNotification);
    await waitFor(() => server.dedupedNotifications.some((x) => x.method === "t8/before"), 5000);

    await tunnel.stop();
    assert.deepEqual(tunnel.outboundBacklog(), { buffered: 0, pending: 0, merged: 0, dropped: 0 });

    const sentBefore = server.receivedSeqIds.length;
    assert.doesNotThrow(() =>
      tunnel["sendEnvelope"]("late-client", "late-stream", {
        type: "server_message",
        message: { method: "late/event", params: {} },
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(server.receivedSeqIds.length, sentBefore, "stop 后不得再发送任何帧");
    assert.deepEqual(tunnel.outboundBacklog(), { buffered: 0, pending: 0, merged: 0, dropped: 0 });
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("B1 跨流 pending 公平排空：全局满时流 B 积压，ack 流 A 后流 B pending 仍被发出", async () => {
  const { server } = await startMock({ autoAck: false });
  const { tunnel, app } = await startStubTunnel({ mock: server });
  const streamA = server.mobileStreamId;
  const streamB = randomUUID();
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } }, 5000, streamA); // 流 A seq 1

    // 仅流 A 存在时灌满全局未 ack 缓冲（1 响应 + 127 通知 = 128），无 pending
    for (let i = 0; i < 127; i += 1) {
      app.emit("event", { method: `b1/fill/${i}`, params: {} } satisfies AgentNotification);
    }
    await waitFor(() => tunnel.outboundBacklog().buffered === 128, 5000);
    assert.equal(tunnel.outboundBacklog().pending, 0, "灌满阶段不应有 pending");

    // 背压后创建流 B：其响应无法分配 seq → 进入流 B pending（此时流 A 无 pending）
    server.sendClientEnvelope({
      type: "client_message",
      client_id: server.mobileClientId,
      stream_id: streamB,
      message: { jsonrpc: "2.0", id: 9001, method: "echoB", params: {} },
    });
    await waitFor(() => tunnel.outboundBacklog().pending === 1, 3000, "流 B 应进入 pending");
    assert.equal(server.receivedSeqIds.length, 128, "流 B 未 ack 前不得发出新帧（背压）");

    // ack 流 A 到其最大 seq（128）→ 释放全局容量。B1 缺陷：只排空流 A（无 pending），
    // 流 B 的 pending 因无人认领空位而永久滞留。
    server.ack(128, streamA);
    await waitFor(() => tunnel.outboundBacklog().pending === 0, 3000, "跨流排空失败：流 B pending 滞留");
    await waitFor(() => server.receivedSeqIds.length > 128, 3000, "流 B 的 pending 应被发出");
    assert.ok(tunnel.outboundBacklog().buffered <= 128, "不得越过全局 128 上限");
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("B1b 跨流轮转公平：A、B 均有 pending 且全局满，逐帧 ack A 时 B 在有限次释放内被服务", async () => {
  const { server } = await startMock({ autoAck: false });
  const { tunnel, app } = await startStubTunnel({ mock: server });
  const streamA = server.mobileStreamId;
  const streamB = randomUUID();
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } }, 5000, streamA); // 流 A seq 1

    // 仅流 A 存在时灌满全局未 ack 缓冲（1 响应 + 127 通知 = 128）
    for (let i = 0; i < 127; i += 1) {
      app.emit("event", { method: `b1b/fill/${i}`, params: {} } satisfies AgentNotification);
    }
    await waitFor(() => tunnel.outboundBacklog().buffered === 128, 5000);

    // 缓冲满后再往流 A 灌 30 条 → 全进流 A pending（远多于后续要发的 ack 数：固定序下
    // 旧实现每次都让 A 先占唯一空位，B 须等 A 清空才可能发出）
    for (let i = 0; i < 30; i += 1) {
      app.emit("event", { method: `b1b/a-pending/${i}`, params: {} } satisfies AgentNotification);
    }
    // 背压下新建流 B：其响应进入流 B pending（此时 A、B 均有 pending，全局满）
    const bId = 4242;
    server.sendClientEnvelope({
      type: "client_message",
      client_id: server.mobileClientId,
      stream_id: streamB,
      message: { jsonrpc: "2.0", id: bId, method: "echoB", params: {} },
    });
    await waitFor(
      () => tunnel.outboundBacklog().pending === 31,
      3000,
      "A(30)+B(1) 应同时滞留 pending",
    );
    assert.equal(server.receivedSeqIds.length, 128, "背压期间不得发出新帧");

    const bEmitted = () =>
      server.receivedEnvelopeLog.some((e) => e.kind === "response" && e.id === bId);
    assert.equal(bEmitted(), false, "流 B 响应不得在释放容量前发出");

    // 反复逐帧 ack 流 A：每次只释放 1 个空位。固定序 + 单空位释放 = 饥饿（B1 反例）：
    // 旧实现每次都让 A 先占空位，B 要等 A 全部 30 条 pending 清空（≥31 次 ack）才可能发出。
    const baseSeqCount = server.receivedSeqIds.length;
    let servedAtAck = 0;
    for (let k = 1; k <= 6; k += 1) {
      server.ack(k, streamA);
      await waitFor(
        () => server.receivedSeqIds.length >= baseSeqCount + k,
        3000,
        `ack#${k} 后应释放并补发 1 帧`,
      );
      if (bEmitted()) {
        servedAtAck = k;
        break;
      }
    }
    assert.ok(servedAtAck > 0, "流 B pending 在 6 次单帧 ack 内仍未被服务（跨流饥饿）");
    assert.ok(servedAtAck <= 3, `流 B 应在 ≤3 次单帧 ack 内被轮转服务，实际第 ${servedAtAck} 次`);
    assert.ok(tunnel.outboundBacklog().buffered <= 128, "不得越过全局 128 上限");
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("B2 pong 入缓冲重放：通知+pong 交错断线重连后重放含 pong 且 seq 连续无空洞", async () => {
  const { server } = await startMock({ autoAck: false });
  const { tunnel, app } = await startStubTunnel({ mock: server, reconnectDelayMs: 25 });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } }); // 默认流 seq 1

    app.emit("event", { method: "b2/n1", params: {} } satisfies AgentNotification);
    await waitFor(() => server.receivedSeqIds.includes(2), 5000, "通知 n1 未发出（seq 2）");

    server.sendPing(); // pong 与 server_message 共享 per-stream seq → seq 3
    await waitFor(() => server.receivedPongs.length >= 1, 5000, "pong 未发出");
    assert.equal(server.receivedPongs[0]!.seq_id, 3, "pong 应分配 per-stream seq");

    app.emit("event", { method: "b2/n2", params: {} } satisfies AgentNotification);
    await waitFor(() => server.receivedSeqIds.includes(4), 5000, "通知 n2 未发出（seq 4）");
    assert.equal(tunnel.outboundBacklog().buffered, 4, "响应 + pong + 两通知均入未 ack 缓冲");

    const seqIdsBefore = server.receivedSeqIds.length;
    const pongsBefore = server.receivedPongs.length;

    server.dropCodexSocket();
    await waitReconnect(server, tunnel);

    // 重放：pong 必须与 server_message 一起按原 seq 重发。B2 缺陷：pong 不入缓冲 →
    // 重连只重放 server_message（1、2、4），seq 3 空洞。
    await waitFor(() => server.receivedPongs.length > pongsBefore, 5000, "重连未重放 pong");
    await waitFor(() => server.receivedSeqIds.length > seqIdsBefore, 5000, "重连未重放 server_message");
    const replayedSeqs = uniqueSortedSeqs([
      ...server.receivedSeqIds.slice(seqIdsBefore),
      ...server.receivedPongs.slice(pongsBefore).map((p) => p.seq_id ?? -1),
    ]);
    assertContiguousSeqs(replayedSeqs, "B2 重放序列（含 pong）");
    assert.deepEqual(replayedSeqs, [1, 2, 3, 4], "重放应覆盖整段未 ack 缓冲（含 pong），seq 全序无空洞");
    assert.equal(tunnel.outboundBacklog().buffered, 4, "重放不得清空未 ack 缓冲");
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("B3 mock autoAck 对 pong 回 ack：pong 占 per-stream seq 且被确认，缓冲不积压", async () => {
  const { server } = await startMock(); // autoAck 默认 true
  const { tunnel } = await startStubTunnel({ mock: server });
  const streamA = server.mobileStreamId;
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } }, 5000, streamA); // seq 1
    await waitFor(() => tunnel.outboundBacklog().buffered === 0, 3000, "响应应被 autoAck 清空");

    server.sendPing(streamA); // pong 占 per-stream seq 2
    await waitFor(() => server.receivedPongs.length >= 1, 5000, "pong 未发出");
    assert.equal(server.receivedPongs[0]!.seq_id, 2, "pong 应分配 per-stream seq");
    // autoAck 必须对 pong 回 ack（携带该帧 seq_id/stream_id），否则 pong 永久留在 128 缓冲
    // 造成假背压（真实手机/后端会对所有信封回 ack）。修复前此处 buffered 恒为 1。
    await waitFor(
      () => tunnel.outboundBacklog().buffered === 0,
      3000,
      "pong 未被 ack：未 ack 缓冲积压（假背压）",
    );
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("B4 关 autoAck 手动 ack pong：未 ack 缓冲下降且后续帧可发出", async () => {
  const { server } = await startMock({ autoAck: false });
  const { tunnel, app } = await startStubTunnel({ mock: server });
  const streamA = server.mobileStreamId;
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "t" } }, 5000, streamA); // seq 1
    server.sendPing(streamA); // pong seq 2
    await waitFor(() => server.receivedPongs.length >= 1, 5000, "pong 未发出");
    assert.equal(tunnel.outboundBacklog().buffered, 2, "响应 + pong 均入未 ack 缓冲");

    server.ack(2, streamA); // 手动 ack pong（seq_id/stream_id 取自该帧）：累计确认至 seq 2
    await waitFor(
      () => tunnel.outboundBacklog().buffered === 0,
      3000,
      "ack pong 后缓冲应下降（pong 已确认）",
    );

    app.emit("event", { method: "b4/after", params: {} } satisfies AgentNotification);
    await waitFor(() => server.receivedSeqIds.includes(3), 5000, "后续帧应以 seq 3 发出");
    assert.equal(tunnel.outboundBacklog().buffered, 1, "后续通知入未 ack 缓冲");
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("T9 僵尸流副本不得饿死活跃流：背压加速回收后活流通知完整且 seq 连续（真机 queue 截断根因）", async () => {
  const { server } = await startMock({ autoAck: false });
  const zombieStream = randomUUID();
  const logs: string[] = [];
  const { tunnel, app } = await startStubTunnel({
    mock: server,
    logs,
    pingIntervalMs: 20, // sweep 周期
    streamIdleTimeoutMs: 10_000, // 不走慢档
    backpressureIdleTimeoutMs: 60, // 静默 60ms 即加速回收
  });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    // 两条已注册流：活流持续 ack；僵尸流发完 initialize 后静默且永不 ack
    await server.rpc("initialize", { clientInfo: { name: "live" } });
    await server.rpc("initialize", { clientInfo: { name: "zombie" } }, undefined, zombieStream);
    const live = server.mobileStreamId;
    const ackLive = () => {
      for (const e of server.dedupedByStream.get(live) ?? []) server.ack(e.seqId, live);
    };

    // > 128 条通知：僵尸流副本必然把全局未 ack 缓冲打满（活流被背压）
    const TOTAL = 200;
    for (let i = 0; i < TOTAL; i += 1) {
      app.emit("event", { method: `flood/${i}`, params: { n: i } } satisfies AgentNotification);
    }
    await waitFor(() => (server.dedupedByStream.get(live)?.length ?? 0) > 0, 5000);
    // 模拟真机活流持续 ack（否则活流自身的未确认帧也会占满容量）
    const ackTimer = setInterval(ackLive, 30);
    try {
      // sweep 应在 backpressureIdleTimeoutMs + sweep 周期内回收僵尸流并立即排空活流 pending
      await waitFor(
        () => (server.dedupedByStream.get(live)?.length ?? 0) >= TOTAL,
        8000,
        "活流未收齐全部通知（被僵尸流饿死）",
      );
    } finally {
      clearInterval(ackTimer);
    }
    ackLive();
    const liveEntries = server.dedupedByStream.get(live)!;
    assert.equal(liveEntries.length, TOTAL, "活流应恰好收到每条通知一次");
    for (let i = 0; i < liveEntries.length; i += 1) {
      assert.equal(liveEntries[i].method, `flood/${i}`, `通知应按序到达（第 ${i} 条）`);
    }
    const seqs = liveEntries.map((e) => e.seqId);
    assertContiguousSeqs(seqs, "T9 活流通知 seq");
    assert.ok(logs.some((l) => l.includes("流回收")), "僵尸流回收应留日志");
    // 僵尸流被回收后不再接收后续通知副本
    const zombieCount = server.dedupedByStream.get(zombieStream)?.length ?? 0;
    app.emit("event", { method: "after/reap", params: {} } satisfies AgentNotification);
    await waitFor(() => (server.dedupedByStream.get(live)?.some((e) => e.method === "after/reap") ?? false), 5000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      server.dedupedByStream.get(zombieStream)?.length ?? 0,
      zombieCount,
      "回收后的僵尸流不得再收通知副本",
    );
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("T10 ping/ack-only 流不注册：pong 照回但不接收通知 fan-out 副本", async () => {
  const { server } = await startMock({ autoAck: false });
  const { tunnel, app } = await startStubTunnel({ mock: server });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    const probe = randomUUID();
    server.sendPing(probe); // 仅探活流：不发任何请求
    await waitFor(
      () => server.receivedPongs.some((p) => p.stream_id === probe),
      5000,
      "未注册流的 ping 仍应回 pong",
    );
    await server.rpc("initialize", { clientInfo: { name: "live" } });
    app.emit("event", { method: "pingonly/x", params: {} } satisfies AgentNotification);
    await waitFor(
      () => server.dedupedByStream.get(server.mobileStreamId)?.some((e) => e.method === "pingonly/x") ?? false,
      5000,
      "注册流应收到通知",
    );
    assert.equal(
      (server.dedupedByStream.get(probe) ?? []).filter((e) => e.method === "pingonly/x").length,
      0,
      "ping-only 流不得收到通知副本",
    );
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

test("T11 空闲回收：注册流静默超时后整流回收（容量归还 + forgetClient + 不再 fan-out）", async () => {
  const { server } = await startMock({ autoAck: false });
  const logs: string[] = [];
  const { tunnel, app } = await startStubTunnel({
    mock: server,
    logs,
    pingIntervalMs: 20,
    streamIdleTimeoutMs: 80, // 静默 80ms 即回收
    backpressureIdleTimeoutMs: 10_000,
  });
  try {
    await tunnel.start();
    await waitFor(() => tunnel.connected, 5000);
    await server.rpc("initialize", { clientInfo: { name: "live" } }); // 默认流注册并保持活跃
    // 已注册流的周期 ping 续命（对齐真机活跃流），确保空闲回收只命中静默流
    const keepAlive = setInterval(() => server.sendPing(), 20);
    const idleStream = randomUUID();
    await server.rpc("initialize", { clientInfo: { name: "idle" } }, undefined, idleStream);
    app.emit("event", { method: "idle/x", params: {} } satisfies AgentNotification);
    await waitFor(
      () => (server.dedupedByStream.get(idleStream)?.length ?? 0) > 0,
      5000,
      "回收前该流应收到通知",
    );
    assert.ok(tunnel.outboundBacklog().buffered >= 1, "未 ack 帧占用全局缓冲");

    // 静默（无 ack/ping/rpc）→ sweep 空闲回收（注意：活跃流的未 ack pong 仍占缓冲，
    // 全局 buffered 不会归零，故以回收日志为准）
    await waitFor(
      () => logs.some((l) => l.includes("流回收") && l.includes(idleStream)),
      5000,
      "静默流未被空闲回收",
    );
    assert.ok(app.states.has(`${server.mobileClientId}/${idleStream}`) === false, "回收应 forgetClient");
    app.emit("event", { method: "idle/y", params: {} } satisfies AgentNotification);
    await waitFor(
      () => server.dedupedByStream.get(server.mobileStreamId)?.some((e) => e.method === "idle/y") ?? false,
      5000,
      "默认流应继续收到通知",
    );
    assert.equal(
      (server.dedupedByStream.get(idleStream) ?? []).filter((e) => e.method === "idle/y").length,
      0,
      "回收后的流不得再收通知",
    );
    clearInterval(keepAlive);
  } finally {
    await tunnel.stop();
    await server.stop();
  }
});

function waitFor(predicate: () => boolean, timeoutMs = 5000, label?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(label ? `waitFor 超时: ${label}` : "waitFor 超时"));
      }
    }, 20);
  });
}
