#!/usr/bin/env node
/**
 * cgrcb CLI（S05 ②）：零新依赖手写参数路由。
 *
 * 命令组：
 * - 顶层：install/uninstall/start/stop/restart/status/daemon（launchd 常驻服务）
 * - 上游：chatgpt login|logout|status|reset（logout≡reset，reset 为主名）
 * - 下游：serving-agent <agent> init|reset|enable|disable|pair|status
 *
 * 约定：
 * - 退出码：0 成功、1 一般错误、2 用法错误；
 * - stderr 只放诊断，stdout 只放机器可读结果（JSON 或清晰文本）；
 * - daemon 在线走 IPC；socket ENOENT/ECONNREFUSED 时 init/reset 走离线纯函数、
 *   status 降级显示静态信息、enable/disable/pair 报错提示先启动服务。
 */
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { simInit, simReset } from "../agents/sim/store.ts";
import { BridgeAuthManager, type AuthStatus } from "../auth/manager.ts";
import { ensureInstanceDir, readLifecycle, readConfig } from "../daemon/config.ts";
import { CgrcbDaemon } from "../daemon/daemon.ts";
import {
  DaemonAlreadyRunningError,
  requestIpc,
  type IpcOp,
  type IpcResponse,
} from "../daemon/ipc.ts";
import {
  buildPlist,
  defaultLaunchctlRunner,
  LaunchdManager,
  plistPath,
  stderrLogPath,
  stdoutLogPath,
  type LaunchctlRunner,
  type LaunchdContext,
} from "../daemon/launchd.ts";
import { readEnrollmentFile } from "../daemon/pairing.ts";
import {
  cgrcbPaths,
  instanceDirFor,
  instancePaths,
  resolveCgrcbHome,
  type CgrcbPaths,
} from "../daemon/paths.ts";

/** CLI 当前交付的下游 agent（REQUIREMENTS：当前仅 sim）。 */
export const SERVING_AGENTS = ["sim"] as const;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

const USAGE = `cgrcb — ChatGPT 远程控制桥的常驻服务 CLI

用法：
  cgrcb install                  写入 launchd plist 并加载（幂等刷新）
  cgrcb uninstall                卸载 launchd 服务并删除 plist
  cgrcb start                    启动服务（未加载时先 bootstrap）
  cgrcb stop                     停止服务
  cgrcb restart                  重启服务
  cgrcb status [--json]          服务与 daemon 状态汇总
  cgrcb daemon                   前台运行 daemon（launchd 内部调用）

上游：
  cgrcb chatgpt login [--no-browser] [--json]   浏览器登录 ChatGPT
  cgrcb chatgpt status [--json]                 登录状态
  cgrcb chatgpt reset                           重置账号（删除登录凭证；≡ logout）
  cgrcb chatgpt logout                          同 reset

下游：
  cgrcb serving-agent <agent> init|reset|enable|disable|pair|status [--json]

退出码：0 成功 / 1 一般错误 / 2 用法错误`;

const DAEMON_USAGE = `用法：cgrcb daemon

前台运行 cgrcb daemon（由 launchd ProgramArguments 调用；也可手动运行调试）。
daemon 已在运行时（socket 被占用）报错退出。`;

/** 用法错误（退出码 2）。 */
class UsageError extends Error {
  readonly code = EXIT_USAGE;
}

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** IPC 客户端注入（测试）。 */
  ipc?: (socketPath: string, op: IpcOp, args?: { agent?: string }) => Promise<IpcResponse>;
  /** launchctl 执行器注入（测试不碰系统 launchctl）。 */
  launchctlRunner?: LaunchctlRunner;
  /** plist ProgramArguments 解析（测试/非常规安装路径）。 */
  nodePath?: string;
  daemonEntry?: string;
  uid?: number;
  /** 登录管理器注入（测试）。 */
  authManager?: BridgeAuthManager;
  /** 前台 daemon 工厂注入（测试）。 */
  createDaemon?: (opts: ConstructorParameters<typeof CgrcbDaemon>[0]) => CgrcbDaemon;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function ensurePaths(deps: CliDeps): CgrcbPaths {
  return cgrcbPaths(resolveCgrcbHome(deps.env ?? process.env));
}

function launchdContext(deps: CliDeps): LaunchdContext {
  const env = deps.env ?? process.env;
  const home = resolveCgrcbHome(env);
  return {
    home,
    env,
    nodePath: deps.nodePath ?? process.execPath,
    daemonEntry: deps.daemonEntry ?? fileURLToPath(import.meta.url),
    uid: deps.uid ?? process.getuid?.() ?? 0,
  };
}

type IpcOutcome =
  | { kind: "ok"; data: unknown }
  | { kind: "not-running" }
  | { kind: "error"; code: string; message: string };

async function callIpc(
  deps: CliDeps,
  socketPath: string,
  op: IpcOp,
  agent?: string,
): Promise<IpcOutcome> {
  const call = deps.ipc ?? ((sp: string, o: IpcOp, a?: { agent?: string }) => requestIpc(sp, o, a ?? {}));
  try {
    const res = await call(socketPath, op, agent ? { agent } : {});
    if (res.ok) return { kind: "ok", data: res.data };
    return { kind: "error", code: res.error, message: res.message ?? res.error };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET") {
      return { kind: "not-running" };
    }
    return { kind: "error", code: "INTERNAL", message: messageOf(err) };
  }
}

// ------------------------------------------------------------------ 顶层命令

async function cmdInstall(deps: CliDeps): Promise<number> {
  const ctx = launchdContext(deps);
  const manager = new LaunchdManager(
    ctx,
    deps.launchctlRunner ?? defaultLaunchctlRunner,
    (line) => deps.err?.(line),
  );
  await manager.install();
  deps.out?.(`已安装 launchd 服务：${manager.plistPath}`);
  deps.out?.(`日志：${stdoutLogPath(ctx.home)} / ${stderrLogPath(ctx.home)}`);
  deps.out?.(`提示：cgrcb chatgpt login 后，cgrcb serving-agent sim enable 即可配对`);
  return EXIT_OK;
}

async function cmdUninstall(deps: CliDeps): Promise<number> {
  const ctx = launchdContext(deps);
  const manager = new LaunchdManager(
    ctx,
    deps.launchctlRunner ?? defaultLaunchctlRunner,
    (line) => deps.err?.(line),
  );
  await manager.uninstall();
  deps.out?.(`已卸载 launchd 服务并删除 plist`);
  return EXIT_OK;
}

async function cmdStart(deps: CliDeps): Promise<number> {
  const ctx = launchdContext(deps);
  const manager = new LaunchdManager(
    ctx,
    deps.launchctlRunner ?? defaultLaunchctlRunner,
    (line) => deps.err?.(line),
  );
  await manager.start();
  deps.out?.("服务已启动");
  return EXIT_OK;
}

async function cmdStop(deps: CliDeps): Promise<number> {
  const ctx = launchdContext(deps);
  const manager = new LaunchdManager(
    ctx,
    deps.launchctlRunner ?? defaultLaunchctlRunner,
    (line) => deps.err?.(line),
  );
  await manager.stop();
  deps.out?.("服务已停止");
  return EXIT_OK;
}

async function cmdRestart(deps: CliDeps): Promise<number> {
  const ctx = launchdContext(deps);
  const manager = new LaunchdManager(
    ctx,
    deps.launchctlRunner ?? defaultLaunchctlRunner,
    (line) => deps.err?.(line),
  );
  await manager.restart();
  deps.out?.("服务已重启");
  return EXIT_OK;
}

interface OfflineAgentInfo {
  agent: string;
  daemonRunning: false;
  enabled: boolean;
  registered: boolean;
  instanceDir: string;
  instanceDirExists: boolean;
  installationId: string | null;
  everEnrolled: boolean | null;
  serverId: string | null;
  environmentId: string | null;
  pendingPairingCode: string | null;
  pendingPairingExpiresAt: string | null;
}

async function offlineAgentInfo(agent: string, paths: CgrcbPaths): Promise<OfflineAgentInfo> {
  const dir = instanceDirFor(paths.root, agent);
  const ip = instancePaths(dir);
  let exists = true;
  try {
    await stat(dir);
  } catch {
    exists = false;
  }
  const config = await readConfig(paths.configPath).catch(() => null);
  const lifecycle = exists ? await readLifecycle(ip.lifecycle) : null;
  let installationId: string | null = null;
  if (exists) {
    installationId = await readFile(ip.installationId, "utf8")
      .then((t) => t.trim() || null)
      .catch(() => null);
  }
  const enrollment = exists ? await readEnrollmentFile(dir) : null;
  let pendingCode: string | null = null;
  let pendingExpires: string | null = null;
  if (exists) {
    try {
      const parsed = JSON.parse(await readFile(ip.pairing, "utf8")) as {
        code?: unknown;
        expiresAt?: unknown;
      };
      if (typeof parsed.code === "string") pendingCode = parsed.code;
      if (typeof parsed.expiresAt === "string") pendingExpires = parsed.expiresAt;
    } catch {
      // 无 pending
    }
  }
  return {
    agent,
    daemonRunning: false,
    enabled: config?.agents[agent]?.enabled === true,
    registered: SERVING_AGENTS.includes(agent as (typeof SERVING_AGENTS)[number]),
    instanceDir: dir,
    instanceDirExists: exists,
    installationId,
    everEnrolled: lifecycle ? lifecycle.everEnrolled : null,
    serverId: enrollment?.server_id ?? null,
    environmentId: enrollment?.environment_id ?? null,
    pendingPairingCode: pendingCode,
    pendingPairingExpiresAt: pendingExpires,
  };
}

async function cmdStatus(deps: CliDeps, args: string[]): Promise<number> {
  const json = hasFlag(args, "--json");
  const out = deps.out ?? ((l: string) => console.log(l));
  const ctx = launchdContext(deps);
  const paths = ensurePaths(deps);
  const manager = new LaunchdManager(
    ctx,
    deps.launchctlRunner ?? defaultLaunchctlRunner,
    (line) => deps.err?.(line),
  );

  let launchd: Awaited<ReturnType<LaunchdManager["status"]>>;
  try {
    launchd = await manager.status();
  } catch {
    launchd = { loaded: false, pid: null, state: null, lastExitCode: null };
  }

  const ipc = await callIpc(deps, paths.socketPath, "status");
  const authManager =
    deps.authManager ?? new BridgeAuthManager({ codexHome: paths.codexHome });
  const auth = await authManager.getStatus();

  if (ipc.kind === "error") {
    // B-3：IPC 明确报错（如 INTERNAL）不降级，报错退出并保留信息
    deps.err?.(`daemon 状态查询失败（${ipc.code}）：${ipc.message}`);
    return EXIT_ERROR;
  }

  if (ipc.kind === "ok") {
    // 在线/离线 --json 形态统一：均含 launchd/daemon/auth
    const payload = {
      launchd,
      daemon: { running: true, source: "ipc" as const, data: ipc.data },
      auth,
    };
    if (json) {
      out(JSON.stringify(payload, null, 2));
    } else {
      out(`launchd：${launchd.loaded ? `已加载（state=${launchd.state ?? "?"}, pid=${launchd.pid ?? "-"})` : "未加载"}`);
      out(`daemon：运行中`);
      out(`登录：${auth.loggedIn ? auth.email ?? auth.accountId ?? "已登录" : "未登录"}`);
      out(JSON.stringify(ipc.data, null, 2));
    }
    return EXIT_OK;
  }

  // 降级（仅连接不存在时）：daemon 未运行 → 显示配置/登录静态信息并标注
  const agents: Record<string, OfflineAgentInfo> = {};
  for (const agent of SERVING_AGENTS) {
    agents[agent] = await offlineAgentInfo(agent, paths);
  }
  const degraded = {
    launchd,
    daemon: {
      running: false,
      source: "offline" as const,
      note: "daemon 未运行（socket 不存在/无监听）：以下为配置与登录静态信息",
    },
    auth,
    agents,
  };
  if (json) {
    out(JSON.stringify(degraded, null, 2));
  } else {
    out(`launchd：${launchd.loaded ? `已加载（state=${launchd.state ?? "?"}, pid=${launchd.pid ?? "-"})` : "未加载"}`);
    out(`daemon：未运行（socket 不存在）—— 静态信息如下`);
    out(`登录：${auth.loggedIn ? `${auth.email ?? auth.accountId ?? "已登录"}（plan=${auth.planType ?? "?"}）` : "未登录"}`);
    for (const [id, info] of Object.entries(agents)) {
      out(`serving-agent ${id}：enabled=${info.enabled} 实例目录=${info.instanceDirExists ? "存在" : "不存在"}`);
      out(`  installation_id=${info.installationId ?? "-"} server_id=${info.serverId ?? "-"} environment_id=${info.environmentId ?? "-"}`);
      out(`  everEnrolled=${info.everEnrolled ?? "未知"} pending配对码=${info.pendingPairingCode ?? "-"}`);
    }
  }
  return EXIT_OK;
}

async function cmdDaemon(deps: CliDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const create =
    deps.createDaemon ??
    ((opts: ConstructorParameters<typeof CgrcbDaemon>[0]) => new CgrcbDaemon(opts));
  const daemon = create({
    home: resolveCgrcbHome(env),
    env,
    // 延迟工厂接线：daemon 不静态 import 具体 agent
    registerAgents: () => import("../agents/sim/index.ts").then(() => undefined),
    exitOnSignal: true,
    log: (line) => deps.err?.(`[cgrcb] ${line}`),
  });
  try {
    await daemon.start();
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) {
      deps.err?.(err.message);
      return EXIT_ERROR;
    }
    throw err;
  }
  deps.err?.("cgrcb daemon 已启动（前台运行，Ctrl-C 停止）");
  await new Promise<void>(() => {
    /* 保持前台运行；信号处理由 daemon 安装并 process.exit */
  });
  return EXIT_OK;
}

// ---------------------------------------------------------------- 上游 chatgpt

async function cmdChatgpt(deps: CliDeps, sub: string | undefined, args: string[]): Promise<number> {
  if (!sub || sub === "--help" || sub === "-h") {
    deps.out?.(
      `用法：cgrcb chatgpt <login|logout|status|reset> [options]\n` +
        `  login [--no-browser] [--json]   浏览器登录\n` +
        `  status [--json]                 登录状态\n` +
        `  reset                           重置账号（删凭证；≡ logout）`,
    );
    return sub ? EXIT_OK : EXIT_USAGE;
  }
  const paths = ensurePaths(deps);
  const manager =
    deps.authManager ?? new BridgeAuthManager({ codexHome: paths.codexHome });
  const json = hasFlag(args, "--json");

  switch (sub) {
    case "login": {
      const status = await manager.login({
        openBrowser: !hasFlag(args, "--no-browser"),
        onAuthUrl: (url) => deps.err?.(`请在浏览器完成登录：\n${url}`),
      });
      printAuthStatus(status, deps, json);
      return EXIT_OK;
    }
    case "status": {
      printAuthStatus(await manager.getStatus(), deps, json);
      return EXIT_OK;
    }
    case "reset":
    case "logout": {
      // daemon 在线：经 IPC 由 daemon 协停刷新后持锁删除；未运行：CLI 直接持锁删
      const ipc = await callIpc(deps, paths.socketPath, "auth-reset");
      if (ipc.kind === "error") {
        deps.err?.(`chatgpt reset 失败：${ipc.message}`);
        return EXIT_ERROR;
      }
      if (ipc.kind === "ok") {
        const data = ipc.data as { removed?: boolean; auth?: AuthStatus } | undefined;
        deps.out?.(
          json
            ? JSON.stringify(data, null, 2)
            : `已重置账号（daemon 执行）：凭证${data?.removed ? "已删除" : "本就未登录"}`,
        );
        return EXIT_OK;
      }
      const removed = await manager.logout();
      deps.out?.(
        json
          ? JSON.stringify({ removed, auth: await manager.getStatus() }, null, 2)
          : `已重置账号（CLI 执行）：凭证${removed ? "已删除" : "本就未登录"}`,
      );
      return EXIT_OK;
    }
    default:
      throw new UsageError(`未知子命令：chatgpt ${sub}`);
  }
}

function printAuthStatus(status: AuthStatus, deps: CliDeps, json: boolean): void {
  const out = deps.out!;
  if (json) {
    out(JSON.stringify(status, null, 2));
    return;
  }
  if (!status.loggedIn) {
    out("未登录。运行 cgrcb chatgpt login");
    return;
  }
  out(`已登录：${status.email ?? status.accountId ?? "(unknown)"}`);
  out(`计划：${status.planType ?? "unknown"}  账号：${status.accountId ?? "-"}`);
  out(`access_token 过期：${status.accessTokenExpiresAt ?? "unknown"}`);
  if (status.needsReLogin) out("需要重新登录（refresh_token 已失效）");
}

// ------------------------------------------------------------ 下游 serving-agent

const AGENT_OP: Record<string, IpcOp> = {
  init: "agent-init",
  reset: "agent-reset",
  status: "agent-status",
  enable: "enable",
  disable: "disable",
  pair: "pair",
};

async function cmdServingAgent(
  deps: CliDeps,
  agent: string | undefined,
  action: string | undefined,
  args: string[],
): Promise<number> {
  if (!agent || agent === "--help" || agent === "-h") {
    deps.out?.(
      `用法：cgrcb serving-agent <agent> <init|reset|enable|disable|pair|status> [--json]\n` +
        `  当前支持：${SERVING_AGENTS.join(", ")}`,
    );
    return agent ? EXIT_OK : EXIT_USAGE;
  }
  if (!SERVING_AGENTS.includes(agent as (typeof SERVING_AGENTS)[number])) {
    deps.err?.(`未知 agent：${agent}（当前支持：${SERVING_AGENTS.join(", ")}）`);
    return EXIT_USAGE;
  }
  if (!action || !(action in AGENT_OP)) {
    deps.err?.(
      `未知操作：${action ?? "(未指定)"}（支持：${Object.keys(AGENT_OP).join(", ")}）`,
    );
    return EXIT_USAGE;
  }
  const json = hasFlag(args, "--json");
  const out = deps.out ?? ((l: string) => console.log(l));
  const paths = ensurePaths(deps);
  const op = AGENT_OP[action];
  const ipc = await callIpc(deps, paths.socketPath, op, agent);

  if (ipc.kind === "ok") {
    if (json) {
      out(JSON.stringify(ipc.data, null, 2));
    } else {
      out(renderIpcData(action, agent, ipc.data));
    }
    return EXIT_OK;
  }
  if (ipc.kind === "error") {
    deps.err?.(`${agent} ${action} 失败：${ipc.message}`);
    return ipc.code === "UNKNOWN_AGENT" ? EXIT_USAGE : EXIT_ERROR;
  }

  // daemon 未运行：离线降级
  if (action === "init" || action === "reset") {
    const dir = instanceDirFor(paths.root, agent);
    if (agent === "sim") {
      // NIT ②：离线首建实例目录同 daemon 语义写 lifecycle.json（共享 helper）
      await ensureInstanceDir(dir);
      if (action === "init") await simInit(dir);
      else await simReset(dir);
      out(`${agent} ${action} 完成（离线，daemon 未运行）`);
      return EXIT_OK;
    }
    deps.err?.(`daemon 未运行：agent ${agent} 不支持离线 ${action}`);
    return EXIT_ERROR;
  }
  if (action === "status") {
    const info = await offlineAgentInfo(agent, paths);
    if (json) out(JSON.stringify(info, null, 2));
    else {
      out(`${agent}：daemon 未运行（以下为静态信息）`);
      out(`  enabled=${info.enabled} 实例目录=${info.instanceDir}（${info.instanceDirExists ? "存在" : "不存在"}）`);
      out(`  installation_id=${info.installationId ?? "-"}`);
      out(`  server_id=${info.serverId ?? "-"} environment_id=${info.environmentId ?? "-"}`);
      out(`  everEnrolled=${info.everEnrolled ?? "未知"} pending配对码=${info.pendingPairingCode ?? "-"}`);
    }
    return EXIT_OK;
  }
  deps.err?.(
    `daemon 未运行：请先 \`cgrcb install\` 或 \`cgrcb start\`（${agent} ${action} 需要 daemon）`,
  );
  return EXIT_ERROR;
}

function renderIpcData(action: string, agent: string, data: unknown): string {
  if (action === "pair") {
    const pending = (data as { pending?: { code?: string; expiresAt?: string } }).pending;
    if (pending?.code) {
      return `${agent} 配对码：${pending.code}（到期 ${pending.expiresAt ?? "?"}）`;
    }
    return JSON.stringify(data, null, 2);
  }
  const status = data as {
    enabled?: boolean;
    status?: string;
    online?: boolean;
    serverId?: string | null;
    environmentId?: string | null;
    pairing?: { pending?: { code?: string; expiresAt?: string } | null };
  };
  const lines = [
    `${agent}：enabled=${status.enabled ?? "?"} status=${status.status ?? "?"} online=${status.online ?? "?"}`,
    `  server_id=${status.serverId ?? "-"} environment_id=${status.environmentId ?? "-"}`,
  ];
  if (status.pairing?.pending?.code) {
    lines.push(`  配对码：${status.pairing.pending.code}（到期 ${status.pairing.pending.expiresAt ?? "?"}）`);
  }
  return lines.join("\n");
}

// -------------------------------------------------------------------- 路由

/**
 * 执行 CLI 并返回退出码（可测试入口；不 process.exit）。
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const d: CliDeps = {
    ...deps,
    out: deps.out ?? ((line: string) => console.log(line)),
    err: deps.err ?? ((line: string) => console.error(line)),
  };
  const [command, ...rest] = argv;
  try {
    return await dispatch(command, rest, d);
  } catch (err) {
    if (err instanceof UsageError) {
      d.err!(err.message);
      return EXIT_USAGE;
    }
    d.err!(messageOf(err));
    return EXIT_ERROR;
  }
}

async function dispatch(command: string | undefined, rest: string[], deps: CliDeps): Promise<number> {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    deps.out?.(USAGE);
    return EXIT_OK;
  }
  switch (command) {
    case "install":
      return cmdInstall(deps);
    case "uninstall":
      return cmdUninstall(deps);
    case "start":
      return cmdStart(deps);
    case "stop":
      return cmdStop(deps);
    case "restart":
      return cmdRestart(deps);
    case "status":
      return cmdStatus(deps, rest);
    case "daemon": {
      if (hasFlag(rest, "--help") || hasFlag(rest, "-h")) {
        deps.out?.(DAEMON_USAGE);
        return EXIT_OK;
      }
      return cmdDaemon(deps);
    }
    case "chatgpt":
      return cmdChatgpt(deps, rest[0], rest.slice(1));
    case "serving-agent":
      return cmdServingAgent(deps, rest[0], rest[1], rest.slice(2));
    default:
      deps.err?.(`未知命令：${command}`);
      deps.err?.(USAGE);
      return EXIT_USAGE;
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // realpath：全局安装的 bin 是符号链接，argv[1] 为链接路径而 import.meta.url 为真实路径
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(messageOf(err));
      process.exitCode = EXIT_ERROR;
    });
}

// 导出供测试：plist 生成上下文（避免测试重复构造）
export { launchdContext, buildPlist, plistPath };
