/**
 * S02 下游框架 + 守护进程测试（AC1–AC6）。
 *
 * - 全部临时目录落在 .agent-work/tmp/（CGRCB_HOME / options.home 指向临时目录），
 *   绝不触碰真实 ~/.cgrcb；wham 用 MockWhamServer，不碰真实端口/网络。
 * - stub agent 经**正式注册表** registerAgent 注册（延迟工厂），不 import src/sim/*。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
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
import { REST_PATHS, WS_HEADERS } from "../src/wham/protocol.ts";
import {
  MAX_SOCKET_PATH_BYTES,
  assertSocketPathFits,
  cgrcbPaths,
  instancePaths,
  resolveCgrcbHome,
} from "../src/daemon/paths.ts";
import {
  defaultConfig,
  normalizeConfig,
  readConfig,
  readLifecycle,
  withAgentEnabled,
  writeConfig,
} from "../src/daemon/config.ts";
import { CgrcbDaemon, type CgrcbDaemonOptions } from "../src/daemon/daemon.ts";
import {
  requestIpc,
  DaemonAlreadyRunningError,
  MAX_IPC_LINE_BYTES,
  type AgentRuntimeStatus,
  type DaemonStatusPayload,
} from "../src/daemon/ipc.ts";

const cleanupDirs: string[] = [];
after(async () => {
  resetAgents();
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(slug: string): Promise<string> {
  // 注意：daemon.sock 绝对路径受 macOS sun_path（≤100B，见 assertSocketPathFits）限制，
  // 基目录必须短（直接放 .agent-work/tmp 下）。
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
    email: "daemon@test",
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

interface StubAgents {
  module: AgentModule;
  apps: StubAgentApp[];
  instances: number;
}

class StubAgentApp extends EventEmitter {
  closeCount = 0;
  rejectAll = false;
  readonly states = new Map<string, AgentClientState>();
  constructor(readonly label: string) {
    super();
  }

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

  close(): void {
    this.closeCount += 1;
  }

  async handleRequest(
    _key: AgentClientKey,
    id: number | string,
    method: string,
    _params: unknown,
  ): Promise<JsonRpcOutcome> {
    if (this.rejectAll) {
      throw new Error(`stub reject: ${method}`);
    }
    return { id, result: { method, label: this.label } };
  }
}

let uniqueCounter = 0;
function uniqueId(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${uniqueCounter}`;
}

/** 注册一个 stub agent 模块（可注入工厂故障 / 实例收集）。 */
function registerStub(
  id: string,
  opts: { failFactoryTimes?: number } = {},
): StubAgents {
  const apps: StubAgentApp[] = [];
  const state = { instances: 0 };
  const module: AgentModule = {
    id,
    createInstance(_ctx: AgentInstanceContext): AgentApp {
      state.instances += 1;
      if (opts.failFactoryTimes !== undefined && state.instances <= opts.failFactoryTimes) {
        throw new Error("stub factory boom");
      }
      const app = new StubAgentApp(id);
      apps.push(app);
      return app;
    },
  };
  registerAgent(module);
  return { module, apps, get instances() { return state.instances; } };
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

function makeDaemon(home: string, mock: MockWhamServer, extra: Partial<CgrcbDaemonOptions> = {}): CgrcbDaemon {
  return new CgrcbDaemon({
    home,
    baseUrl: `http://127.0.0.1:${mock.port}`,
    reconnectDelayMs: 0,
    log: () => {},
    ...extra,
  });
}

function mockHeaders(server: MockWhamServer): Record<string, string> {
  return server["codexHeaders"] as Record<string, string>;
}

async function enrollInstallIds(jsonlPath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(jsonlPath, "utf8");
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as {
        dir?: string;
        frame?: { path?: string; body?: { installation_id?: string } };
      };
      const instId = rec.frame?.body?.installation_id;
      if (rec.dir === "rest-request" && rec.frame?.path === REST_PATHS.enroll && instId) {
        ids.push(instId);
      }
    } catch {
      // 落盘中的半行，忽略
    }
  }
  return ids;
}

// ---------------------------------------------------------------------- AC1

test("AC1 config：缺省生成/原子写无残留/坏 JSON 报错/宽松向前兼容", async () => {
  const home = await tempDir("cfg");
  const paths = cgrcbPaths(home);

  // 缺省生成并落盘
  const cfg = await readConfig(paths.configPath);
  assert.deepEqual(cfg, { version: 1, agents: {} });
  const onDisk = JSON.parse(await readFile(paths.configPath, "utf8")) as {
    version: number;
    agents: unknown;
  };
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.agents, {});
  assert.deepEqual(defaultConfig(), { version: 1, agents: {} });

  // 原子写：不残留临时文件
  await writeConfig(paths.configPath, withAgentEnabled(cfg, "sim", true));
  const entries = await readdir(home);
  assert.ok(
    !entries.some((e) => e.includes(".tmp-")),
    `不应残留 tmp 文件: ${JSON.stringify(entries)}`,
  );
  const roundTrip = await readConfig(paths.configPath);
  assert.equal(roundTrip.agents.sim.enabled, true);

  // 宽松向前兼容：多余字段忽略不报错（并保留），坏 agent 条目忽略
  await writeFile(
    paths.configPath,
    JSON.stringify({
      version: 1,
      futureTopLevel: "keep",
      agents: { sim: { enabled: true, futureAgentField: 42 }, broken: "oops" },
    }),
  );
  const loose = await readConfig(paths.configPath);
  assert.equal(loose.futureTopLevel, "keep");
  assert.equal(loose.agents.sim.futureAgentField, 42);
  assert.equal(loose.agents.broken, undefined);
  assert.equal(normalizeConfig({ agents: { a: { enabled: "yes" } } }).agents.a!.enabled, false);

  // 坏 JSON → 明确报错（不静默成缺省）
  await writeFile(paths.configPath, "{ not json");
  await assert.rejects(() => readConfig(paths.configPath), /config JSON 解析失败/);

  // 数据布局：CGRCB_HOME 覆盖生效
  assert.equal(resolveCgrcbHome({ CGRCB_HOME: home } as NodeJS.ProcessEnv), home);
  assert.match(paths.socketPath, /daemon\.sock$/);
  assert.match(instancePaths(join(home, "instances", "sim")).lifecycle, /lifecycle\.json$/);
});

// ---------------------------------------------------------------------- AC2

test("AC2 daemon 集成：注册表 stub enable→IPC status online→disable→offline；错误三态", async () => {
  const mock = await startMock();
  const home = await tempDir("ac2");
  const paths = cgrcbPaths(home);
  const id = uniqueId("ac2");
  const stub = registerStub(id);
  const daemon = makeDaemon(home, mock);
  try {
    await daemon.start();

    // 未登录 → NOT_LOGGED_IN
    const notLogged = await requestIpc(paths.socketPath, "enable", { agent: id });
    assert.equal(notLogged.ok, false);
    assert.equal((notLogged as { error: string }).error, "NOT_LOGGED_IN");

    // 未知 agent → UNKNOWN_AGENT
    const unknown = await requestIpc(paths.socketPath, "enable", { agent: "no-such-agent" });
    assert.equal(unknown.ok, false);
    assert.equal((unknown as { error: string }).error, "UNKNOWN_AGENT");

    await wantLoggedIn(home);

    // 初始 disabled（且 config 尚无该 agent 条目：首次 enable 时补条目）
    const cfgBefore = await readConfig(paths.configPath);
    assert.equal(cfgBefore.agents[id], undefined, "首次 enable 前不应预置 config 条目");
    const before = await ipcAgentStatus(paths.socketPath, id);
    assert.equal(before.status, "disabled");
    assert.equal(before.enabled, false);

    // enable → online（含 enrollment 信息）
    const enabled = await requestIpc(paths.socketPath, "enable", { agent: id });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");
    const online = await ipcAgentStatus(paths.socketPath, id);
    assert.equal(online.status, "online");
    assert.equal(online.enabled, true);
    assert.ok(online.serverId, "status 应可见 server_id");
    assert.ok(online.environmentId, "status 应可见 environment_id");
    assert.ok(online.installationId, "status 应可见 installation_id");

    // daemon 级 status 汇总
    const all = await ipcStatus(paths.socketPath);
    assert.equal(all.agents[id]!.online, true);
    assert.equal(all.daemon.running, true);
    assert.equal(all.daemon.home, home);
    assert.equal(all.auth.loggedIn, true);

    // 未实现 op 占位
    const init = await requestIpc(paths.socketPath, "agent-init", { agent: id });
    assert.deepEqual(init, { ok: false, error: "INTERNAL", message: "not implemented" });

    // disable → offline（config enabled=false）
    const disabled = await requestIpc(paths.socketPath, "disable", { agent: id });
    assert.equal(disabled.ok, true, JSON.stringify(disabled));
    const offline = await ipcAgentStatus(paths.socketPath, id);
    assert.equal(offline.status, "disabled");
    assert.equal(offline.online, false);
    assert.equal(offline.connected, false);
    const cfg = await readConfig(paths.configPath);
    assert.equal(cfg.agents[id]!.enabled, false);
    assert.ok(stub.apps.length >= 1);
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

test("AC2 IPC 并发：同 agent enable/disable 串行化，终态无半状态", async () => {
  const mock = await startMock();
  const home = await tempDir("ac2conc");
  const paths = cgrcbPaths(home);
  const id = uniqueId("ac2conc");
  registerStub(id);
  const daemon = makeDaemon(home, mock);
  try {
    await wantLoggedIn(home);
    await daemon.start();
    // 并发（到达顺序不定）；per-agent 锁必须串行化且终态自洽
    const [en, dis] = await Promise.all([
      requestIpc(paths.socketPath, "enable", { agent: id }),
      requestIpc(paths.socketPath, "disable", { agent: id }),
    ]);
    assert.equal(en.ok, true, JSON.stringify(en));
    assert.equal(dis.ok, true, JSON.stringify(dis));

    const cfg = await readConfig(paths.configPath);
    const st = await ipcAgentStatus(paths.socketPath, id);
    assert.equal(st.enabled, cfg.agents[id]!.enabled, "status.enabled 必须与 config 一致");
    if (st.enabled) {
      await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "conc online");
    } else {
      assert.equal(st.status, "disabled");
      assert.equal(st.connected, false);
    }
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

test("IPC 客户端：daemon 未运行时连接失败（ENOENT），供 S05 离线降级", async () => {
  const home = await tempDir("ipc-offline");
  const paths = cgrcbPaths(home);
  await assert.rejects(
    () => requestIpc(paths.socketPath, "status"),
    (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("daemon start：stale socket 被清理接管；活跃 daemon 的 socket 抛 EADDRINUSE", async () => {
  const home = await tempDir("stale");
  const paths = cgrcbPaths(home);
  await mkdir(home, { recursive: true });
  // stale：真实的残留 unix socket（子进程 bind 后退出，文件残留、无监听者）
  await createStaleSocket(paths.socketPath);
  assert.equal(existsSync(paths.socketPath), true, "stale socket 文件应残留");
  // 经 CGRCB_HOME 环境变量解析数据根（不传 home 选项），覆盖 env 接线
  const daemon = new CgrcbDaemon({ env: { CGRCB_HOME: home }, log: () => {} });
  const second = new CgrcbDaemon({ env: { CGRCB_HOME: home }, log: () => {} });
  try {
    await daemon.start();
    assert.equal(daemon.isRunning, true, "stale socket 应被清理并接管");
    assert.equal((await requestIpc(paths.socketPath, "status")).ok, true);

    // 活跃 socket → 第二个 daemon 拒绝双跑
    await assert.rejects(() => second.start(), (err: unknown) => err instanceof DaemonAlreadyRunningError);
  } finally {
    await daemon.shutdown();
    await second.shutdown();
  }
});

// ---------------------------------------------------------------------- AC3

test("AC3① 实例隔离：一个 agent 工厂同步抛错，另一 agent 正常服务", async () => {
  const mock = await startMock();
  const home = await tempDir("ac3a");
  const paths = cgrcbPaths(home);
  const badId = uniqueId("ac3-bad");
  const goodId = uniqueId("ac3-good");
  registerStub(badId, { failFactoryTimes: 1_000_000 });
  registerStub(goodId);
  const daemon = makeDaemon(home, mock, { restartBaseDelayMs: 60_000 });
  try {
    await wantLoggedIn(home);
    await daemon.start();

    const bad = await requestIpc(paths.socketPath, "enable", { agent: badId });
    assert.equal(bad.ok, true, JSON.stringify(bad));
    const badStatus = (bad as { ok: true; data: AgentRuntimeStatus }).data;
    assert.equal(badStatus.status, "failed");
    assert.match(String(badStatus.error), /factory boom/);

    const good = await requestIpc(paths.socketPath, "enable", { agent: goodId });
    assert.equal(good.ok, true, JSON.stringify(good));
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, goodId)).online, 5000, "good online");
    assert.equal(daemon.isRunning, true);
    assert.equal((await ipcAgentStatus(paths.socketPath, badId)).status, "failed");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

test("AC3② 实例隔离：handleRequest 持续 reject 不影响另一实例、daemon 存活、无 unhandledRejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const mock = await startMock();
  const home = await tempDir("ac3b");
  const paths = cgrcbPaths(home);
  const rejectId = uniqueId("ac3-reject");
  const okId = uniqueId("ac3-ok");
  const rejectStub = registerStub(rejectId);
  registerStub(okId);
  // 短退避：若把 per-request fault 误当结构性故障，会在这里迅速重建（MATERIAL 6 回归）
  const daemon = makeDaemon(home, mock, { restartBaseDelayMs: 20, restartMaxDelayMs: 40 });
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: okId });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, okId)).online, 5000, "ok online");
    // 后启用 reject 实例 → mock 的最新 socket 是它，rpc 落到它身上
    await requestIpc(paths.socketPath, "enable", { agent: rejectId });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, rejectId)).connected, 5000, "reject connected");
    await waitFor(() => mockHeaders(mock)[WS_HEADERS.installationId] !== undefined, 5000, "reject 握手到达");

    for (const app of rejectStub.apps) app.rejectAll = true;
    const r1 = (await mock.rpc("boom", {}, 5000)) as { error?: { message?: string } };
    assert.ok(r1.error, "reject 应回 JSON-RPC error");
    assert.match(String(r1.error?.message), /agent error/);

    // per-request fault 由 tunnel 自愈：实例保持 online、隧道连接保持、无重建
    await new Promise((r) => setTimeout(r, 120));
    const rejectStatus = await ipcAgentStatus(paths.socketPath, rejectId);
    assert.equal(rejectStatus.status, "online");
    assert.equal(rejectStatus.connected, true);
    assert.equal(rejectStub.instances, 1, "per-request reject 不得触发隧道重建");

    // 另一实例仍在线且已连接（未受影响）
    const okStatus = await ipcAgentStatus(paths.socketPath, okId);
    assert.equal(okStatus.status, "online");
    assert.equal(okStatus.connected, true);
    assert.equal(daemon.isRunning, true);

    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(unhandled, [], "不得产生 unhandledRejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await daemon.shutdown();
    await mock.stop();
  }
});

test("AC3 退避重启：工厂前两次抛错后恢复在线", async () => {
  const mock = await startMock();
  const home = await tempDir("ac3-restart");
  const paths = cgrcbPaths(home);
  const id = uniqueId("ac3-restart");
  const stub = registerStub(id, { failFactoryTimes: 2 });
  const daemon = makeDaemon(home, mock, { restartBaseDelayMs: 20, restartMaxDelayMs: 200 });
  try {
    await wantLoggedIn(home);
    await daemon.start();
    const res = await requestIpc(paths.socketPath, "enable", { agent: id });
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "恢复在线");
    assert.ok(stub.instances >= 3, `应经历至少 3 次工厂调用（含 2 次失败）: ${stub.instances}`);
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// ---------------------------------------------------------------------- AC4

test("AC4 优雅停：SIGTERM handler → socket 清理、app.close 被调、daemon 停止（可退出）", async () => {
  const mock = await startMock();
  const home = await tempDir("ac4");
  const paths = cgrcbPaths(home);
  const id = uniqueId("ac4");
  const stub = registerStub(id);
  const daemon = makeDaemon(home, mock);
  // 记录 start 之前已有的 SIGTERM 监听，精确定位 daemon 安装的那个
  const preExisting = new Set(process.listeners("SIGTERM"));
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");
    assert.equal(existsSync(paths.socketPath), true, "启动后 socket 存在");
    assert.equal(stub.apps[0]!.closeCount, 0);

    // 信号接线：daemon 安装了 SIGTERM/SIGINT handler（start 前不存在的那一个）
    const ours = process.listeners("SIGTERM").filter((l) => !preExisting.has(l));
    assert.equal(ours.length, 1, "daemon 应安装一个 SIGTERM handler");
    assert.equal(process.listeners("SIGINT").length >= 1, true);

    // 进程内模拟信号到达（只调用 daemon 自己的 handler，不广播给其他监听）
    (ours[0] as () => void)();
    await waitFor(() => !existsSync(paths.socketPath) && !daemon.isRunning, 5000, "socket 清理/停止");
    assert.equal(stub.apps[0]!.closeCount, 1, "app.close 应被调用（tunnel.stop 内部）");
    assert.equal((await daemon.statusPayload()).agents[id]?.connected, false);

    // shutdown 幂等；信号监听已移除（进程可干净退出）
    await daemon.shutdown();
    await daemon.shutdown();
    assert.deepEqual(process.listeners("SIGTERM").filter((l) => !preExisting.has(l)), []);

    // socket 已清理 → 新 daemon 可在同 home 重新启动（无 stale 冲突）
    const daemon2 = makeDaemon(home, mock);
    await daemon2.start();
    assert.equal(existsSync(paths.socketPath), true);
    await daemon2.shutdown();
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// ---------------------------------------------------------------------- AC5

test("AC5 installation_id 实例隔离：两 agent 各自目录且各自 enroll/refresh/WSS 握手同源", async () => {
  const jsonl = join(await tempDir("ac5-jsonl"), "frames.jsonl");
  const mock = new MockWhamServer({
    port: 0,
    jsonlPath: jsonl,
    autoScript: false,
    tokenTtlMs: 150,
    refreshTokenTtlMs: 120_000,
    log: () => {},
  });
  await mock.start();
  const home = await tempDir("ac5");
  const paths = cgrcbPaths(home);
  const alpha = uniqueId("ac5-alpha");
  const beta = uniqueId("ac5-beta");
  registerStub(alpha);
  registerStub(beta);
  const daemon = makeDaemon(home, mock, { pingIntervalMs: 30, refreshThresholdMs: 60_000 });
  try {
    await wantLoggedIn(home);
    await daemon.start();

    // --- alpha：单实例期验证 enroll body / refresh REST 头 / WSS 握手同源 ---
    await requestIpc(paths.socketPath, "enable", { agent: alpha });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, alpha)).online, 5000, "alpha online");
    await waitFor(() => mock.refreshCount >= 1, 5000, "alpha refresh");
    // refresh 端点校验 x-codex-installation-id：头若与实例目录不一致会 401 → 兜底 enroll
    assert.equal(mock.enrollCount, 1, "refresh 成功（REST 头 installation_id 匹配），未兜底 enroll");

    const alphaInst = (await readFile(instancePaths(join(paths.instancesDir, alpha)).installationId, "utf8")).trim();
    assert.match(alphaInst, /^[0-9a-f-]{36}$/);
    const alphaEnrollment = JSON.parse(
      await readFile(instancePaths(join(paths.instancesDir, alpha)).enrollment, "utf8"),
    ) as { server_id: string; environment_id: string };
    const alphaHeaders = mockHeaders(mock);
    assert.equal(alphaHeaders[WS_HEADERS.installationId], alphaInst, "WSS 握手 installation_id 同源");
    assert.equal(alphaHeaders[WS_HEADERS.serverId], alphaEnrollment.server_id, "WSS 握手 server_id 同源");
    await waitFor(async () => (await enrollInstallIds(jsonl)).includes(alphaInst), 5000, "alpha enroll body");
    assert.equal(
      (await ipcAgentStatus(paths.socketPath, alpha)).installationId,
      alphaInst,
      "status 暴露的 installation_id 同源",
    );

    // --- beta：独立实例目录/身份，refresh 同样不兜底 ---
    await requestIpc(paths.socketPath, "disable", { agent: alpha });
    await requestIpc(paths.socketPath, "enable", { agent: beta });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, beta)).online, 5000, "beta online");
    await waitFor(() => mock.refreshCount >= 2, 5000, "beta refresh");
    assert.equal(mock.enrollCount, 2, "beta refresh 成功、无兜底 enroll");

    const betaInst = (await readFile(instancePaths(join(paths.instancesDir, beta)).installationId, "utf8")).trim();
    assert.notEqual(betaInst, alphaInst, "两实例 installation_id 必须隔离");
    assert.equal(mockHeaders(mock)[WS_HEADERS.installationId], betaInst, "beta WSS 握手 installation_id 同源");
    await waitFor(async () => (await enrollInstallIds(jsonl)).includes(betaInst), 5000, "beta enroll body");

    // 两实例目录各自有 installation_id 文件
    assert.equal(existsSync(instancePaths(join(paths.instancesDir, alpha)).installationId), true);
    assert.equal(existsSync(instancePaths(join(paths.instancesDir, beta)).installationId), true);
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// ---------------------------------------------------------------------- AC6

test("AC6a lifecycle：新实例目录首建写 everEnrolled=false，首 enrollment 置 true", async () => {
  const mock = await startMock();
  const home = await tempDir("ac6a");
  const paths = cgrcbPaths(home);
  const id = uniqueId("ac6a");
  registerStub(id);
  const daemon = makeDaemon(home, mock);
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");

    const ip = instancePaths(join(paths.instancesDir, id));
    assert.equal(existsSync(ip.enrollment), true, "enrollment.json 由隧道写入并存在");
    // lifecycle 更新是异步 fire-and-forget（enroll 时触发）：等待其落盘
    await waitFor(
      async () => (await readLifecycle(ip.lifecycle))?.everEnrolled === true,
      5000,
      "lifecycle everEnrolled=true",
    );
    assert.equal((await ipcAgentStatus(paths.socketPath, id)).everEnrolled, true);
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

test("AC6b lifecycle：已有实例目录（无 lifecycle.json）enable 后不补写", async () => {
  const mock = await startMock();
  const home = await tempDir("ac6b");
  const paths = cgrcbPaths(home);
  const id = uniqueId("ac6b");
  registerStub(id);
  // 预置实例目录（历史不明，无 lifecycle.json）
  await mkdir(join(paths.instancesDir, id), { recursive: true });
  const ip = instancePaths(join(paths.instancesDir, id));
  assert.equal(existsSync(ip.lifecycle), false);
  const daemon = makeDaemon(home, mock);
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");
    assert.equal(existsSync(ip.lifecycle), false, "历史不明不得被补写为 never-enrolled");
    assert.equal((await ipcAgentStatus(paths.socketPath, id)).everEnrolled, null);
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

test("AC6c 崩溃重建：daemon 重启后 enabled 实例自动恢复（身份保持）", async () => {
  const mock = await startMock();
  const home = await tempDir("ac6c");
  const paths = cgrcbPaths(home);
  const id = uniqueId("ac6c");
  registerStub(id);
  await wantLoggedIn(home);

  const daemon1 = makeDaemon(home, mock);
  await daemon1.start();
  await requestIpc(paths.socketPath, "enable", { agent: id });
  await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "d1 online");
  const serverId1 = (await ipcAgentStatus(paths.socketPath, id)).serverId;
  await daemon1.shutdown();

  // 重启：仅凭磁盘 config + instances 重建
  const daemon2 = makeDaemon(home, mock);
  try {
    await daemon2.start();
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "d2 自动恢复");
    const restored = await ipcAgentStatus(paths.socketPath, id);
    assert.equal(restored.enabled, true, "config enabled 从磁盘重建");
    assert.equal(restored.status, "online");
    assert.equal(restored.serverId, serverId1, "refresh-first 保身份");
    assert.equal((await readConfig(paths.configPath)).agents[id]!.enabled, true);
  } finally {
    await daemon2.shutdown();
    await mock.stop();
  }
});

// --------------------------------------------------- S02 评审修复回归（BLOCKER 1–5 / MATERIAL 6 / NIT）

/** authHeaders 延迟的登录管理器：把"启动在途"窗口拉长以复现竞态（BLOCKER 1）。 */
class SlowAuthManager extends BridgeAuthManager {
  constructor(
    private readonly delayMs: number,
    codexHome: string,
  ) {
    super({ codexHome });
  }

  override async authHeaders(): Promise<Record<string, string>> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return super.authHeaders();
  }
}

test("BLOCKER1 启动窗口：初始自动启动在途时 disable → 无孤儿隧道、可退出", async () => {
  const mock = await startMock();
  const home = await tempDir("b1");
  const paths = cgrcbPaths(home);
  const id = uniqueId("b1");
  registerStub(id);
  await wantLoggedIn(home);
  // 预置 enabled=true：daemon.start 走"初始自动启动"路径（不经 IPC，正是孤儿来源）
  await writeConfig(paths.configPath, withAgentEnabled(defaultConfig(), id, true));
  const daemon = makeDaemon(home, mock, {
    authManager: new SlowAuthManager(150, paths.codexHome),
  });

  try {
    await daemon.start();
    // 启动在途（enroll 被延迟的 authHeaders 拖住）时发起 disable
    const dis = await requestIpc(paths.socketPath, "disable", { agent: id });
    assert.equal(dis.ok, true, JSON.stringify(dis));
    const st = await ipcAgentStatus(paths.socketPath, id);
    assert.equal(st.enabled, false);
    assert.equal(st.status, "disabled");
    assert.equal(st.connected, false);

    // 无孤儿隧道：mock 侧 codex socket 必须已关闭
    await waitFor(() => mock["codexSocket"] === null, 5000, "无孤儿 WSS");
    // 再等一个窗口，确认没有异步"补建"出新实例/隧道
    await new Promise((r) => setTimeout(r, 250));
    assert.equal((await ipcAgentStatus(paths.socketPath, id)).status, "disabled");
    assert.equal(mock["codexSocket"], null, "不得补建隧道");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

test("BLOCKER2 config 提交串行化：跨 agent 并发切换不丢开关，重启后一致", async () => {
  const mock = await startMock();
  const home = await tempDir("b2");
  const paths = cgrcbPaths(home);
  const a = uniqueId("b2-a");
  const b = uniqueId("b2-b");
  registerStub(a);
  registerStub(b);
  await wantLoggedIn(home);
  const daemon = makeDaemon(home, mock);
  try {
    await daemon.start();
    // 并发 enable 两个不同 agent（各持旧快照）→ 两开关都必须落盘
    const [ea, eb] = await Promise.all([
      requestIpc(paths.socketPath, "enable", { agent: a }),
      requestIpc(paths.socketPath, "enable", { agent: b }),
    ]);
    assert.equal(ea.ok, true, JSON.stringify(ea));
    assert.equal(eb.ok, true, JSON.stringify(eb));
    let onDisk = await readConfig(paths.configPath);
    assert.equal(onDisk.agents[a]!.enabled, true);
    assert.equal(onDisk.agents[b]!.enabled, true);
    await daemon.shutdown();

    // 重启：两开关均从磁盘重建并自动恢复
    const daemon2 = makeDaemon(home, mock);
    try {
      await daemon2.start();
      await waitFor(
        async () =>
          (await ipcAgentStatus(paths.socketPath, a)).online &&
          (await ipcAgentStatus(paths.socketPath, b)).online,
        5000,
        "两 agent 自动恢复",
      );
    } finally {
      await daemon2.shutdown();
    }

    // 再并发 disable 两个 agent → 两开关都必须置 false
    const daemon3 = makeDaemon(home, mock);
    try {
      await daemon3.start();
      const [da, db] = await Promise.all([
        requestIpc(paths.socketPath, "disable", { agent: a }),
        requestIpc(paths.socketPath, "disable", { agent: b }),
      ]);
      assert.equal(da.ok, true, JSON.stringify(da));
      assert.equal(db.ok, true, JSON.stringify(db));
      onDisk = await readConfig(paths.configPath);
      assert.equal(onDisk.agents[a]!.enabled, false);
      assert.equal(onDisk.agents[b]!.enabled, false);
    } finally {
      await daemon3.shutdown();
    }
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

test("BLOCKER3 lifecycle 损坏归一：{} 与非布尔 everEnrolled → 历史不明（null）", async () => {
  const dir = await tempDir("b3");
  const lc = join(dir, "lifecycle.json");

  await writeFile(lc, "{}");
  assert.equal(await readLifecycle(lc), null, "{} 不得被当成 everEnrolled=false");
  await writeFile(lc, JSON.stringify({ everEnrolled: "yes" }));
  assert.equal(await readLifecycle(lc), null);
  await writeFile(lc, JSON.stringify({ everEnrolled: 1 }));
  assert.equal(await readLifecycle(lc), null);
  await writeFile(lc, JSON.stringify({ everEnrolled: true }));
  assert.deepEqual(await readLifecycle(lc), { everEnrolled: true });
  await writeFile(lc, JSON.stringify({ everEnrolled: false }));
  assert.deepEqual(await readLifecycle(lc), { everEnrolled: false });

  // status 出口同样归 null（S04 不得据此"证明从未 enroll"而跳过吊销）
  const home = await tempDir("b3-home");
  const paths = cgrcbPaths(home);
  const id = uniqueId("b3");
  registerStub(id);
  await mkdir(join(paths.instancesDir, id), { recursive: true });
  await writeFile(instancePaths(join(paths.instancesDir, id)).lifecycle, "{}");
  const daemon = new CgrcbDaemon({ home, log: () => {} });
  try {
    await daemon.start();
    assert.equal((await ipcAgentStatus(paths.socketPath, id)).everEnrolled, null);
  } finally {
    await daemon.shutdown();
  }
});

test("BLOCKER4 双 daemon 抢占：并发启动恰一个成功，另一个 DaemonAlreadyRunningError", async () => {
  const home = await tempDir("b4");
  const paths = cgrcbPaths(home);
  const d1 = new CgrcbDaemon({ home, log: () => {} });
  const d2 = new CgrcbDaemon({ home, log: () => {} });
  try {
    const results = await Promise.allSettled([d1.start(), d2.start()]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1, `恰一个成功：${JSON.stringify(results.map((r) => r.status))}`);
    assert.equal(failed.length, 1);
    assert.ok(
      failed[0]!.reason instanceof DaemonAlreadyRunningError,
      `败者应为 DaemonAlreadyRunningError，实际 ${String(failed[0]!.reason)}`,
    );
    // 胜者 socket 未被败者删除，仍可服务
    assert.equal((await requestIpc(paths.socketPath, "status")).ok, true);
  } finally {
    await Promise.all([d1.shutdown(), d2.shutdown()]);
  }
});

test("BLOCKER5 未注册模块：config-enabled 启动 daemon → failed（绝非 online）", async () => {
  const home = await tempDir("b5");
  const paths = cgrcbPaths(home);
  const id = uniqueId("ghost"); // 不 registerAgent
  await writeConfig(paths.configPath, withAgentEnabled(defaultConfig(), id, true));
  const daemon = new CgrcbDaemon({ home, log: () => {} });
  try {
    await daemon.start();
    await waitFor(
      async () => (await ipcAgentStatus(paths.socketPath, id)).status === "failed",
      5000,
      "failed",
    );
    const st = await ipcAgentStatus(paths.socketPath, id);
    assert.equal(st.enabled, true);
    assert.equal(st.status, "failed");
    assert.equal(st.online, false);
    assert.equal(st.connected, false);
    assert.match(String(st.error), /未注册/);
  } finally {
    await daemon.shutdown();
  }
});

test("MATERIAL6 per-request fault 不拆整实例：持续 reject → connected 保持、无重建", async () => {
  const mock = await startMock();
  const home = await tempDir("m6");
  const paths = cgrcbPaths(home);
  const id = uniqueId("m6");
  const stub = registerStub(id);
  // 短退避：若错误地把 per-request fault 当结构性故障，会立即重建
  const daemon = makeDaemon(home, mock, { restartBaseDelayMs: 20, restartMaxDelayMs: 40 });
  try {
    await wantLoggedIn(home);
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).connected, 5000, "connected");
    assert.equal(stub.instances, 1);

    for (const app of stub.apps) app.rejectAll = true;
    for (let i = 0; i < 3; i += 1) {
      const r = await mock.rpc("boom", {}, 5000);
      assert.ok("error" in r, "reject 应回 JSON-RPC error");
    }
    await new Promise((r) => setTimeout(r, 200));

    const st = await ipcAgentStatus(paths.socketPath, id);
    assert.equal(st.status, "online", "per-request fault 不得把实例拆成 failed");
    assert.equal(st.connected, true, "隧道应保持连接");
    assert.equal(stub.instances, 1, "工厂不得被再次调用（无隧道重建）");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

test("NIT② IPC 请求行超限：连接被断开且 daemon 仍可服务", async () => {
  const home = await tempDir("nit2");
  const paths = cgrcbPaths(home);
  const daemon = new CgrcbDaemon({ home, log: () => {} });
  try {
    await daemon.start();
    const socket = createConnection(paths.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write("x".repeat(MAX_IPC_LINE_BYTES + 10)); // 无换行且超限
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    assert.equal(socket.destroyed, true);
    assert.equal((await requestIpc(paths.socketPath, "status")).ok, true);
  } finally {
    await daemon.shutdown();
  }
});

test("NIT③ sun_path 长度守卫：超长 socket 路径明确报错", () => {
  const long = `/tmp/${"x".repeat(120)}/daemon.sock`;
  assert.throws(() => assertSocketPathFits(long), /路径过长/);
  assert.doesNotThrow(() => assertSocketPathFits("/tmp/cgrcb/daemon.sock"));
  assert.ok(MAX_SOCKET_PATH_BYTES <= 100);
});

test("AC6 首建生活周期：实例目录首次创建即写 everEnrolled=false（enroll 前）", async () => {
  const home = await tempDir("ac6lc");
  const paths = cgrcbPaths(home);
  const id = uniqueId("ac6lc");
  registerStub(id);
  await wantLoggedIn(home);
  // enroll 指向不可达端口：实例最终 failed，但 ensureInstanceDir 已在 enroll 前写 lifecycle
  const daemon = new CgrcbDaemon({
    home,
    baseUrl: "http://127.0.0.1:1",
    reconnectDelayMs: 0,
    log: () => {},
  });
  try {
    await daemon.start();
    const res = await requestIpc(paths.socketPath, "enable", { agent: id });
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitFor(
      async () => (await ipcAgentStatus(paths.socketPath, id)).status === "failed",
      8000,
      "enroll 失败 → failed",
    );
    const ip = instancePaths(join(paths.instancesDir, id));
    assert.deepEqual(await readLifecycle(ip.lifecycle), { everEnrolled: false });
    assert.equal((await ipcAgentStatus(paths.socketPath, id)).everEnrolled, false);
    assert.equal(existsSync(ip.enrollment), false, "enroll 未成功则无 enrollment.json");
  } finally {
    await daemon.shutdown();
  }
});

// ------------------------------------------- S02 二波修复回归（B-1..B-4 / A-NIT2 / NIT3）

/** 造一个真实"陈旧 unix socket"：子进程 bind 后直接退出，socket 文件残留、无监听者。 */
function createStaleSocket(sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(process.env.STALE_SOCK, () => process.exit(0));",
      ],
      { env: { ...process.env, STALE_SOCK: sockPath }, stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`stale socket 子进程退出码 ${code}`)),
    );
  });
}

test("B-1 start 与 shutdown 并发：start 被中止，daemon 不复活", async () => {
  const home = await tempDir("b1s");
  const paths = cgrcbPaths(home);
  const daemon = new CgrcbDaemon({ home, log: () => {} });
  const startP = daemon.start();
  const stopP = daemon.shutdown(); // 同步置 stopRequested/stopping
  const results = await Promise.allSettled([startP, stopP]);
  assert.equal(results[1]!.status, "fulfilled");
  assert.equal(daemon.isRunning, false, "start 不得在 shutdown 后复活 running=true");
  assert.equal(existsSync(paths.socketPath), false, "socket 必须被清理");
  assert.equal(existsSync(`${paths.socketPath}.lock`), false, "锁文件必须被清理");
  await assert.rejects(
    () => requestIpc(paths.socketPath, "status"),
    (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
  );
  // 后续 shutdown 仍幂等有效（旧 stopPromise 未被 start 覆盖）
  await daemon.shutdown();
  assert.equal(daemon.isRunning, false);
});

test("B-2 锁原子发布：空/不可解析锁一律 fail-safe 拒绝，不得判陈旧删除", async () => {
  const home = await tempDir("b2lock");
  const paths = cgrcbPaths(home);
  await mkdir(home, { recursive: true });
  const lock = `${paths.socketPath}.lock`;
  await writeFile(lock, ""); // 空文件：在途/未知，绝不可当陈旧删
  const d1 = new CgrcbDaemon({ home, log: () => {} });
  await assert.rejects(
    () => d1.start(),
    (err: unknown) => err instanceof DaemonAlreadyRunningError,
  );
  assert.equal(existsSync(lock), true, "不可解析锁不得被删除");
  assert.equal(await readFile(lock, "utf8"), "", "锁内容不得被改写");
  await d1.shutdown();

  // 清理后可正常启动；运行期锁内容为完整 JSON（原子发布，无空窗口）
  await rm(lock, { force: true });
  const d2 = new CgrcbDaemon({ home, log: () => {} });
  try {
    await d2.start();
    const info = JSON.parse(await readFile(lock, "utf8")) as {
      pid: number;
      startedAt: string | null;
    };
    assert.equal(info.pid, process.pid);
    assert.ok("startedAt" in info);
  } finally {
    await d2.shutdown();
  }
});

test("B-3 socket 探测保守化：EACCES 的活 socket 不被删除（fail-safe）", async () => {
  const home = await tempDir("b3sock");
  const paths = cgrcbPaths(home);
  await mkdir(home, { recursive: true });
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, () => resolve());
  });
  await chmod(paths.socketPath, 0o000); // 活 socket 但无权限 → connect EACCES
  const daemon = new CgrcbDaemon({ home, log: () => {} });
  try {
    await assert.rejects(() => daemon.start(), /拒绝接管/);
    assert.equal(existsSync(paths.socketPath), true, "探测被拒时不得删除活 socket");
  } finally {
    await daemon.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(paths.socketPath, { force: true });
    await rm(`${paths.socketPath}.lock`, { force: true });
  }
});

test("B-4 孤儿锁回收：pid 被无关活进程复用 + 无 socket → 可接管", async () => {
  const home = await tempDir("b4lock");
  const paths = cgrcbPaths(home);
  await mkdir(home, { recursive: true });
  const lock = `${paths.socketPath}.lock`;
  // pid 1（launchd）必然存活；startedAt 与真实身份不符 = pid 复用造成的孤儿锁
  await writeFile(lock, JSON.stringify({ pid: 1, startedAt: "Thu Jan  1 00:00:00 1970" }));
  const daemon = new CgrcbDaemon({ home, log: () => {} });
  try {
    await daemon.start();
    assert.equal(daemon.isRunning, true, "孤儿锁应被回收并接管");
    assert.equal((await requestIpc(paths.socketPath, "status")).ok, true);
    const info = JSON.parse(await readFile(lock, "utf8")) as { pid: number };
    assert.equal(info.pid, process.pid, "锁已换为本进程");
  } finally {
    await daemon.shutdown();
  }
});

test("A-NIT2 启动期 fault 的 pending restart 在启动成功后清除（无多余重建）", async () => {
  const mock = await startMock();
  const home = await tempDir("anit2");
  const paths = cgrcbPaths(home);
  const id = uniqueId("anit2");
  const stub = registerStub(id);
  await wantLoggedIn(home);
  const daemon = makeDaemon(home, mock, {
    authManager: new SlowAuthManager(120, paths.codexHome),
    restartBaseDelayMs: 800,
    restartMaxDelayMs: 800,
  });
  try {
    await daemon.start();
    const enableP = requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(
      () => (daemon as unknown as { instances: Map<string, unknown> }).instances.has(id),
      2000,
      "instance starting",
    );
    // 模拟启动期结构性 fault → 排下 800ms 退避重启
    (daemon as unknown as {
      onInstanceFault: (id: string, err: unknown, context: string) => void;
    }).onInstanceFault(id, new Error("boom"), "connectWs");
    const res = await enableP; // 启动成功（~120ms，远早于 800ms 定时器）
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, id)).online, 5000, "online");
    await new Promise((r) => setTimeout(r, 1000)); // 超过退避窗口
    assert.equal(stub.instances, 1, "启动成功必须清除 pending restart，避免多余重建");
    assert.equal((await ipcAgentStatus(paths.socketPath, id)).status, "online");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

test("NIT3 停止中的 enable/disable 返回 DAEMON_BUSY", async () => {
  const mock = await startMock();
  const home = await tempDir("nit3");
  const paths = cgrcbPaths(home);
  const id = uniqueId("nit3");
  registerStub(id);
  await wantLoggedIn(home);
  // 用慢启动把 shutdown 的收敛窗口拉长，使 IPC 仍在监听
  const daemon = makeDaemon(home, mock, {
    authManager: new SlowAuthManager(300, paths.codexHome),
  });
  try {
    await daemon.start();
    const enableP = requestIpc(paths.socketPath, "enable", { agent: id });
    await waitFor(
      () => (daemon as unknown as { instances: Map<string, unknown> }).instances.has(id),
      2000,
      "instance starting",
    );
    const stopP = daemon.shutdown(); // stopping 同步置位；doShutdown 等待在途启动收敛
    const en = await requestIpc(paths.socketPath, "enable", { agent: id });
    assert.equal(en.ok, false);
    assert.equal((en as { error: string }).error, "DAEMON_BUSY");
    await enableP.catch(() => undefined);
    await stopP;
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// --------------------------------------------------- S02 三波微修（锁释放所有权 / 二次 start）

test("三波1 锁释放所有权校验：锁被他人替换后 shutdown() 不删除该锁", async () => {
  const home = await tempDir("lockown");
  const paths = cgrcbPaths(home);
  const lock = `${paths.socketPath}.lock`;
  const daemon = new CgrcbDaemon({ home, log: () => {} });
  await daemon.start();
  assert.equal(existsSync(lock), true, "启动后应持锁");
  // 模拟锁被他人（不同持有者）覆盖
  const foreign = JSON.stringify({
    pid: 999999,
    startedAt: "Thu Jan  1 00:00:00 1970",
    owner: "someone-else",
  });
  await writeFile(lock, foreign);
  await daemon.shutdown();
  assert.equal(existsSync(lock), true, "旧持有者 close() 不得删除新持有者的锁");
  assert.equal(await readFile(lock, "utf8"), foreign, "他人锁内容不得被改写");
});

test("三波2 二次 start 显式拒绝：shutdown 后不再静默返回成功", async () => {
  const home = await tempDir("twice");
  const paths = cgrcbPaths(home);
  const daemon = new CgrcbDaemon({ home, log: () => {} });
  await daemon.start();
  await daemon.shutdown();
  await assert.rejects(
    () => daemon.start(),
    /daemon 已停止，请创建新实例/,
  );
  assert.equal(daemon.isRunning, false);
  assert.equal(existsSync(paths.socketPath), false);
});
