/**
 * S05 CLI + launchd + 跨进程 auth 锁测试。
 *
 * 覆盖 AC1（参数路由/退出码）、AC2（plist 快照 + launchctl 命令序列）、
 * AC3（IPC 三态降级）、AC6（dist 产物清单）、AC7（经真实 IPC 的 auth 交错）。
 * 不真写 ~/Library/LaunchAgents（CGRCB_HOME 指向 .agent-work/tmp），
 * 不真调系统 launchctl（注入执行器），不依赖预先 build（AC6 自行构建）。
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { test, after } from "node:test";
import { runCli, SERVING_AGENTS } from "../src/cli/main.ts";
import { BridgeAuthManager } from "../src/auth/manager.ts";
import { makeTestJwt } from "../src/auth/jwt.ts";
import type { FetchLike } from "../src/auth/oauth.ts";
import {
  authJsonPath,
  authLockPath,
  readAuthStore,
  withAuthLock,
  writeAuthStore,
  writeAuthStoreLocked,
  type AuthDotJson,
} from "../src/auth/store.ts";
import { CgrcbDaemon } from "../src/daemon/daemon.ts";
import { requestIpc } from "../src/daemon/ipc.ts";
import { cgrcbPaths, instanceDirFor } from "../src/daemon/paths.ts";
import { simStatePath } from "../src/agents/sim/store.ts";
import {
  buildPlist,
  commandsForInstall,
  commandsForRestart,
  commandsForStart,
  commandsForStop,
  LaunchdManager,
  parseLaunchctlPrint,
  plistEnvironment,
  type LaunchdContext,
  type LaunchctlRunner,
} from "../src/daemon/launchd.ts";

const repoRoot = process.cwd();
const cleanupDirs: string[] = [];
after(async () => {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(slug: string): Promise<string> {
  // daemon.sock 受 macOS sun_path（≤100B）限制，基目录须短。
  const base = join(repoRoot, ".agent-work", "tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, `cli-${slug}-`));
  cleanupDirs.push(dir);
  return dir;
}

function capture(): {
  out: string[];
  err: string[];
  sink: { out: (l: string) => void; err: (l: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

function authWith(accessToken: string, refreshToken = "rt-1"): AuthDotJson {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeTestJwt({
    exp,
    email: "cli@test",
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "free",
      chatgpt_user_id: "u1",
      chatgpt_account_id: "acc-1",
    },
  });
  return {
    auth_mode: "chatgpt",
    openai_api_key: null,
    tokens: { id_token: jwt, access_token: accessToken, refresh_token: refreshToken, account_id: "acc-1" },
    last_refresh: new Date().toISOString(),
  };
}

function tokenJwt(tag = "x"): string {
  return makeTestJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "cli@test",
    jti: `nonce-${tag}-${Math.random().toString(16).slice(2)}`,
    "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" },
  });
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function startDaemon(home: string): Promise<CgrcbDaemon> {
  const daemon = new CgrcbDaemon({
    home,
    log: () => {},
    registerAgents: () => import("../src/agents/sim/index.ts").then(() => undefined),
  });
  await daemon.start();
  return daemon;
}

// -------------------------------------------------------------------- AC1

test("AC1 参数路由：无参/help 显示用法，未知命令/子命令/agent 退出码 2", async () => {
  const c1 = capture();
  assert.equal(await runCli([], c1.sink), 0);
  assert.match(c1.out.join("\n"), /cgrcb —/);

  const c2 = capture();
  assert.equal(await runCli(["bogus"], c2.sink), 2);
  assert.match(c2.err.join("\n"), /未知命令：bogus/);

  const c3 = capture();
  assert.equal(await runCli(["chatgpt"], c3.sink), 2);

  const c4 = capture();
  assert.equal(await runCli(["chatgpt", "bogus"], c4.sink), 2);
  assert.match(c4.err.join("\n"), /未知子命令/);

  const c5 = capture();
  assert.equal(await runCli(["serving-agent"], c5.sink), 2);

  const c6 = capture();
  assert.equal(await runCli(["serving-agent", "nope", "status"], c6.sink), 2);
  assert.match(c6.err.join("\n"), /未知 agent：nope/);

  const c7 = capture();
  assert.equal(await runCli(["serving-agent", "sim", "frobnicate"], c7.sink), 2);
  assert.match(c7.err.join("\n"), /未知操作：frobnicate/);
});

test("AC1 三组命令可达：install 写 plist、chatgpt status、serving-agent sim init 离线", async () => {
  const home = await tempDir("d1");
  const env = { ...process.env, CGRCB_HOME: home };
  const commands: string[][] = [];
  const runner: LaunchctlRunner = async (args) => {
    commands.push(args);
    // print 报告未加载：waitUnloaded 立即返回（不等待），install 随后 bootstrap
    if (args[0] === "print") return { code: 3, stdout: "", stderr: "not found" };
    return { code: 0, stdout: "", stderr: "" };
  };

  // check-ignore 保证未真写 ~/Library/LaunchAgents
  const cInstall = capture();
  assert.equal(
    await runCli(["install"], { ...cInstall.sink, env, launchctlRunner: runner }),
    0,
  );
  const plist = join(home, "Library", "LaunchAgents", "com.cgrcb.bridge.plist");
  assert.equal(existsSync(plist), true, "plist 应写入 CGRCB_HOME 内");
  const kinds = commands.map((c) => c[0]);
  assert.ok(kinds.indexOf("bootout") >= 0 && kinds.indexOf("bootout") < kinds.indexOf("bootstrap"));

  const cStatus = capture();
  assert.equal(await runCli(["chatgpt", "status"], { ...cStatus.sink, env }), 0);
  assert.match(cStatus.out.join("\n"), /未登录/);

  const cInit = capture();
  assert.equal(await runCli(["serving-agent", "sim", "init"], { ...cInit.sink, env }), 0);
  const state = JSON.parse(await readFile(simStatePath(instanceDirFor(home, "sim")), "utf8"));
  assert.ok(Array.isArray(state) && state.length > 0, "离线 init 应播种 state.json");

  const cOffline = capture();
  assert.equal(await runCli(["serving-agent", "sim", "status"], { ...cOffline.sink, env }), 0);
  assert.match(cOffline.out.join("\n"), /daemon 未运行/);

  const cDaemonHelp = capture();
  assert.equal(await runCli(["daemon", "--help"], cDaemonHelp.sink), 0);
  assert.match(cDaemonHelp.out.join("\n"), /cgrcb daemon/);
});

// -------------------------------------------------------------------- AC2

const FIXED_CTX: LaunchdContext = {
  home: "/tmp/cgrcb-test",
  env: {},
  nodePath: "/usr/local/bin/node",
  daemonEntry: "/app/dist/cli/main.js",
  uid: 501,
};

test("AC2 plist 快照：绝对解释器/入口、KeepAlive/RunAtLoad、StdOut/Err、EnvironmentVariables.PATH", () => {
  const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.cgrcb.bridge</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/local/bin/node</string>
		<string>/app/dist/cli/main.js</string>
		<string>daemon</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/tmp/cgrcb-test/logs/cgrcb.out.log</string>
	<key>StandardErrorPath</key>
	<string>/tmp/cgrcb-test/logs/cgrcb.err.log</string>
</dict>
</plist>
`;
  assert.equal(buildPlist(FIXED_CTX), expected);
  // 关键不变量显式断言（快照失败的定位辅助）
  const plist = buildPlist(FIXED_CTX);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/app\/dist\/cli\/main\.js<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:/);
});

test("AC2 plist：CGRCB_HOME 覆盖时写入 env 且路径跟随", () => {
  const ctx: LaunchdContext = { ...FIXED_CTX, home: "/tmp/cgrcb-override", env: { CGRCB_HOME: "/tmp/cgrcb-override" } };
  const envObj = plistEnvironment(ctx);
  assert.equal(envObj.CGRCB_HOME, "/tmp/cgrcb-override");
  assert.match(envObj.PATH!, /^\/usr\/local\/bin:/);
  const plist = buildPlist(ctx);
  assert.match(plist, /<key>CGRCB_HOME<\/key>\s*<string>\/tmp\/cgrcb-override<\/string>/);
});

test("AC2 launchctl 命令序列：install 幂等刷新、stop→start 必重新 bootstrap", () => {
  const ctx: LaunchdContext = { ...FIXED_CTX, env: { CGRCB_HOME: "/tmp/cgrcb-test" } };
  const target = "gui/501/com.cgrcb.bridge";
  const plist = join("/tmp/cgrcb-test", "Library", "LaunchAgents", "com.cgrcb.bridge.plist");

  const install = commandsForInstall(ctx);
  assert.equal(install[0]!.args[0], "bootout");
  assert.equal(install[0]!.ignoreFailure, true);
  assert.deepEqual(install[1]!.args, ["bootstrap", "gui/501", plist]);

  const startUnloaded = commandsForStart(ctx, false);
  assert.deepEqual(startUnloaded.map((s) => s.args[0]), ["bootstrap", "kickstart"]);
  assert.deepEqual(startUnloaded[0]!.args, ["bootstrap", "gui/501", plist]);
  assert.deepEqual(startUnloaded[1]!.args, ["kickstart", "-k", target]);

  const startLoaded = commandsForStart(ctx, true);
  assert.deepEqual(startLoaded.map((s) => s.args[0]), ["kickstart"]);

  // stop 用 bootout 移除服务定义 → stop 后 start 必须 bootstrap（不能只 kickstart）
  const stop = commandsForStop(ctx);
  assert.deepEqual(stop.map((s) => s.args[0]), ["bootout"]);
  const afterStopStart = commandsForStart(ctx, false);
  assert.equal(afterStopStart.some((s) => s.args[0] === "bootstrap"), true);
  assert.equal(afterStopStart.at(-1)!.args[0], "kickstart");

  const restart = commandsForRestart(ctx);
  assert.deepEqual(restart.map((s) => s.args[0]), ["bootout", "bootstrap", "kickstart"]);
});

test("AC2 launchd 执行：restart 中 bootout 后 bootstrap 瞬时失败自动重试", async () => {
  const home = await tempDir("d2r");
  const env = { ...process.env, CGRCB_HOME: home };
  const ctx: LaunchdContext = { home, env, nodePath: "/usr/bin/node", daemonEntry: "/app/main.js", uid: 501 };
  let loaded = true;
  let bootstrapAttempts = 0;
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async (args) => {
    calls.push(args);
    if (args[0] === "print") {
      return loaded ? { code: 0, stdout: "state = running", stderr: "" } : { code: 3, stdout: "", stderr: "not found" };
    }
    if (args[0] === "bootout") {
      loaded = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "bootstrap") {
      bootstrapAttempts += 1;
      if (bootstrapAttempts === 1) {
        return { code: 5, stdout: "", stderr: "Input/output error" }; // 首次竞态失败
      }
      loaded = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const manager = new LaunchdManager(ctx, runner);
  await manager.restart();
  assert.equal(bootstrapAttempts, 2, "首次 bootstrap 失败应重试");
  const kinds = calls.map((c) => c[0]);
  assert.ok(kinds.indexOf("bootout") < kinds.indexOf("bootstrap"));
  assert.ok(kinds.includes("kickstart"));
});

test("AC2 parseLaunchctlPrint：解析 pid/state/last exit code", () => {
  const text = `gui/501/com.cgrcb.bridge = {
	active count = 1
	state = running
	pid = 4242
	last exit code = 0
}`;
  assert.deepEqual(parseLaunchctlPrint(text), { pid: 4242, state: "running", lastExitCode: 0 });
  assert.deepEqual(parseLaunchctlPrint("not loaded"), { pid: null, state: null, lastExitCode: null });
});

// -------------------------------------------------------------------- AC3

test("AC3 IPC 三态降级：在线/未运行(ENOENT)/未登录", async () => {
  const home = await tempDir("d3");
  const env = { ...process.env, CGRCB_HOME: home };

  // 在线（注入）：status 成功
  const cOnline = capture();
  const onlineIpc = async () => ({ ok: true as const, data: { daemon: { running: true }, agents: {} } });
  assert.equal(await runCli(["status"], { ...cOnline.sink, env, ipc: onlineIpc }), 0);
  assert.match(cOnline.out.join("\n"), /daemon：运行中/);

  // 未运行（注入 ENOENT）：status 降级、enable 报错、init 离线
  const cDown = capture();
  const enoentIpc = async () => {
    throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
  };
  assert.equal(await runCli(["status"], { ...cDown.sink, env, ipc: enoentIpc }), 0);
  assert.match(cDown.out.join("\n"), /daemon：未运行/);
  assert.match(cDown.out.join("\n"), /静态信息/);

  const cEnableDown = capture();
  assert.equal(
    await runCli(["serving-agent", "sim", "enable"], { ...cEnableDown.sink, env, ipc: enoentIpc }),
    1,
  );
  assert.match(cEnableDown.err.join("\n"), /daemon 未运行/);

  const cStatusDown = capture();
  assert.equal(
    await runCli(["serving-agent", "sim", "status"], { ...cStatusDown.sink, env, ipc: enoentIpc }),
    0,
  );
  assert.match(cStatusDown.out.join("\n"), /daemon 未运行/);

  // 未登录（注入 NOT_LOGGED_IN）：enable 报错退出 1
  const cNotLogged = capture();
  const notLoggedIpc = async () => ({ ok: false as const, error: "NOT_LOGGED_IN" as const, message: "未登录：请先执行 chatgpt login" });
  assert.equal(
    await runCli(["serving-agent", "sim", "enable"], { ...cNotLogged.sink, env, ipc: notLoggedIpc }),
    1,
  );
  assert.match(cNotLogged.err.join("\n"), /未登录/);
});

test("AC3 真实 IPC：daemon 在线 status 汇总；enable 未登录返回 NOT_LOGGED_IN", async () => {
  const home = await tempDir("d3r");
  const env = { ...process.env, CGRCB_HOME: home };
  const daemon = await startDaemon(home);
  try {
    const cStatus = capture();
    assert.equal(await runCli(["status"], { ...cStatus.sink, env }), 0);
    assert.match(cStatus.out.join("\n"), /daemon：运行中/);

    const cEnable = capture();
    assert.equal(await runCli(["serving-agent", "sim", "enable"], { ...cEnable.sink, env }), 1);
    assert.match(cEnable.err.join("\n"), /未登录/);
  } finally {
    await daemon.shutdown();
  }
});

// -------------------------------------------------------------------- AC6

test("AC6 dist 产物清单：仅交付面，研究工具不入 dist", async () => {
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const dist = join(repoRoot, "dist");
  await rm(dist, { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  chmodSync(join(dist, "cli", "main.js"), 0o755); // 与 build 脚本的 chmod +x 保持一致

  const files = (await readdir(dist, { recursive: true })).map((f) => f.replaceAll("\\", "/"));
  // 交付面存在
  assert.ok(files.includes("cli/main.js"), "dist 应含 CLI 入口");
  assert.ok(files.includes("agents/sim/blueprint-config-read.json"), "blueprint json 必须随 dist 可达");
  // 研究工具/旧入口排除
  for (const excluded of [
    "wham/proxy.js",
    "wham/probe-cli.js",
    "wham/mockServer.js",
    "wham/cli.js",
    "cli.js",
    "sim/server.js",
    "sim/cli.js",
  ]) {
    assert.equal(files.includes(excluded), false, `dist 不应含研究工具产物: ${excluded}`);
  }
  // 构建配置白名单确实不含被排除文件
  const buildConfig = JSON.parse(await readFile(join(repoRoot, "tsconfig.build.json"), "utf8"));
  const includes: string[] = buildConfig.include;
  assert.equal(includes.includes("src/wham/proxy.ts"), false);
  assert.equal(includes.includes("src/wham/mockServer.ts"), false);
  assert.equal(includes.includes("src/cli.ts"), false);
});

test("bin：符号链接调用（全局安装形态）也能执行 CLI", async () => {
  const distEntry = join(repoRoot, "dist", "cli", "main.js");
  if (!existsSync(distEntry)) {
    execFileSync(
      process.execPath,
      [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
      { cwd: repoRoot, stdio: "pipe" },
    );
  }
  const linkDir = await tempDir("lnk");
  const link = join(linkDir, "cgrcb");
  await symlink(distEntry, link);
  const helpText = execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" });
  assert.match(helpText, /cgrcb —/, "经符号链接调用（argv[1]≠import.meta.url）仍应执行 CLI");
});

// -------------------------------------------------------------------- AC7

/**
 * AC7 ①：删除（经真实 IPC auth-reset）先取得提交锁 → 在途刷新提交被丢弃，终态=已删除。
 */
test("AC7 ① 删除先于刷新提交：刷新丢弃写回，凭证文件不存在", async () => {
  const home = await tempDir("d7d");
  const paths = cgrcbPaths(home);
  await mkdir(paths.codexHome, { recursive: true });
  await writeAuthStore(paths.codexHome, authWith(tokenJwt()));
  const daemon = await startDaemon(home);
  try {
    const entered = deferred();
    const release = deferred();
    const manager = new BridgeAuthManager({
      codexHome: paths.codexHome,
      fetchImpl: okRefreshFetch(),
      lockOptions: {
        hooks: {
          beforeLock: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      },
    });
    const refreshP = manager.refreshNow();
    await entered.promise; // 刷新已完成网络、卡在取提交锁前
    const reset = await requestIpc(paths.socketPath, "auth-reset");
    assert.equal(reset.ok, true, JSON.stringify(reset));
    release.resolve();
    assert.equal(await refreshP, false, "已删除 → 刷新提交应丢弃");
    assert.equal(await readAuthStore(paths.codexHome), null, "终态应为凭证已删除");
  } finally {
    await daemon.shutdown();
  }
});

/**
 * AC7 ①：新登录先取得提交锁 → 旧刷新丢弃，磁盘保留新登录（旧刷新不覆盖新登录）。
 */
test("AC7 ① 新登录先于旧刷新提交：旧刷新不覆盖新登录", async () => {
  const home = await tempDir("d7l");
  const paths = cgrcbPaths(home);
  await mkdir(paths.codexHome, { recursive: true });
  await writeAuthStore(paths.codexHome, authWith(tokenJwt(), "rt-old"));
  const daemon = await startDaemon(home);
  try {
    const entered = deferred();
    const release = deferred();
    const manager = new BridgeAuthManager({
      codexHome: paths.codexHome,
      fetchImpl: okRefreshFetch(),
      lockOptions: {
        hooks: {
          beforeLock: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      },
    });
    const refreshP = manager.refreshNow();
    await entered.promise;
    // 新登录先取得提交锁写入新凭证（access_token 与旧值不同）
    const newAuth = authWith(tokenJwt("B"), "rt-new");
    await writeAuthStoreLocked(paths.codexHome, newAuth);
    release.resolve();
    assert.equal(await refreshP, false, "凭证已被替换 → 旧刷新应丢弃");
    const disk = await readAuthStore(paths.codexHome);
    assert.equal(disk!.tokens!.refresh_token, "rt-new", "旧刷新不得覆盖新登录");
  } finally {
    await daemon.shutdown();
  }
});

/**
 * AC7 ②：刷新持锁期间发起 reset → reset 等待，释放后完成，凭证文件不存在。
 */
test("AC7 ② 刷新持锁期间 reset：等待锁释放后完成删除", async () => {
  const home = await tempDir("d7h");
  const paths = cgrcbPaths(home);
  await mkdir(paths.codexHome, { recursive: true });
  await writeAuthStore(paths.codexHome, authWith(tokenJwt()));
  const daemon = await startDaemon(home);
  try {
    const acquired = deferred();
    const release = deferred();
    const manager = new BridgeAuthManager({
      codexHome: paths.codexHome,
      fetchImpl: okRefreshFetch(),
      lockOptions: {
        hooks: {
          onLockAcquired: async () => {
            acquired.resolve();
            await release.promise;
          },
        },
      },
    });
    const refreshP = manager.refreshNow();
    await acquired.promise; // 刷新已持提交锁
    const resetP = requestIpc(paths.socketPath, "auth-reset");
    await sleep(150); // reset 应阻塞在锁上
    assert.equal(existsSync(authJsonPath(paths.codexHome)), true, "锁未释放前 reset 不应删除");
    release.resolve();
    assert.equal(await refreshP, true, "刷新持锁期间完成提交");
    const reset = await resetP;
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.equal(await readAuthStore(paths.codexHome), null, "释放后 reset 完成删除");
  } finally {
    await daemon.shutdown();
  }
});

test("AC7 锁陈旧检测：活持有者心跳新鲜不误伤；死 pid 锁可回收", async () => {
  const home = await tempDir("d7k");

  // A. 活持有者（本进程 pid）持续心跳 → 等待方超时，绝不误抢
  const acquired = deferred();
  const release = deferred();
  let holderRan = false;
  const holder = withAuthLock(
    home,
    async () => {
      acquired.resolve();
      await release.promise;
      holderRan = true;
    },
    { staleMs: 200, heartbeatMs: 50, timeoutMs: 3000 },
  );
  await acquired.promise;
  await assert.rejects(
    withAuthLock(home, async () => {}, { staleMs: 200, heartbeatMs: 50, timeoutMs: 300 }),
    /超时/,
    "活持有者锁不得被误回收",
  );
  assert.equal(holderRan, false);
  release.resolve();
  await holder;
  assert.equal(holderRan, true);

  // B. 死 pid 的锁 → 回收后可用
  const deadPid = await deadProcessPid();
  await writeFile(
    authLockPath(home),
    JSON.stringify({ pid: deadPid, startedAt: Date.now(), owner: "dead" }),
  );
  let ran = false;
  await withAuthLock(home, async () => { ran = true; }, { timeoutMs: 2000, staleMs: 50 });
  assert.equal(ran, true, "死 pid 陈旧锁应被回收");
});

function okRefreshFetch(): FetchLike {
  return (async () =>
    new Response(
      JSON.stringify({ id_token: tokenJwt(), access_token: tokenJwt(), refresh_token: "rt-new-from-refresh" }),
      { status: 200 },
    )) as FetchLike;
}

async function deadProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  return pid;
}

test("SERVING_AGENTS 常量与 CLI 一致（防止文档外漂移）", () => {
  assert.deepEqual([...SERVING_AGENTS], ["sim"]);
});
