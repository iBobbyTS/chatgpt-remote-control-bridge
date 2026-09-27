/**
 * 有界日志维护（AUD-002/AUD-010，GP-001：远程字节流落盘必须有界）。
 *
 * - `rotateLogIfLarge`：rename 轮转，适用于**每次写入都重新 open** 的日志
 *   （frames.jsonl 走 appendFile）；单代保留 `.1`，rename 覆盖旧代为原子替换。
 * - `truncateLogIfLarge`：原地截断，适用于**外部进程持有 fd** 的日志
 *   （launchd StandardOut/ErrPath）；launchd 以 O_APPEND 打开，截断后下次写回到
 *   新文件尾，不留空洞。
 * 两者的 stat 失败（文件不存在）一律静默返回 `absent`，维护本身不得影响日志写入。
 */
import { chmod, rename, stat, truncate } from "node:fs/promises";

/** 默认单日志上限（64MB：帧日志实测 ~200MB/天，上限内保留足够真机排障窗口）。 */
export const DEFAULT_LOG_CAP_BYTES = 64 * 1024 * 1024;

export type LogMaintainOutcome = "rotated" | "truncated" | "kept" | "absent";

export interface RotateLogOptions {
  capBytes?: number;
  /** 维护顺带把权限收敛到该 mode（修正历史 0644 遗留；尽力而为）。 */
  mode?: number;
}

/** 超限则 rename 为 `<path>.1`（覆盖上一代）；可选顺带收敛权限。 */
export async function rotateLogIfLarge(
  path: string,
  opts: RotateLogOptions = {},
): Promise<LogMaintainOutcome> {
  const capBytes = opts.capBytes ?? DEFAULT_LOG_CAP_BYTES;
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return "absent";
  }
  if (opts.mode !== undefined) {
    await chmod(path, opts.mode).catch(() => undefined);
  }
  if (size <= capBytes) return "kept";
  await rename(path, `${path}.1`);
  return "rotated";
}

/** 超限则原地截断为 0（调用方须确认写入方以 O_APPEND 持有 fd）。 */
export async function truncateLogIfLarge(
  path: string,
  capBytes: number = DEFAULT_LOG_CAP_BYTES,
): Promise<LogMaintainOutcome> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return "absent";
  }
  if (size <= capBytes) return "kept";
  await truncate(path);
  return "truncated";
}
