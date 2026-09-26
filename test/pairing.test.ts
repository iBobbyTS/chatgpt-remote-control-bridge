/**
 * S04 配对生命周期测试（AC1–AC9）。
 *
 * - enable 自动配对/续码/多设备；disable 五步吊销（分页穷尽 + 复核轮 + 中止恢复）；
 * - 全部临时目录落 .agent-work/tmp/（CGRCB_HOME / options.home 指向临时目录），
 *   wham 用 MockWhamServer，不碰真实端口/网络。
 * - stub agent 经正式注册表 registerAgent 注册（延迟工厂），不 import src/sim/*。
 * - AC9（typecheck + 全量 test 全绿）由 `npm run typecheck && npm test` 覆盖，非本文件用例。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, after } from "node:test";
import { BridgeAuthManager } from "../src/auth/manager.ts";
import { makeTestJwt } from "../src/auth/jwt.ts";
import { writeAuthStore, type AuthDotJson } from "../src/auth/store.ts";
import {
  registerAgent,
  resetAgents,
  type AgentInstanceContext,
  type AgentModule,
} from "../src/agents/registry.ts";
import type {
  AgentApp,
  AgentClientKey,
  AgentClientState,
  JsonRpcOutcome,
} from "../src/agents/types.ts";
import { MockWhamServer, type MockWhamOptions } from "../src/wham/mockServer.ts";
import { cgrcbPaths, instancePaths } from "../src/daemon/paths.ts";
import { readConfig } from "../src/daemon/config.ts";
import { CgrcbDaemon, type CgrcbDaemonOptions } from "../src/daemon/daemon.ts";
import {
  requestIpc,
  type AgentRuntimeStatus,
  type DaemonStatusPayload,
} from "../src/daemon/ipc.ts";
import type { PairingStatus } from "../src/daemon/pairing.ts";

const cleanupDirs: string[] = [];
after(async () => {
  resetAgents();
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(slug: string): Promise<string> {
  // daemon.sock 受 macOS sun_path（≤100B）限制，基目录须短（直接放 .agent-work/tmp）。
  const base = join(process.cwd(), ".agent-work", "tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, `${slug}-`));
  cleanupDirs.push(dir);
  return dir;
}

function fakeAuth(): AuthDotJson {
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const jwt = makeTestJwt({
    exp,
    email: "pairing@test",
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

async function wantLoggedIn(home: string): Promise<void> {
  await writeAuthStore(cgrcbPaths(home).codexHome, fakeAuth());
}

async function startMock(overrides: Partial<MockWhamOptions> = {}): Promise<MockWhamServer> {
  const dir = await tempDir("mock");
  const server = new MockWhamServer({
    port: 0,
    jsonlPath: join(dir, "frames.jsonl"),
    autoScript: false,
    log: () => {},
    ...overrides,
  });
  await server.start();
  return server;
}

class StubAgentApp extends EventEmitter {
  readonly states = new Map<string, AgentClientState>();

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
    _key: AgentClientKey,
    id: number | string,
    method: string,
    _params: unknown,
  ): Promise<JsonRpcOutcome> {
    return { id, result: { method } };
  }
}

let uniqueCounter = 0;
function uniqueId(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${uniqueCounter}`;
}

function registerStub(id: string): AgentModule {
  const module: AgentModule = {
    id,
    createInstance(_ctx: AgentInstanceContext): AgentApp {
      return new StubAgentApp() as unknown as AgentApp;
    },
  };
  registerAgent(module);
  return module;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  label = "waitFor",
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`${label} 超时`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function makeDaemon(
  home: string,
  mock: MockWhamServer,
  extra: Partial<CgrcbDaemonOptions> = {},
): CgrcbDaemon {
  return new CgrcbDaemon({
    home,
    baseUrl: `http://127.0.0.1:${mock.port}`,
    reconnectDelayMs: 0,
    log: () => {},
    pairingClaimPollIntervalMs: 20,
    pairingRenewalCheckIntervalMs: 20,
    ...extra,
  });
}

async function ipcAgentStatus(socketPath: string, id: string): Promise<AgentRuntimeStatus> {
  const res = await requestIpc(socketPath, "agent-status", { agent: id });
  assert.equal(res.ok, true, `agent-status 应成功: ${JSON.stringify(res)}`);
  return (res as { ok: true; data: AgentRuntimeStatus }).data;
}

async function ipcStatus(socketPath: string): Promise<DaemonStatusPayload> {
  const res = await requestIpc(socketPath, "status");
  assert.equal(res.ok, true, `status 应成功: ${JSON.stringify(res)}`);
  return (res as { ok: true; data: DaemonStatusPayload }).data;
}

async function ipcPairStatus(socketPath: string, id: string): Promise<PairingStatus> {
  const res = await requestIpc(socketPath, "pair-status", { agent: id });
  assert.equal(res.ok, true, `pair-status 应成功: ${JSON.stringify(res)}`);
  const data = (res as { ok: true; data: { agents: Record<string, PairingStatus> } }).data;
  const status = data.agents[id];
  assert.ok(status, `pair-status 应含 ${id}`);
  return status;
}

async function ipcPair(
  socketPath: string,
  id: string,
): Promise<{ agent: string; pending: { code: string; expiresAt: string } }> {
  const res = await requestIpc(socketPath, "pair", { agent: id });
  assert.equal(res.ok, true, `pair 应成功: ${JSON.stringify(res)}`);
  return (
    res as { ok: true; data: { agent: string; pending: { code: string; expiresAt: string } } }
  ).data;
}

interface PairingFile {
  code: string;
  expiresAt: string;
  token: string;
}

async function readPairingJson(path: string): Promise<PairingFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PairingFile>;
    if (parsed && typeof parsed.code === "string" && typeof parsed.token === "string") {
      return parsed as PairingFile;
    }
  } catch {
    // 无/损坏
  }
  return null;
}

async function readEnrollmentJson(
  path: string,
): Promise<{ server_id: string; environment_id: string; remote_control_token: string }> {
  return JSON.parse(await readFile(path, "utf8")) as {
    server_id: string;
    environment_id: string;
    remote_control_token: string;
  };
}

// ---------------------------------------------------------------------- AC1

test("AC1 enable 自动配对：pending 落盘、pair-status 可见、claim 后清除", async () => {
  const mock = await startMock();
  const home = await tempDir("p-ac1");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac1");
  registerStub(id);
  const daemon = makeDaemon(home, mock);
  try {
    await wantLoggedIn(home);
    await daemon.start();
    const en = await requestIpc(paths.socketPath, "enable", { agent: id });
    assert.equal(en.ok, true, JSON.stringify(en));
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");

    const ip = instancePaths(join(paths.instancesDir, id));
    await waitFor(async () => (await readPairingJson(ip.pairing)) !== null, 5000, "pairing.json 落盘");
    const pending = (await readPairingJson(ip.pairing))!;
    assert.ok(pending.code, "pending 应含 code");
    assert.ok(pending.expiresAt, "pending 应含 expiresAt");
    const enrollment = await readEnrollmentJson(ip.enrollment);
    assert.equal(pending.token, enrollment.remote_control_token, "token 应取自 enrollment");

    // pair-status 可见（含 pending）
    const st = await ipcPairStatus(paths.socketPath, id);
    assert.equal(st.pending?.code, pending.code);
    assert.equal(st.claimed, false);
    // daemon status 亦带 pairing 数据
    const all = await ipcStatus(paths.socketPath);
    const withPairing = all.agents[id] as AgentRuntimeStatus & { pairing: PairingStatus };
    assert.equal(withPairing.pairing.pending?.code, pending.code);

    // claim（addClient 即已 claim）→ 清除 pending
    mock.addClient(enrollment.environment_id, { client_id: "ac1-dev" });
    await waitFor(async () => (await readPairingJson(ip.pairing)) === null, 5000, "claim 清除");
    const st2 = await ipcPairStatus(paths.socketPath, id);
    assert.equal(st2.pending, null, "claim 后 pending 应清空");
    assert.equal(st2.claimed, true, "claim 状态应可见");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// ---------------------------------------------------------------------- AC2

test("AC2 续码：短到期 → 后台自动重发新码覆盖（每实例仅一个 pending）", async () => {
  const mock = await startMock({ pairTtlMs: 60 });
  const home = await tempDir("p-ac2");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac2");
  registerStub(id);
  const daemon = makeDaemon(home, mock);
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");

    const ip = instancePaths(join(paths.instancesDir, id));
    await waitFor(async () => (await readPairingJson(ip.pairing)) !== null, 5000, "首个 pending");
    const first = (await readPairingJson(ip.pairing))!;

    // 到期未 claim → 自动重发新码覆盖
    await waitFor(async () => {
      const p = await readPairingJson(ip.pairing);
      return !!p && p.code !== first.code;
    }, 5000, "续码覆盖");
    const second = (await readPairingJson(ip.pairing))!;
    assert.notEqual(second.code, first.code);
    assert.ok(mock.pairRequests.length >= 2, "mock 应收到至少两次 pair");

    // 只保留最新一个 pending
    const st = await ipcPairStatus(paths.socketPath, id);
    assert.equal(st.pending?.code, second.code);
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// ---------------------------------------------------------------------- AC3

test("AC3 多设备：两次 pair 两码、两 client 并存、disable 分页穷尽全吊销", async () => {
  const mock = await startMock();
  const home = await tempDir("p-ac3");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac3");
  registerStub(id);
  const daemon = makeDaemon(home, mock);
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");
    const ip = instancePaths(join(paths.instancesDir, id));
    const enrollment = await readEnrollmentJson(ip.enrollment);

    // 两次追加配对 → 两码（每次仅一个 pending，新覆盖旧）
    const pair1 = await ipcPair(paths.socketPath, id);
    const pair2 = await ipcPair(paths.socketPath, id);
    assert.notEqual(pair1.pending.code, pair2.pending.code, "两次 pair 应得两码");
    const stMid = await ipcPairStatus(paths.socketPath, id);
    assert.equal(stMid.pending?.code, pair2.pending.code, "新请求覆盖旧 pending");

    // 两设备并存
    mock.addClient(enrollment.environment_id, { client_id: "c-1" });
    mock.addClient(enrollment.environment_id, { client_id: "c-2" });
    assert.equal(mock.clientsFor(enrollment.environment_id).length, 2);
    const stClients = await ipcPairStatus(paths.socketPath, id);
    assert.equal(stClients.clients.length, 2, "pair-status 应实时反映已配对 clients");

    // 注入分页：强制页大小 1，使 disable 必须 cursor 穷尽
    (mock as unknown as { opts: { forceClientPageSize?: number } }).opts.forceClientPageSize = 1;
    const dis = await requestIpc(paths.socketPath, "disable", { agent: id });
    assert.equal(dis.ok, true, JSON.stringify(dis));
    assert.equal(mock.clientsFor(enrollment.environment_id).length, 0, "应全部吊销");
    assert.ok(mock.revokedClients.has("c-1") && mock.revokedClients.has("c-2"));
    const cursorUsed = mock.clientsRequests.some((r) => r.method === "GET" && r.query.cursor);
    assert.ok(cursorUsed, "disable 吊销必须 cursor 穷尽分页");
    assert.equal((await readConfig(paths.configPath)).agents[id]!.enabled, false);
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// ---------------------------------------------------------------------- AC4

test("AC4① 吊销失败 → 中止 disable：保持 enabled 且实例恢复在线", async () => {
  const mock = await startMock();
  const home = await tempDir("p-ac4a");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac4a");
  registerStub(id);
  const daemon = makeDaemon(home, mock);
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");
    const ip = instancePaths(join(paths.instancesDir, id));
    const enrollment = await readEnrollmentJson(ip.enrollment);
    mock.addClient(enrollment.environment_id, { client_id: "c-fail" });

    mock.revokeFailuresRemaining = 1; // 首次 DELETE 500
    const dis = await requestIpc(paths.socketPath, "disable", { agent: id });
    assert.equal(dis.ok, false, `吊销失败应中止: ${JSON.stringify(dis)}`);
    assert.match((dis as { message?: string }).message ?? "", /吊销失败/);

    // 保持 enabled
    assert.equal((await readConfig(paths.configPath)).agents[id]!.enabled, true);
    // 实例被监管者重新拉起在线
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 8000, "恢复在线");
    // 客户端仍在（吊销未成功）
    assert.ok(mock.clientsFor(enrollment.environment_id).some((c) => c.client_id === "c-fail"));
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

test("AC4② 吊销不收敛（复核 3 轮仍有）→ 中止 disable 保持 enabled 并恢复在线", async () => {
  let srv: MockWhamServer;
  let injected = 0;
  const mock = await startMock({
    afterListClients: (info) => {
      injected += 1;
      srv.addClient(info.environmentId, { client_id: `late-${injected}` });
    },
  });
  srv = mock;
  const home = await tempDir("p-ac4b");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac4b");
  registerStub(id);
  const daemon = makeDaemon(home, mock);
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");

    const dis = await requestIpc(paths.socketPath, "disable", { agent: id });
    assert.equal(dis.ok, false, `不收敛应中止: ${JSON.stringify(dis)}`);
    assert.match((dis as { message?: string }).message ?? "", /未收敛/);
    assert.equal((await readConfig(paths.configPath)).agents[id]!.enabled, true);
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 8000, "恢复在线");
    // 至少经历初始 + 复核轮多次 list
    assert.ok(
      mock.clientsRequests.filter((r) => r.method === "GET").length >= 4,
      "应经历初始吊销 + 多轮复核",
    );
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// ---------------------------------------------------------------------- AC5

test("AC5 WSS 不断线跨临期续期：pending 轮询/pairing.json 换新 token", async () => {
  const mock = await startMock({ tokenTtlMs: 3000, refreshTokenTtlMs: 60_000 });
  const home = await tempDir("p-ac5");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac5");
  registerStub(id);
  const daemon = makeDaemon(home, mock, { pingIntervalMs: 50, refreshThresholdMs: 2000 });
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");

    const ip = instancePaths(join(paths.instancesDir, id));
    await waitFor(async () => (await readPairingJson(ip.pairing)) !== null, 5000, "首个 pending");
    const token0 = (await readEnrollmentJson(ip.enrollment)).remote_control_token;

    // 临期续期（tunnel 唯一管理方）
    await waitFor(() => mock.refreshCount >= 1, 8000, "refresh");
    const token1 = (await readEnrollmentJson(ip.enrollment)).remote_control_token;
    assert.notEqual(token1, token0, "refresh 应轮换 token");

    // pairing.json 换用新 token（enrollment 事件订阅）
    await waitFor(async () => (await readPairingJson(ip.pairing))?.token === token1, 8000, "pairing token 更新");
    // 轮询确实用新 token（pair-status bearer）
    await waitFor(
      () => mock.pairStatusRequests.some((r) => r.headers.authorization === `Bearer ${token1}`),
      5000,
      "新 token 轮询",
    );
    // WSS 不断线
    const st = await ipcAgentStatus(paths.socketPath, id);
    assert.equal(st.status, "online");
    assert.equal(st.connected, true, "续期期间 WSS 必须保持连接");
    assert.equal(mock.enrollCount, 1, "续期走 refresh-first，不得兜底 enroll");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// ---------------------------------------------------------------------- AC6

test("AC6 disable 复核轮：末页 list 之后才 claim 的 client 被复核轮吊销", async () => {
  let srv: MockWhamServer;
  let armed = false;
  let done = false;
  let lateId = "";
  const mock = await startMock({
    forceClientPageSize: 1,
    afterListClients: (info) => {
      if (armed && !done && info.cursor === null) {
        done = true;
        lateId = "late-claimed";
        srv.addClient(info.environmentId, { client_id: lateId });
      }
    },
  });
  srv = mock;
  const home = await tempDir("p-ac6");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac6");
  registerStub(id);
  const daemon = makeDaemon(home, mock);
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");
    const ip = instancePaths(join(paths.instancesDir, id));
    const enrollment = await readEnrollmentJson(ip.enrollment);
    mock.addClient(enrollment.environment_id, { client_id: "known" });

    armed = true; // 末页 list（第一遍）之后注入新 claim
    const dis = await requestIpc(paths.socketPath, "disable", { agent: id });
    assert.equal(dis.ok, true, JSON.stringify(dis));
    assert.ok(mock.revokedClients.has("known"), "初始穷尽应吊销 known");
    assert.ok(lateId && mock.revokedClients.has(lateId), "复核轮应吊销末页后新 claim 的 client");
    assert.equal(mock.clientsFor(enrollment.environment_id).length, 0, "最终应无残留 client");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// ---------------------------------------------------------------------- AC7

function unreachableDaemon(home: string): CgrcbDaemon {
  return new CgrcbDaemon({
    home,
    baseUrl: "http://127.0.0.1:1",
    reconnectDelayMs: 0,
    log: () => {},
    restartBaseDelayMs: 60_000,
    restartMaxDelayMs: 60_000,
  });
}

test("AC7① everEnrolled=false（含 daemon 重启后）→ disable 直接完成、无可吊销", async () => {
  const home = await tempDir("p-ac7a");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac7a");
  registerStub(id);
  await wantLoggedIn(home);

  const daemon1 = unreachableDaemon(home);
  await daemon1.start();
  const en = await requestIpc(paths.socketPath, "enable", { agent: id });
  assert.equal(en.ok, true, JSON.stringify(en));
  await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).status === "failed", 8000, "enroll 失败");
  const ip = instancePaths(join(paths.instancesDir, id));
  assert.deepEqual(JSON.parse(await readFile(ip.lifecycle, "utf8")), { everEnrolled: false });
  assert.equal(existsSync(ip.enrollment), false, "enroll 未成功则无 enrollment.json");
  await daemon1.shutdown();

  // 重启后判定仍成立
  const daemon2 = unreachableDaemon(home);
  try {
    await daemon2.start();
    assert.equal((await readConfig(paths.configPath)).agents[id]!.enabled, true, "重启后仍 enabled");
    const dis = await requestIpc(paths.socketPath, "disable", { agent: id });
    assert.equal(dis.ok, true, JSON.stringify(dis));
    assert.equal((await readConfig(paths.configPath)).agents[id]!.enabled, false);
    assert.deepEqual(JSON.parse(await readFile(ip.lifecycle, "utf8")), { everEnrolled: false }, "lifecycle 不得被改写");
    assert.equal(existsSync(ip.pairing), false);
  } finally {
    await daemon2.shutdown();
  }
});

test("AC7② lifecycle.json 缺失（历史不明）→ disable 报错中止、保持 enabled", async () => {
  const home = await tempDir("p-ac7b");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac7b");
  registerStub(id);
  await wantLoggedIn(home);
  // 预置实例目录（无 lifecycle.json = 历史不明）
  const ip = instancePaths(join(paths.instancesDir, id));
  await mkdir(ip.dir, { recursive: true });
  assert.equal(existsSync(ip.lifecycle), false);

  const daemon = unreachableDaemon(home);
  try {
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).status === "failed", 8000, "failed");
    assert.equal(existsSync(ip.lifecycle), false, "历史不明不得被补写");

    const dis = await requestIpc(paths.socketPath, "disable", { agent: id });
    assert.equal(dis.ok, false, `应中止: ${JSON.stringify(dis)}`);
    assert.match((dis as { message?: string }).message ?? "", /历史不明/);
    assert.match((dis as { message?: string }).message ?? "", /enroll 成功后再 disable/);
    assert.equal((await readConfig(paths.configPath)).agents[id]!.enabled, true, "中止应保持 enabled");
    assert.equal(existsSync(ip.lifecycle), false);
  } finally {
    await daemon.shutdown();
  }
});

test("AC7③ everEnrolled=true 但 enrollment.json 丢 → 报错中止、不 fresh-enroll", async () => {
  const home = await tempDir("p-ac7c");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac7c");
  registerStub(id);
  await wantLoggedIn(home);
  const ip = instancePaths(join(paths.instancesDir, id));
  await mkdir(ip.dir, { recursive: true });
  await writeFile(ip.lifecycle, JSON.stringify({ everEnrolled: true }));
  assert.equal(existsSync(ip.enrollment), false);

  const daemon = unreachableDaemon(home);
  try {
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).status === "failed", 8000, "failed");

    const dis = await requestIpc(paths.socketPath, "disable", { agent: id });
    assert.equal(dis.ok, false, `应中止: ${JSON.stringify(dis)}`);
    assert.match((dis as { message?: string }).message ?? "", /enrollment\.json 丢失/);
    assert.match((dis as { message?: string }).message ?? "", /enroll 成功后再 disable/);
    assert.equal((await readConfig(paths.configPath)).agents[id]!.enabled, true, "中止应保持 enabled");
    assert.equal(existsSync(ip.enrollment), false, "不得 fresh-enroll 兜底");
  } finally {
    await daemon.shutdown();
  }
});

// ---------------------------------------------------------------------- AC8

test("AC8 off→on 身份：disable→enable 后 server_id/environment_id 不变", async () => {
  const mock = await startMock();
  const home = await tempDir("p-ac8");
  const paths = cgrcbPaths(home);
  const id = uniqueId("pac8");
  registerStub(id);
  const daemon = makeDaemon(home, mock);
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "首次 online");
    const before = await ipcAgentStatus(paths.socketPath, id);
    assert.ok(before.serverId && before.environmentId);

    const dis = await requestIpc(paths.socketPath, "disable", { agent: id });
    assert.equal(dis.ok, true, JSON.stringify(dis));

    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "二次 online");
    const after = await ipcAgentStatus(paths.socketPath, id);
    assert.equal(after.serverId, before.serverId, "server_id 应保持不变");
    assert.equal(after.environmentId, before.environmentId, "environment_id 应保持不变");
    assert.equal(mock.enrollCount, 1, "二次 enable 走 refresh-first，不得兜底 enroll");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});
