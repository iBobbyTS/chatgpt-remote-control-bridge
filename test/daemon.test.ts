/**
 * S02 下游框架 + 守护进程测试（AC1–AC6）。
 *
 * - 全部临时目录落在 .agent-work/tmp/daemon-tests/（CGRCB_HOME / options.home），
 *   绝不触碰真实 ~/.cgrcb；wham 用 MockWhamServer，不碰真实端口/网络。
 * - stub agent 经**正式注册表** registerAgent 注册（延迟工厂），不 import src/sim/*。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, after } from "node:test";
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
  type AgentRuntimeStatus,
  type DaemonStatusPayload,
} from "../src/daemon/ipc.ts";

const cleanupDirs: string[] = [];
after(async () => {
  resetAgents();
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(slug: string): Promise<string> {
  // 注意：daemon.sock 的绝对路径受 macOS sun_path (~104B) 限制，基目录必须短。
  const base = join(process.cwd(), ".agent-work", "tmp", "dt");
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
  // stale：socket 路径上有残留文件但无监听者（daemon 死）
  await writeFile(paths.socketPath, "");
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
  const daemon = makeDaemon(home, mock, { restartBaseDelayMs: 60_000 });
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

    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, rejectId)).status === "failed", 5000, "reject failed");
    // 另一实例仍在线且已连接（未受影响）
    const okStatus = await ipcAgentStatus(paths.socketPath, okId);
    assert.equal(okStatus.status, "online");
    assert.equal(okStatus.connected, true);
    assert.equal(daemon.isRunning, true);

    // reject 实例的隧道仍存活（每请求错误化，不拖死），可继续持有连接
    const rejectStatus = await ipcAgentStatus(paths.socketPath, rejectId);
    assert.equal(rejectStatus.connected, true);

    await new Promise((r) => setTimeout(r, 100));
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
    const lifecycle = await readLifecycle(ip.lifecycle);
    assert.equal(lifecycle?.everEnrolled, true, "首个 enrollment 事件应把 everEnrolled 置 true");
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
