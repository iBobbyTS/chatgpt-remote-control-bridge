/**
 * sim 虚拟文件系统覆盖层（从 appServer.ts 拆出，AUD-009）。
 *
 * 职责：
 * - `fs/writeFile` 上传收容落盘（共享助手 src/agents/files.ts，AUD-001）与回读；
 * - 虚拟目录覆盖层（fs/createDirectory、脚本 mkdir 仿真共用，不落盘）；
 * - `fs/readDirectory` / `fs/getMetadata` 直接透传真实主机路径（**codex 同款
 *   语义**：手机文件夹选择器/附件引用需要真实 stat/readdir；sim 只回元数据，
 *   文件内容仅回读自己落盘的上传——见 AUD-008 决定记录）；
 * - 附件回执收集（上传记录 + localImage/localAudio 引用对账，图片跑 exiftool）。
 *
 * 生命周期：覆盖层与上传记录是进程级状态，跨 reset 保留（appServer resetToSeed
 * 的既有语义——reset 只重置会话库，不清理 FS 模拟态）。
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  ATTACHMENTS_DIR_PREFIX,
  resolveContainedSavePath,
} from "../files.ts";
import { SimMethodError, type AnyParams } from "./protocol.ts";

/** 按扩展名判定图片（决定是否执行 exiftool）。 */
const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "jfif", "png", "heic", "heif", "avif", "webp", "gif", "tif", "tiff", "bmp", "jxl", "svg",
]);
function isImagePath(path: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m != null && IMAGE_EXTENSIONS.has(m[1]!.toLowerCase());
}

const execFileP = promisify(execFile);
/** daemon 环境 PATH 可能缺 /opt/homebrew/bin，exiftool 逐候选回退。 */
const EXIFTOOL_CANDIDATES = [
  process.env.EXIFTOOL_PATH,
  "exiftool",
  "/opt/homebrew/bin/exiftool",
  "/usr/local/bin/exiftool",
].filter((v): v is string => typeof v === "string" && v.length > 0);

/**
 * 校验标准 base64（长度 4 倍数、至多 2 个结尾 =、字符集 [A-Za-z0-9+/]）。
 * 线性扫描而非正则——分组量词正则（如 (?:…{4})*）在 V8 中按次递归回溯，
 * 8MB 文件的 ~11MB base64 会直接 Maximum call stack size exceeded
 * （真机 2026-09-27T05:58Z 复现），charCodeAt 循环为 O(n) 常数栈。
 */
export function isValidBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  let end = s.length;
  if (s[end - 1] === "=") end -= 1;
  if (s[end - 1] === "=") end -= 1;
  if (s.length - end > 2) return false;
  for (let i = 0; i < end; i++) {
    const c = s.charCodeAt(i);
    if (
      !(c >= 65 && c <= 90) && !(c >= 97 && c <= 122) &&
      !(c >= 48 && c <= 57) && c !== 43 && c !== 47
    ) {
      return false;
    }
  }
  return true;
}

/** 执行 exiftool 取全量元数据文本；失败（缺二进制/无法识别）返回 null。 */
async function runExiftool(file: string): Promise<string | null> {
  for (const bin of EXIFTOOL_CANDIDATES) {
    try {
      const { stdout } = await execFileP(bin, [file], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
      const text = stdout.trim();
      if (text) return text;
    } catch {
      // 试下一个候选路径
    }
  }
  return null;
}

/** fs/writeFile 上传记录：虚拟路径（手机可见）→ files/ 内落盘信息（进程内映射）。 */
export interface UploadedFileRecord {
  virtualPath: string;
  savedPath: string;
  /** 从附件路径解析出的线程 ID（非附件目录上传为 null）。 */
  threadId: string | null;
  sizeBytes: number;
  /** 图片上传时预跑的 exiftool 全量输出；非图片 / 失败为 null。 */
  exiftool: string | null;
  /** 是否已在某条回复中回执过（每文件只回执一次）。 */
  echoed: boolean;
}

/** 回复中回执的附件条目。 */
export type AttachmentEcho =
  | { kind: "image"; path: string; sizeBytes: number; exiftool: string | null }
  | { kind: "file"; path: string; sizeBytes: number }
  | { kind: "missing"; path: string };

/** 附件回执渲染：图片附 exiftool 全量输出，其他文件给保存路径。 */
export function renderAttachment(a: AttachmentEcho): string {
  if (a.kind === "missing") {
    return `- 附件未找到：${a.path}`;
  }
  const size = `${(a.sizeBytes / 1024).toFixed(1)} KB`;
  if (a.kind === "image") {
    return (
      `- 图片已保存：${a.path}（${size}）\nexiftool 完整信息：\n` +
      (a.exiftool ?? "（exiftool 执行失败或不可用）")
    );
  }
  return `- 文件已保存：${a.path}（${size}）`;
}

export interface VirtualFsOptions {
  /** 上传落盘根目录（<CGRCB_HOME>/files）。 */
  filesDir: string;
  log?: (line: string) => void;
}

export class VirtualFs {
  /** 虚拟目录覆盖层：绝对路径 → 存在的目录（模拟 mkdir，不落盘）。 */
  private readonly overlayDirs = new Set<string>();
  private readonly overlayChildren = new Map<string, Set<string>>();
  /** fs/writeFile 上传记录：手机可见虚拟路径 → files/ 内落盘信息。 */
  private readonly overlayFiles = new Map<string, UploadedFileRecord>();
  private readonly filesDir: string;
  private readonly log?: (line: string) => void;

  constructor(opts: VirtualFsOptions) {
    this.filesDir = opts.filesDir;
    this.log = opts.log;
  }

  /** 覆盖层 mkdir -p（shell 仿真任务目录脚本共用）。 */
  mkdirOverlay(path: string | undefined): void {
    if (!path) return;
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    const segments = expanded.replace(/^\//, "").split("/").filter(Boolean);
    let prev = "";
    for (let i = 0; i < segments.length; i++) {
      const current = `/${segments.slice(0, i + 1).join("/")}`;
      this.overlayDirs.add(current);
      if (prev) {
        const children = this.overlayChildren.get(prev) ?? new Set<string>();
        children.add(segments[i]!);
        this.overlayChildren.set(prev, children);
      }
      prev = current;
    }
  }

  /** 覆盖层目录存在性（任务目录脚本的去重探测共用）。 */
  hasDir(path: string): boolean {
    return this.overlayDirs.has(path);
  }

  /** fs/readDirectory（真实目录 + 覆盖层合并视图；任意主机路径，codex 同款语义）。 */
  async listDirectory(path: string): Promise<unknown> {
    if (!path) throw new SimMethodError(-32602, "missing path");
    const names = new Map<string, boolean>(); // name → isDirectory
    let exists = this.overlayDirs.has(path);
    try {
      const entries = await readdir(path, { withFileTypes: true });
      exists = true;
      for (const e of entries) {
        names.set(e.name, e.isDirectory());
      }
    } catch {
      // 真实目录不存在：仅用覆盖层
    }
    for (const child of this.overlayChildren.get(path) ?? []) {
      names.set(child, this.overlayDirs.has(join(path, child)));
    }
    for (const virtual of this.overlayFiles.keys()) {
      if (dirname(virtual) === path) {
        names.set(basename(virtual), false);
      }
    }
    if (!exists) {
      exists = [...this.overlayFiles.keys()].some((v) => v.startsWith(`${path}/`));
    }
    if (!exists) {
      throw new SimMethodError(-32000, `readDirectory: ${path}: no such file or directory`);
    }
    return {
      entries: [...names.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([fileName, isDirectory]) => ({ fileName, isDirectory, isFile: !isDirectory })),
    };
  }

  /** fs/getMetadata（真实 stat，整毫秒时间戳保手机 Swift 解码；覆盖层兜底）。 */
  async getMetadata(path: string): Promise<unknown> {
    try {
      const s = await stat(path);
      return {
        isDirectory: s.isDirectory(),
        isFile: s.isFile(),
        isSymlink: s.isSymbolicLink(),
        // 真实 codex（Rust）返回整毫秒；Node stat 的纳秒精度带小数，
        // 手机 Swift 解码器按整数解码小数毫秒即「无法解码Codex响应」
        // （2026-09-25 真机复现：仅时间戳恰为整秒的目录能显示）
        createdAtMs: Math.round(s.birthtimeMs),
        modifiedAtMs: Math.round(s.mtimeMs),
      };
    } catch {
      const uploaded = this.overlayFiles.get(path);
      if (uploaded) {
        const s = await stat(uploaded.savedPath).catch(() => null);
        return {
          isDirectory: false,
          isFile: true,
          isSymlink: false,
          createdAtMs: Math.round(s?.birthtimeMs ?? 0),
          modifiedAtMs: Math.round(s?.mtimeMs ?? 0),
        };
      }
      if (this.overlayDirs.has(path)) {
        const now = Date.now();
        return { isDirectory: true, isFile: false, isSymlink: false, createdAtMs: now, modifiedAtMs: now };
      }
      throw new SimMethodError(-32000, `getMetadata: ${path}: no such file or directory`);
    }
  }

  /**
   * fs/writeFile（v2/fs.rs:29-40）：{path, dataBase64} → 收容落盘返回 {}。
   * 错误对齐 codex fs_processor.write_file：坏 base64 → -32600，非法/越界路径 →
   * -32602，IO 失败 → -32603。图片（按扩展名）同步跑 exiftool 缓存全量输出。
   */
  async writeFile(p: AnyParams): Promise<unknown> {
    const path = typeof p.path === "string" ? p.path : "";
    if (!path.startsWith("/")) {
      throw new SimMethodError(-32602, "fs/writeFile requires an absolute path");
    }
    const data = p.dataBase64;
    if (typeof data !== "string" || !isValidBase64(data)) {
      throw new SimMethodError(-32600, "fs/writeFile requires valid base64 dataBase64: Invalid byte");
    }
    const bytes = Buffer.from(data, "base64");
    let savedPath: string;
    try {
      savedPath = resolveContainedSavePath(this.filesDir, path);
    } catch (err) {
      throw new SimMethodError(-32602, `fs/writeFile: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await mkdir(dirname(savedPath), { recursive: true });
      await writeFile(savedPath, bytes);
    } catch (err) {
      throw new SimMethodError(-32603, `fs/writeFile: ${err instanceof Error ? err.message : String(err)}`);
    }
    const record: UploadedFileRecord = {
      virtualPath: path,
      savedPath,
      threadId: path.startsWith(ATTACHMENTS_DIR_PREFIX)
        ? path.slice(ATTACHMENTS_DIR_PREFIX.length).split("/")[0] || null
        : null,
      sizeBytes: bytes.length,
      exiftool: null,
      echoed: false,
    };
    if (isImagePath(path)) {
      record.exiftool = await runExiftool(savedPath);
    }
    this.overlayFiles.set(path, record);
    this.log?.(`附件已保存：${path} → ${savedPath}（${bytes.length} B${record.exiftool != null ? "，exiftool ✓" : ""}）`);
    return {};
  }

  /**
   * fs/readFile（v2/fs.rs:11-23）：仅回读 sim 自己落盘的上传文件——手机流程
   * 只回读附件；不开放任意主机路径读取。
   */
  async readFile(p: AnyParams): Promise<unknown> {
    const path = typeof p.path === "string" ? p.path : "";
    const record = this.overlayFiles.get(path);
    if (!record) {
      throw new SimMethodError(-32000, `readFile: ${path}: no such file or directory`);
    }
    const data = await readFile(record.savedPath);
    return { dataBase64: data.toString("base64") };
  }

  /**
   * 收集本 turn 回复要回执的附件：
   * ① 本线程未回显的上传（附件路径含 threadId——上传与发送之间无引用也保证有回执）；
   * ② 输入项 localImage/localAudio（v2/turn.rs:440-448）显式引用的路径：已上传
   * 则对账落盘文件；未上传但真实存在则按主机文件处理（codex LocalImage 语义
   * 即读取该路径）；不存在报「未找到」。
   */
  async collectEchoes(threadId: string, rawInput: unknown[] | undefined): Promise<AttachmentEcho[]> {
    const echoes: AttachmentEcho[] = [];
    const seen = new Set<string>();
    for (const record of this.overlayFiles.values()) {
      if (record.threadId === threadId && !record.echoed) {
        record.echoed = true;
        seen.add(record.virtualPath);
        echoes.push(this.echoOfRecord(record));
      }
    }
    for (const item of rawInput ?? []) {
      if (!item || typeof item !== "object") continue;
      const e = item as { type?: unknown; path?: unknown };
      if (e.type !== "localImage" && e.type !== "localAudio") continue;
      if (typeof e.path !== "string" || seen.has(e.path)) continue;
      const record = this.overlayFiles.get(e.path);
      if (record) {
        record.echoed = true;
        seen.add(record.virtualPath);
        echoes.push(this.echoOfRecord(record));
        continue;
      }
      seen.add(e.path);
      const s = await stat(e.path).catch(() => null);
      if (s?.isFile() !== true) {
        echoes.push({ kind: "missing", path: e.path });
      } else if (isImagePath(e.path)) {
        echoes.push({ kind: "image", path: e.path, sizeBytes: s.size, exiftool: await runExiftool(e.path) });
      } else {
        echoes.push({ kind: "file", path: e.path, sizeBytes: s.size });
      }
    }
    return echoes;
  }

  private echoOfRecord(record: UploadedFileRecord): AttachmentEcho {
    return isImagePath(record.virtualPath)
      ? { kind: "image", path: record.savedPath, sizeBytes: record.sizeBytes, exiftool: record.exiftool }
      : { kind: "file", path: record.savedPath, sizeBytes: record.sizeBytes };
  }
}
