/**
 * sim 进程/命令脚本仿真（从 appServer.ts 拆出，AUD-009）。
 *
 * process/spawn 与 command/exec 共用的脚本模式仿真（**不真正执行**）。
 * 已知模式按真机语义应答：任务目录 mkdir（覆盖层 + 路径应答）、HOME 探测、
 * draft git 探测（非 git 目录形状）、其他 mkdir 登记覆盖层、周期 workspace-diff
 * 静默空应答；未识别脚本留痕后空 stdout / exit 0 兜底。
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { VirtualFs } from "./fsOverlay.ts";

export interface EmulatedShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * codex 沙箱包装（read-only / workspace-write 同形）：
 * ["/bin/sh","-c","printf '\0'; exec \"$@\"",<wrapper>,"/bin/sh","-lc",<内层脚本>]
 * ——外壳先输出 NUL 再 exec 内层，仿真保持同形状输出。
 */
export function unwrapSandboxCommand(
  command: string[],
): { script: string; nulPrefix: boolean } {
  if (
    command.length === 7 && command[1] === "-c" && command[5] === "-lc" &&
    typeof command[2] === "string" && typeof command[6] === "string" &&
    command[2].includes("exec \"$@\"")
  ) {
    return { script: command[6], nulPrefix: command[2].includes("printf '\\0'") };
  }
  return { script: command.join(" "), nulPrefix: false };
}

export function emulateShellScript(
  script: string,
  env: Record<string, unknown> | undefined,
  fs: VirtualFs,
  log?: (line: string) => void,
): EmulatedShellResult {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const taskDir = emulateTaskDirMkdir(script, env, fs);
  if (taskDir) {
    // 手机端新建任务：解析 stdout 拿任务目录路径（真实脚本 printf candidate）
    stdout = `${taskDir}\n`;
  } else if (script.includes('cd "$HOME" && pwd -P')) {
    // 工作文件夹选择器入口：手机靠该脚本拿 HOME 物理路径，空 stdout 会让
    // 选择器直接判「远程文件夹加载失败」（2026-09-25 真机复现，docs/research/07）
    stdout = `${realpathSync(homedir())}\n`;
  } else if (script.includes("CODEX_DRAFT_OUTPUT_CURRENT")) {
    // 选中目录后的 git 分支探测（draft/分支选择）。手机可接受「非 git 目录」
    // 形状并继续 thread/start（真实抓包 2026-09-25T19:23:04Z）；CODEX_DRAFT_OUTPUT_*
    // 标记值由 codex 进程注入、抓包未能观测到，故 git 仓库目录也按此形状应答
    // （draft 分支列表不可用，不影响文件夹选择本身）。
    exitCode = 128;
    stderr = "fatal: not a git repository (or any of the parent directories): .git\n";
  } else if (/\bmkdir\b/.test(script)) {
    // 其他 mkdir：登记到覆盖层，不真正执行
    for (const m of script.matchAll(/\bmkdir\s+(?:-[a-zA-Z]+\s+)*(~[^\s'";|&]+|\/[^\s'";|&]+)/g)) {
      fs.mkdirOverlay(m[1]);
    }
  } else if (!script.includes("collecting a workspace diff")) {
    // 周期性 workspace-diff 快照不记日志（约 30s 一次会刷屏）；其余未识别脚本
    // 留痕，便于真机出现新脚本模式时定位（当前以空 stdout / exit 0 兜底应答）
    log?.(`exec 未识别脚本（空 stdout 应答）: ${script.slice(0, 80)}`);
  }
  return { stdout, stderr, exitCode };
}

/**
 * 识别手机端「新建任务目录」脚本并返回应答路径，同时在覆盖层创建目录：
 * - 旧版（≤1.2026.251）：root="${HOME}/Documents/Codex" 硬编码在脚本文本里；
 * - 新版（1.2026.258）：root="$CODEX_PROJECTLESS_ROOT"（env 注入根目录），
 *   base 取消息文本（如 base="hi"），重名加 -N 后缀，应答 printf candidate。
 */
export function emulateTaskDirMkdir(
  script: string,
  env: Record<string, unknown> | undefined,
  fs: VirtualFs,
): string | null {
  if (!/\bbase="([^"]+)"/.test(script)) {
    return null;
  }
  let root: string | null = null;
  if (script.includes('root="$CODEX_PROJECTLESS_ROOT"')) {
    const fromEnv = env?.CODEX_PROJECTLESS_ROOT;
    root = typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : `${homedir()}/Documents/Codex`;
  } else if (script.includes("Documents/Codex")) {
    root = `${homedir()}/Documents/Codex`;
  }
  if (!root) {
    return null;
  }
  const base = script.match(/\bbase="([^"]+)"/)![1]!;
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const dateDir = `${root}/${yyyy}-${mm}-${dd}`;
  fs.mkdirOverlay(dateDir);
  let candidate = `${dateDir}/${base}`;
  let index = 1;
  while (fs.hasDir(candidate)) {
    index += 1;
    candidate = `${dateDir}/${base}-${index}`;
  }
  fs.mkdirOverlay(candidate);
  return candidate;
}
