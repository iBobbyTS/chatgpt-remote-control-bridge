/**
 * fs/writeFile 虚拟路径收容（serving-agent 共用；AUD-001 修复沉淀）。
 *
 * 附件目录 `/tmp/codex-remote-attachments/<threadId>/<uuid>/<文件名>` 保留原层级落
 * `files/`；其余绝对路径镜像收进 `files/mirror/`。所有分支必须先做段校验再 join：
 * `join` 会归一化 `..`，不校验即可穿出 files/（历史缺陷：手机端可控 path 以
 * `../../x` 写到任意位置）。
 */

import { join } from "node:path";

/**
 * 手机附件上传目录约定（iOS App 侧命名，codex 源码无此常量）：
 * `/tmp/codex-remote-attachments/<threadId>/<uuid>/<原始文件名>`；先
 * fs/createDirectory 再 fs/writeFile，随后 turn/start 以 UserInput
 * `localImage`/`localAudio`（v2/turn.rs:440-448）引用该路径。
 */
export const ATTACHMENTS_DIR_PREFIX = "/tmp/codex-remote-attachments/";

/** 路径试图逃出收容根目录（调用方应回 JSON-RPC 参数错误，而非落盘）。 */
export class PathEscapeError extends Error {
  constructor(virtualPath: string) {
    super(`path escapes files/ containment: ${virtualPath}`);
    this.name = "PathEscapeError";
  }
}

/** 校验相对段：拒绝空段（尾斜杠/双斜杠）、`.` 与 `..`；返回可用于 join 的段数组。 */
function containedSegments(rel: string): string[] {
  const segments = rel.split("/");
  if (segments.length === 0) throw new PathEscapeError(rel);
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") throw new PathEscapeError(rel);
  }
  return segments;
}

/**
 * 虚拟路径 → files/ 内落盘路径；任何逃逸尝试抛 PathEscapeError。
 * 输入须为绝对路径（fs/writeFile 契约），合法性由调用方先行校验。
 */
export function resolveContainedSavePath(filesDir: string, virtualPath: string): string {
  if (virtualPath.startsWith(ATTACHMENTS_DIR_PREFIX)) {
    return join(filesDir, ...containedSegments(virtualPath.slice(ATTACHMENTS_DIR_PREFIX.length)));
  }
  // 非附件绝对路径 → 单文件名镜像（"/" 全部折叠为 "__"，天然无层级可逃逸）
  const flat = virtualPath.replace(/^\//, "").replace(/\//g, "__");
  if (flat.length === 0 || flat === "." || flat === "..") {
    throw new PathEscapeError(virtualPath);
  }
  return join(filesDir, "mirror", flat);
}
