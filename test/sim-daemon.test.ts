/**
 * S03 daemon 集成：sim 经正式注册表由 CgrcbDaemon 创建实例。
 *
 * - AC4：enable 未初始化自动播种（state.json 已含预设线程）。
 * - AC6：从正式注册表（sim 模块自注册，daemon 经 registerAgents 注入点触发）创建 sim 实例，
 *   enable→online→mock rpc initialize 应答——非测试直接 new SimApp 冒充。
 * - AC3（活实例路径）：IPC agent-reset → store==播种态、身份文件未动、队列续跑计时器清理。
 *
 * 全部临时目录落 .agent-work/tmp/（CGRCB_HOME 指向临时目录），wham 用 MockWhamServer。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, after } from "node:test";
import { getAgent, registerAgent, resetAgents } from "../src/agents/registry.ts";
import { BridgeAuthManager } from "../src/auth/manager.ts";
import { makeTestJwt } from "../src/auth/jwt.ts";
import { writeAuthStore, type AuthDotJson } from "../src/auth/store.ts";
import { MockWhamServer } from "../src/wham/mockServer.ts";
import { cgrcbPaths, instancePaths } from "../src/daemon/paths.ts";
import { writeConfig } from "../src/daemon/config.ts";
import { CgrcbDaemon, type CgrcbDaemonOptions } from "../src/daemon/daemon.ts";
import { requestIpc, type AgentRuntimeStatus } from "../src/daemon/ipc.ts";

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
    email: "sim-daemon@test",
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

async function startMock(): Promise<MockWhamServer> {
  const dir = await tempDir("mock");
  const server = new MockWhamServer({
    port: 0,
    jsonlPath: join(dir, "frames.jsonl"),
    autoScript: false,
    log: () => {},
  });
  await server.start();
  return server;
}

/** sim 模块自注册入口：经 daemon 注入点触发（daemon 不静态 import 具体 agent）。 */
function registerSimModule(): Promise<void> {
  return import("../src/agents/sim/index.ts").then(() => undefined);
}

function makeDaemon(home: string, mock: MockWhamServer): CgrcbDaemon {
  const opts: CgrcbDaemonOptions = {
    home,
    baseUrl: `http://127.0.0.1:${mock.port}`,
    reconnectDelayMs: 0,
    log: () => {},
    registerAgents: registerSimModule,
  };
  return new CgrcbDaemon(opts);
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

interface LooseStoreEntry {
  thread: { preview: string; turns: unknown[] };
  items: unknown[];
}

function normStore(entries: LooseStoreEntry[]): Array<{ preview: string; turns: number; items: number }> {
  return entries.map((e) => ({
    preview: e.thread.preview,
    turns: e.thread.turns.length,
    items: e.items.length,
  }));
}

const SEED_SEMANTICS = [{ preview: "模拟会话：桥接链路验证", turns: 1, items: 2 }];

// -------------------------------------------------------------------- AC4/AC6

test("S03 AC4/AC6 daemon 经注册表创建 sim：enable 自动播种、initialize 应答", async () => {
  const mock = await startMock();
  const home = await tempDir("simd");
  const paths = cgrcbPaths(home);
  await writeAuthStore(paths.codexHome, fakeAuth());
  const daemon = makeDaemon(home, mock);
  try {
    await daemon.start();

    // AC6：注册经 daemon 启动路径生效（非测试直接 new SimApp）
    const disabled = await ipcAgentStatus(paths.socketPath, "sim");
    assert.equal(disabled.registered, true, "sim 模块应已注册");
    assert.equal(disabled.status, "disabled");

    const enable = await requestIpc(paths.socketPath, "enable", { agent: "sim" });
    assert.equal(enable.ok, true, JSON.stringify(enable));
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, "sim")).online, 5000, "sim online");

    // AC4：enable 自动 init → state.json 已含预设线程
    const ip = instancePaths(join(paths.instancesDir, "sim"));
    const store = JSON.parse(await readFile(ip.state, "utf8")) as LooseStoreEntry[];
    assert.deepEqual(normStore(store), SEED_SEMANTICS, "enable 应自动播种预设线程");

    // agent-init 幂等：已初始化 store 字节不变
    const before = await readFile(ip.state, "utf8");
    const init = await requestIpc(paths.socketPath, "agent-init", { agent: "sim" });
    assert.equal(init.ok, true, JSON.stringify(init));
    assert.equal(await readFile(ip.state, "utf8"), before, "agent-init 幂等不得改写 store");

    // AC6：经正式注册表创建的实例响应 mock rpc initialize
    const initRpc = (await mock.rpc("initialize", {
      clientInfo: { name: "codex_chatgpt_ios_remote", title: "ChatGPT", version: "1.0" },
      capabilities: { optOutNotificationMethods: [] },
    })) as { result: Record<string, unknown> };
    assert.match(String(initRpc.result.userAgent), /bridge-sim/);
    assert.equal(initRpc.result.codexHome, paths.codexHome);

    const st = await ipcAgentStatus(paths.socketPath, "sim");
    assert.ok(st.serverId, "status 应可见 server_id");
    assert.ok(st.installationId, "status 应可见 installation_id");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// -------------------------------------------------------------------- AC3 IPC

test("S03 AC3 IPC agent-reset：活实例 reset → 播种态、身份文件未动、无 turn 复活", async () => {
  const mock = await startMock();
  const home = await tempDir("simd-reset");
  const paths = cgrcbPaths(home);
  await writeAuthStore(paths.codexHome, fakeAuth());
  const daemon = makeDaemon(home, mock);
  try {
    await daemon.start();
    await requestIpc(paths.socketPath, "enable", { agent: "sim" });
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, "sim")).online, 5000, "online");

    const ip = instancePaths(join(paths.instancesDir, "sim"));
    const instBefore = await readFile(ip.installationId, "utf8");
    const enrollmentBefore = await readFile(ip.enrollment, "utf8");
    const lifecycleBefore = await readFile(ip.lifecycle, "utf8");

    // 制造活动 turn + 排队项：主 turn 完成后 consumeQueue 排下 250ms 队列续跑计时器
    await mock.rpc("initialize", {
      clientInfo: { name: "t" },
      capabilities: { optOutNotificationMethods: [] },
    });
    const started = (await mock.rpc("thread/start", { cwd: "/tmp-sim/ipc-reset" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    await mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "主任务" }] });
    await mock.rpc("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: "排队消息" }],
      clientUserMessageId: "q1",
    });
    await waitFor(
      () => mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "主 turn 完成",
    );

    mock.receivedNotifications.length = 0;
    const reset = await requestIpc(paths.socketPath, "agent-reset", { agent: "sim" });
    assert.equal(reset.ok, true, JSON.stringify(reset));

    // store == 播种态
    const store = JSON.parse(await readFile(ip.state, "utf8")) as LooseStoreEntry[];
    assert.deepEqual(normStore(store), SEED_SEMANTICS, "reset 后 store 应为播种态");

    // 身份/生命周期文件未动
    assert.equal(await readFile(ip.installationId, "utf8"), instBefore, "installation_id 不得变");
    assert.equal(await readFile(ip.enrollment, "utf8"), enrollmentBefore, "enrollment.json 不得变");
    assert.equal(await readFile(ip.lifecycle, "utf8"), lifecycleBefore, "lifecycle.json 不得变");

    // 超过队列续跑窗口：排队项不得复活
    await new Promise((r) => setTimeout(r, 800));
    const revived = mock.receivedNotifications.some(
      (n) =>
        (n.method === "item/started" || n.method === "item/completed") &&
        (n.params as { item?: { type?: string; content?: Array<{ text?: string }> } }).item?.type ===
          "userMessage" &&
        (n.params as { item?: { content?: Array<{ text?: string }> } }).item?.content?.[0]?.text ===
          "排队消息",
    );
    assert.equal(revived, false, "reset 后排队 turn 不得复活");

    // 实例仍在线
    assert.equal((await ipcAgentStatus(paths.socketPath, "sim")).status, "online");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// -------------------------------------------------- 未运行实例：纯文件路径

test("S03 IPC agent-reset（未运行 sim）：纯文件 reset 播种，无活实例", async () => {
  const home = await tempDir("simd-offline");
  const paths = cgrcbPaths(home);
  const daemon = new CgrcbDaemon({ home, log: () => {}, registerAgents: registerSimModule });
  try {
    await daemon.start();
    // 未 enable：无实例
    assert.equal((await ipcAgentStatus(paths.socketPath, "sim")).status, "disabled");
    const reset = await requestIpc(paths.socketPath, "agent-reset", { agent: "sim" });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    const ip = instancePaths(join(paths.instancesDir, "sim"));
    const store = JSON.parse(await readFile(ip.state, "utf8")) as LooseStoreEntry[];
    assert.deepEqual(normStore(store), SEED_SEMANTICS, "未运行实例 reset 应走纯文件播种");
    // 首建实例目录写 lifecycle.json（与 enable 一致），未 enroll
    assert.deepEqual(JSON.parse(await readFile(ip.lifecycle, "utf8")), { everEnrolled: false });
  } finally {
    await daemon.shutdown();
  }
});

// ------------------------------------------------ S03 BLOCKER1：enable/boot

/** 幂等注册一个 onEnable 必抛错的 stub 模块（重启后再 start 需可重复注册）。 */
function registerFlakyEnableModule(): void {
  if (getAgent("flaky")) return;
  registerAgent({
    id: "flaky",
    createInstance: () => {
      throw new Error("flaky createInstance 不应被调用（onEnable 先失败）");
    },
    onEnable: async () => {
      throw new Error("onEnable boom");
    },
  });
}

test("S03 BLOCKER1 enable 钩子抛错：enable 报失败、config 未 enabled、重启不自动启动", async () => {
  const mock = await startMock();
  const home = await tempDir("simd-en");
  const paths = cgrcbPaths(home);
  await writeAuthStore(paths.codexHome, fakeAuth());
  const opts: CgrcbDaemonOptions = {
    home,
    baseUrl: `http://127.0.0.1:${mock.port}`,
    reconnectDelayMs: 0,
    log: () => {},
    registerAgents: registerFlakyEnableModule,
  };
  const daemon = new CgrcbDaemon(opts);
  let restarted: CgrcbDaemon | null = null;
  try {
    await daemon.start();
    const enable = await requestIpc(paths.socketPath, "enable", { agent: "flaky" });
    assert.equal(enable.ok, false, `enable 应失败: ${JSON.stringify(enable)}`);
    assert.equal((enable as { error?: string }).error, "INTERNAL");
    assert.match((enable as { message?: string }).message ?? "", /onEnable boom/);

    // config 不得残留 enabled:true（方案②：播种成功后才提交）
    const cfg = JSON.parse(await readFile(paths.configPath, "utf8")) as {
      agents?: Record<string, { enabled?: boolean }>;
    };
    assert.notEqual(cfg.agents?.flaky?.enabled, true, "onEnable 失败后 config 不得 enabled");

    // 重启：boot 路径按 config 判断，flaky 未被启用 → 不自动启动
    await daemon.shutdown();
    restarted = new CgrcbDaemon(opts);
    await restarted.start();
    assert.equal(
      (await ipcAgentStatus(paths.socketPath, "flaky")).status,
      "disabled",
      "重启后不得据 config 自动启动",
    );
  } finally {
    await restarted?.shutdown().catch(() => undefined);
    await daemon.shutdown().catch(() => undefined);
    await mock.stop();
  }
});

test("S03 BLOCKER1 boot 路径：config enabled 但 store 未初始化 → 自动播种后上线", async () => {
  const mock = await startMock();
  const home = await tempDir("simd-boot");
  const paths = cgrcbPaths(home);
  await writeAuthStore(paths.codexHome, fakeAuth());
  // 预写 enabled:true（模拟重启前的启用态）；store 故意不存在，boot 须自动播种
  await writeConfig(paths.configPath, { version: 1, agents: { sim: { enabled: true } } });
  const daemon = makeDaemon(home, mock);
  try {
    await daemon.start();
    await waitFor(
      async () => (await ipcAgentStatus(paths.socketPath, "sim")).online,
      5000,
      "boot 自动上线",
    );
    const ip = instancePaths(join(paths.instancesDir, "sim"));
    const store = JSON.parse(await readFile(ip.state, "utf8")) as LooseStoreEntry[];
    assert.deepEqual(normStore(store), SEED_SEMANTICS, "boot 路径应自动播种 state.json");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});

// ------------------------------------------------ S03 BLOCKER2：reset 落盘失败

test("S03 BLOCKER2 IPC agent-reset：state.json 落盘失败 → 返回失败而非成功", async () => {
  const mock = await startMock();
  const home = await tempDir("simd-rsf");
  const paths = cgrcbPaths(home);
  await writeAuthStore(paths.codexHome, fakeAuth());
  const daemon = makeDaemon(home, mock);
  try {
    await daemon.start();
    const enable = await requestIpc(paths.socketPath, "enable", { agent: "sim" });
    assert.equal(enable.ok, true, JSON.stringify(enable));
    await waitFor(async () => (await ipcAgentStatus(paths.socketPath, "sim")).online, 5000, "online");

    const ip = instancePaths(join(paths.instancesDir, "sim"));
    // 注入落盘失败：把 state.json 占用为目录 → resetToSeed 的 rename(tmp, state.json) 报 EISDIR
    await rm(ip.state, { force: true });
    await mkdir(ip.state, { recursive: true });

    const reset = await requestIpc(paths.socketPath, "agent-reset", { agent: "sim" });
    assert.equal(reset.ok, false, `reset 应失败: ${JSON.stringify(reset)}`);
    assert.equal((reset as { error?: string }).error, "INTERNAL");
  } finally {
    await daemon.shutdown();
    await mock.stop();
  }
});
