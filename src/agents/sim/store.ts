/**
 * sim 会话库（state.json）的纯文件操作（S03 ②③）：
 * - `simInit(instanceDir)`：store 未初始化（文件缺失/损坏/无任何线程）时播种 fixedThreads；
 *   已初始化则 no-op（幂等，绝不覆盖用户线程）。
 * - `simReset(instanceDir)`：清空 store 文件后立即重新播种（结果与全新 init 语义等价）。
 *   **只动 state.json**——installation_id/enrollment.json/pairing.json/lifecycle.json 一律不碰。
 *
 * 文件格式与 SimApp.persistState 一致：`[{thread, items}, …]`，供 SimApp 构造时 loadStateSync 读取。
 * 播种线程 id/时间戳为随机的（fixedThreads 现形状），故“等价”指结构与语义等价而非字节相同。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fixedThreads, type ItemEntry, type ThreadRecord } from "./data.ts";

/** 实例目录内的会话库文件名（与 daemon paths.STATE_FILENAME 同值）。 */
export const SIM_STATE_FILENAME = "state.json";

export interface SimStoreEntry {
  thread: ThreadRecord;
  items: ItemEntry[];
}

/** 实例会话库路径。 */
export function simStatePath(instanceDir: string): string {
  return join(instanceDir, SIM_STATE_FILENAME);
}

/** 播种线程快照（fixedThreads 的数组形式，与 persistState 落盘形状一致）。 */
function seedEntries(): SimStoreEntry[] {
  return [...fixedThreads().values()].map(({ thread, items }) => ({ thread, items }));
}

/** 读取 store 中的线程条目；文件缺失/损坏/非数组 → null。 */
async function readEntries(statePath: string): Promise<SimStoreEntry[] | null> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (e): e is SimStoreEntry =>
        e !== null && typeof e === "object" && typeof (e as { thread?: { id?: unknown } }).thread?.id === "string",
    );
  } catch {
    return null;
  }
}

/** store 是否已初始化（存在至少一个带 id 的线程条目）。 */
export async function simStoreInitialized(instanceDir: string): Promise<boolean> {
  const entries = await readEntries(simStatePath(instanceDir));
  return entries !== null && entries.length > 0;
}

/** 原子写播种态（tmp + rename），避免读方看到半写文件。 */
async function writeSeed(instanceDir: string): Promise<void> {
  const statePath = simStatePath(instanceDir);
  await mkdir(instanceDir, { recursive: true });
  const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(seedEntries()), { mode: 0o600 });
  await rename(tmp, statePath);
}

/**
 * 若会话库未初始化则播种 fixedThreads；已初始化直接返回（幂等）。
 * 返回是否执行了播种（测试/日志可见）。
 */
export async function simInit(instanceDir: string): Promise<boolean> {
  if (await simStoreInitialized(instanceDir)) {
    return false;
  }
  await writeSeed(instanceDir);
  return true;
}

/** 清空会话库并立即重新播种（与全新 init 结果语义等价）。不触碰实例身份文件。 */
export async function simReset(instanceDir: string): Promise<void> {
  await mkdir(instanceDir, { recursive: true });
  await rm(simStatePath(instanceDir), { force: true });
  await writeSeed(instanceDir);
}
