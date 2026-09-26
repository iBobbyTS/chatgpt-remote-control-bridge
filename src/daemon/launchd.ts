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

/** install：旧服务已加载则 bootout（真实失败报错），随后 bootstrap（幂等刷新，带重试）。 */
export function commandsForInstall(ctx: LaunchdContext, loadedOld: boolean): LaunchctlStep[] {
  const steps: LaunchctlStep[] = [];
  if (loadedOld) {
    steps.push({ args: ["bootout", serviceTarget(ctx)] });
  }
  steps.push({ args: ["bootstrap", `gui/${ctx.uid}`, plistPath(ctx.home, ctx.env)], retries: 5 });
  return steps;
}

/** uninstall：已加载则 bootout（真实失败报错）；plist 删除由调用方在成功后执行。 */
export function commandsForUninstall(ctx: LaunchdContext, loaded: boolean): LaunchctlStep[] {
  return loaded ? [{ args: ["bootout", serviceTarget(ctx)] }] : [];
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

/** stop：已加载则 bootout；未加载 = 幂等成功（空序列）。 */
export function commandsForStop(ctx: LaunchdContext, loaded: boolean): LaunchctlStep[] {
  return loaded ? [{ args: ["bootout", serviceTarget(ctx)] }] : [];
}

/** restart：stop → start（stop 后必未加载，故 start 走 bootstrap+kickstart）。 */
export function commandsForRestart(ctx: LaunchdContext, loaded: boolean): LaunchctlStep[] {
  return [...commandsForStop(ctx, loaded), ...commandsForStart(ctx, false)];
}

// ------------------------------------------------------------- launchctl print

export interface LaunchctlStatus {
  /** true=已加载；false=确认未加载；null=状态未知（print 非零但非"未加载"，如权限错误）。 */
  loaded: boolean | null;
  pid: number | null;
  state: string | null;
  lastExitCode: number | null;
}

/** 解析 `launchctl print` 文本（pid/state/last exit code）。 */
export function parseLaunchctlPrint(text: string): Omit<LaunchctlStatus, "loaded"> {
  const pidMatch = text.match(/^\s*pid = (\d+)\s*$/m);
  const stateMatch = text.match(/^\s*state = (\S+)\s*$/m);
  // 兼容 `last exit code = 0` / `= -15 (signal)`；`= (never exited)` 无数字 → null
  const exitMatch = text.match(/^\s*last exit code = (-?\d+)(?:\s*\([^)]*\))?\s*$/m);
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
  private readonly unloadTimeoutMs: number;

  constructor(
    private readonly ctx: LaunchdContext,
    private readonly run: LaunchctlRunner = defaultLaunchctlRunner,
    private readonly log: (line: string) => void = () => {},
    opts: { unloadTimeoutMs?: number } = {},
  ) {
    this.unloadTimeoutMs = opts.unloadTimeoutMs ?? 3000;
  }

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
    }
  }

  /**
   * `launchctl print` 三态：exit 0 → loaded；非零且输出含"找不到服务"特征 → not-loaded；
   * 其他非零（权限/执行错误等）→ unknown（**保守视为仍加载**，不得当假成功）。
   */
  private async probeLoaded(): Promise<"loaded" | "not-loaded" | "unknown"> {
    const result = await this.run(printStep(this.ctx).args);
    if (result.code === 0) return "loaded";
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (/could not find service|no such process|service not found|could not find domain/.test(text)) {
      return "not-loaded";
    }
    return "unknown";
  }

  /** 轮询直到服务确认未加载（not-loaded）；loaded/unknown 都继续等，超时返回 false。 */
  private async waitUnloaded(timeoutMs = this.unloadTimeoutMs): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.probeLoaded()) === "not-loaded") return true;
      if (Date.now() >= deadline) return false;
      await delay(50);
    }
  }

  /**
   * 若服务已加载则 bootout（B-2：仅"确认未加载"幂等成功；loaded/unknown 都必须 bootout 并
   * 确认卸载，真实失败/卸载超时/状态未知报错）。bootout 失败时再探一次：确认未加载（竞态）也算成功。
   * 返回是否实际执行了 bootout。
   */
  private async stopServiceIfLoaded(): Promise<boolean> {
    if ((await this.probeLoaded()) === "not-loaded") return false;
    const result = await this.run(["bootout", serviceTarget(this.ctx)]);
    if (result.code !== 0) {
      if ((await this.probeLoaded()) === "not-loaded") return true; // 竞态：期间已卸载
      throw new Error(
        `launchctl bootout 失败（exit ${result.code}）：${result.stderr.trim() || "(no stderr)"}`,
      );
    }
    if (!(await this.waitUnloaded())) {
      throw new Error(
        `launchctl bootout 后服务仍未确认卸载（等待 ${this.unloadTimeoutMs}ms 超时；状态未知按仍加载处理）`,
      );
    }
    return true;
  }

  /** 对外：确认已加载才 true（unknown 视为未确认 = false）。 */
  async isLoaded(): Promise<boolean> {
    return (await this.probeLoaded()) === "loaded";
  }

  /** 三态如实呈现：unknown 不折叠为"未加载"（loaded=null）。 */
  async status(): Promise<LaunchctlStatus> {
    const result = await this.run(printStep(this.ctx).args);
    if (result.code === 0) {
      return { loaded: true, ...parseLaunchctlPrint(result.stdout) };
    }
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
    const notLoaded = /could not find service|no such process|service not found|could not find domain/.test(
      text,
    );
    return { loaded: notLoaded ? false : null, pid: null, state: null, lastExitCode: null };
  }

  /** install：写 plist（幂等刷新）→ 旧服务已加载则 bootout（真实失败报错）→ bootstrap。 */
  async install(): Promise<void> {
    await mkdir(dirname(this.plistPath), { recursive: true });
    await mkdir(join(this.ctx.home, "logs"), { recursive: true });
    await writeFile(this.plistPath, buildPlist(this.ctx), { mode: 0o644 });
    // 旧服务已加载则 bootout 并等待卸载（真实失败报错）；bootstrap 另带重试兜底瞬时竞态
    await this.stopServiceIfLoaded();
    await this.execSteps(commandsForInstall(this.ctx, false));
  }

  /** uninstall：先 stop（失败则**不删 plist**），成功后才删除 plist。 */
  async uninstall(): Promise<void> {
    await this.stop();
    await rm(this.plistPath, { force: true });
  }

  /**
   * start 三态保守序：
   * - not-loaded → bootstrap + kickstart；
   * - loaded → 仅 kickstart；
   * - unknown → **先 kickstart**（可能已加载），失败才 bootstrap + kickstart（可能未加载）。
   */
  async start(): Promise<void> {
    const state = await this.probeLoaded();
    if (state === "loaded") {
      await this.execSteps(commandsForStart(this.ctx, true));
      return;
    }
    if (state === "not-loaded") {
      await this.execSteps(commandsForStart(this.ctx, false));
      return;
    }
    // unknown：kickstart 先行，失败再走 bootstrap+kickstart
    const kick = await this.run(["kickstart", "-k", serviceTarget(this.ctx)]);
    if (kick.code === 0) return;
    this.log(
      `launchctl kickstart 失败（exit ${kick.code}）且加载状态未知，回退 bootstrap：${kick.stderr.trim()}`,
    );
    await this.execSteps(commandsForStart(this.ctx, false));
  }

  async stop(): Promise<void> {
    await this.stopServiceIfLoaded();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
