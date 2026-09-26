/**
 * launchd 常驻服务集成（S05 ③）：plist 生成与 launchctl 命令序列均为**纯函数**（可单测），
 * 真实 launchctl 调用集中在 `LaunchdManager`（可注入执行器，测试不碰系统 launchctl）。
 *
 * 关键约束：
 * - `ProgramArguments = [安装时解析的绝对 node 路径, dist 入口绝对路径, "daemon"]`
 *   ——不依赖 shebang / 受限 PATH（launchd 默认 PATH 下 `#!/usr/bin/env node` 找不到 /opt/homebrew/bin/node）。
 * - `EnvironmentVariables.PATH` 含 node 目录兜底；`RunAtLoad`+`KeepAlive` 登录自启/崩溃拉起；
 *   `StandardOutPath`/`StandardErrorPath` → `<CGRCB_HOME>/logs/`（launchd 无 ErrPath 字段）。
 * - `CGRCB_HOME` 覆盖时（测试）plist 落 `<CGRCB_HOME>/Library/LaunchAgents/` 并把该变量写入
 *   plist env，绝不真写 `~/Library/LaunchAgents`。
 * - install=写 plist+bootout 旧+bootstrap（幂等刷新）；start=未加载先 bootstrap 再 kickstart
 *   （bootout 会移除服务定义，kickstart 仅对已加载服务生效）；stop=bootout；restart=stop→start。
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LAUNCHD_LABEL = "com.cgrcb.bridge";
export const PLIST_FILENAME = "com.cgrcb.bridge.plist";
export const STDOUT_LOG_FILENAME = "cgrcb.out.log";
export const STDERR_LOG_FILENAME = "cgrcb.err.log";

export interface LaunchdContext {
  /** 数据根目录（CGRCB_HOME / ~/.cgrcb）。 */
  home: string;
  env?: NodeJS.ProcessEnv;
  /** 绝对 node 解释器路径（process.execPath）。 */
  nodePath: string;
  /** 绝对 daemon 入口（dist/cli/main.js；`cgrcb daemon` 由该文件处理）。 */
  daemonEntry: string;
  /** 登录用户 uid（gui/<uid>）。 */
  uid: number;
}

/** LaunchAgents 目录：默认真实 `~/Library/LaunchAgents`；CGRCB_HOME 覆盖时跟随到 `<home>/Library/LaunchAgents`。 */
export function launchAgentsDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CGRCB_HOME?.trim();
  return override
    ? join(home, "Library", "LaunchAgents")
    : join(homedir(), "Library", "LaunchAgents");
}

export function plistPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(launchAgentsDir(home, env), PLIST_FILENAME);
}

export function stdoutLogPath(home: string): string {
  return join(home, "logs", STDOUT_LOG_FILENAME);
}

export function stderrLogPath(home: string): string {
  return join(home, "logs", STDERR_LOG_FILENAME);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** plist EnvironmentVariables：PATH 含 node 目录兜底；CGRCB_HOME 覆盖时随 plist 固化。 */
export function plistEnvironment(ctx: LaunchdContext): Record<string, string> {
  const nodeDir = dirname(ctx.nodePath);
  const path = [nodeDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const env: Record<string, string> = { PATH: path };
  const override = ctx.env?.CGRCB_HOME?.trim();
  if (override) {
    env.CGRCB_HOME = ctx.home;
  }
  return env;
}

/** 生成 plist 文本（纯函数，键序固定便于快照）。 */
export function buildPlist(ctx: LaunchdContext): string {
  const env = plistEnvironment(ctx);
  const envEntries = Object.entries(env)
    .map(([key, value]) => `\t\t<key>${escapeXml(key)}</key>\n\t\t<string>${escapeXml(value)}</string>`)
    .join("\n");
  const args = [ctx.nodePath, ctx.daemonEntry, "daemon"]
    .map((arg) => `\t\t<string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${escapeXml(LAUNCHD_LABEL)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${envEntries}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(stdoutLogPath(ctx.home))}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(stderrLogPath(ctx.home))}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------- 命令序列（纯）

export interface LaunchctlStep {
  args: string[];
  /** 失败不中止（如 uninstall/stop 时服务本就不存在）。 */
  ignoreFailure?: boolean;
  /**
   * 失败重试次数（bootstrap 用）：bootout 异步移除服务定义，紧接着 bootstrap
   * 可能瞬间撞 "Input/output error"（launchd 尚未完成卸载）。
   */
  retries?: number;
}

/** 服务目标 `gui/<uid>/<label>`。 */
export function serviceTarget(ctx: LaunchdContext): string {
  return `gui/${ctx.uid}/${LAUNCHD_LABEL}`;
}

export function printStep(ctx: LaunchdContext): LaunchctlStep {
  return { args: ["print", serviceTarget(ctx)] };
}

/** install：bootout 旧（忽略失败）→ bootstrap（幂等刷新）。 */
export function commandsForInstall(ctx: LaunchdContext): LaunchctlStep[] {
  return [
    { args: ["bootout", serviceTarget(ctx)], ignoreFailure: true },
    { args: ["bootstrap", `gui/${ctx.uid}`, plistPath(ctx.home, ctx.env)], retries: 5 },
  ];
}

/** uninstall：bootout（忽略失败）；plist 删除由调用方执行。 */
export function commandsForUninstall(ctx: LaunchdContext): LaunchctlStep[] {
  return [{ args: ["bootout", serviceTarget(ctx)], ignoreFailure: true }];
}

/**
 * start：未加载 → 先 bootstrap（重建服务定义）再 kickstart；已加载 → 仅 kickstart。
 * stop 用 bootout 会移除服务定义，故 stop 后 start 必须重新 bootstrap。
 */
export function commandsForStart(ctx: LaunchdContext, loaded: boolean): LaunchctlStep[] {
  const steps: LaunchctlStep[] = [];
  if (!loaded) {
    steps.push({ args: ["bootstrap", `gui/${ctx.uid}`, plistPath(ctx.home, ctx.env)], retries: 5 });
  }
  steps.push({ args: ["kickstart", "-k", serviceTarget(ctx)] });
  return steps;
}

export function commandsForStop(ctx: LaunchdContext): LaunchctlStep[] {
  return [{ args: ["bootout", serviceTarget(ctx)], ignoreFailure: true }];
}

/** restart：stop → start（stop 后必未加载，故 start 走 bootstrap+kickstart）。 */
export function commandsForRestart(ctx: LaunchdContext): LaunchctlStep[] {
  return [...commandsForStop(ctx), ...commandsForStart(ctx, false)];
}

// ------------------------------------------------------------- launchctl print

export interface LaunchctlStatus {
  loaded: boolean;
  pid: number | null;
  state: string | null;
  lastExitCode: number | null;
}

/** 解析 `launchctl print` 文本（pid/state/last exit code）。 */
export function parseLaunchctlPrint(text: string): Omit<LaunchctlStatus, "loaded"> {
  const pidMatch = text.match(/^\s*pid = (\d+)\s*$/m);
  const stateMatch = text.match(/^\s*state = (\S+)\s*$/m);
  const exitMatch = text.match(/^\s*last exit code = (-?\d+)\s*$/m);
  return {
    pid: pidMatch ? Number(pidMatch[1]) : null,
    state: stateMatch ? stateMatch[1] : null,
    lastExitCode: exitMatch ? Number(exitMatch[1]) : null,
  };
}

// ------------------------------------------------------------------ 执行器

export interface LaunchctlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

/** 默认执行器：spawn `launchctl`。spawn 失败（找不到命令）返回 code=-1。 */
export const defaultLaunchctlRunner: LaunchctlRunner = (args) =>
  new Promise((resolve) => {
    const child = spawn("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

/** launchd 管理器：纯函数命令序列 + 注入执行器；测试用假执行器，不碰系统 launchctl。 */
export class LaunchdManager {
  constructor(
    private readonly ctx: LaunchdContext,
    private readonly run: LaunchctlRunner = defaultLaunchctlRunner,
    private readonly log: (line: string) => void = () => {},
  ) {}

  get plistPath(): string {
    return plistPath(this.ctx.home, this.ctx.env);
  }

  private async execSteps(steps: LaunchctlStep[]): Promise<void> {
    for (const step of steps) {
      let result = await this.run(step.args);
      for (
        let attempt = 0;
        result.code !== 0 && !step.ignoreFailure && step.retries && attempt < step.retries;
        attempt += 1
      ) {
        await delay(150 * (attempt + 1));
        result = await this.run(step.args);
      }
      if (result.code !== 0 && !step.ignoreFailure) {
        throw new Error(
          `launchctl ${step.args.join(" ")} 失败（exit ${result.code}）：${result.stderr.trim()}`,
        );
      }
      if (result.code !== 0) {
        this.log(`launchctl ${step.args.join(" ")} 忽略失败（exit ${result.code}）`);
      }
      // bootout 异步移除服务定义：等待其真正卸载，避免紧随的 bootstrap 撞 launchd 竞态
      if (step.args[0] === "bootout") {
        await this.waitUnloaded();
      }
    }
  }

  /** 轮询直到服务未加载（bootout 后收敛；超时也继续，由后续 bootstrap 重试兜底）。 */
  private async waitUnloaded(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.run(printStep(this.ctx).args);
      if (result.code !== 0) return;
      await delay(50);
    }
  }

  async isLoaded(): Promise<boolean> {
    const result = await this.run(printStep(this.ctx).args);
    return result.code === 0;
  }

  async status(): Promise<LaunchctlStatus> {
    const result = await this.run(printStep(this.ctx).args);
    if (result.code !== 0) {
      return { loaded: false, pid: null, state: null, lastExitCode: null };
    }
    return { loaded: true, ...parseLaunchctlPrint(result.stdout) };
  }

  /** install：写 plist（幂等刷新）+ 命令序列。 */
  async install(): Promise<void> {
    await mkdir(dirname(this.plistPath), { recursive: true });
    await mkdir(join(this.ctx.home, "logs"), { recursive: true });
    await writeFile(this.plistPath, buildPlist(this.ctx), { mode: 0o644 });
    await this.execSteps(commandsForInstall(this.ctx));
  }

  async uninstall(): Promise<void> {
    await this.execSteps(commandsForUninstall(this.ctx));
    await rm(this.plistPath, { force: true });
  }

  async start(): Promise<void> {
    const loaded = await this.isLoaded();
    await this.execSteps(commandsForStart(this.ctx, loaded));
  }

  async stop(): Promise<void> {
    await this.execSteps(commandsForStop(this.ctx));
  }

  async restart(): Promise<void> {
    await this.execSteps(commandsForRestart(this.ctx));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
