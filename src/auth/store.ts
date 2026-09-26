/**
 * auth.json 持久化（对齐 codex-rs/login/src/auth/storage.rs 的 AuthDotJson 格式）。
 *
 * 文件位于 <codexHome>/auth.json，权限 600，原子写入。
 *
 * 跨进程锁（S05 ④）：
 * - `withAuthLock`：`O_EXCL` 锁文件 `<codexHome>/auth.lock`（内容 `{pid, startedAt, owner}`），
 *   心跳=锁文件 mtime（`utimes`，原子、不与内容写竞争）。**陈旧检测**：pid 不存活 或
 *   心跳（mtime）超过 `staleMs` 未更新 → 可安全回收；pid 存活且心跳新鲜 = 持锁进程，
 *   **绝不误伤**（回收前重读内容确认 owner，避免删掉他人新锁）。
 * - 空/半写锁文件在 `staleMs` 内视为"在途"，等待而非回收（对齐 ipc 锁的 fail-safe 语义）。
 *
 * 三类凭证提交共用该锁，关闭 TOCTOU/覆盖窗口：
 * - 登录写入 `writeAuthStoreLocked`；reset 删除 `deleteAuthStoreLocked`；
 * - 刷新提交 `commitAuthRefresh`：网络刷新在**锁外**，仅提交段持锁，且**持锁内重读校验**——
 *   `baseAccessToken` 与磁盘当前 access_token 不一致（已被删除/替换/新登录）即丢弃写回。
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseIdTokenInfo, type IdTokenInfo } from "./jwt.ts";

export interface TokenData {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string | null;
}

/** codex auth.json 顶层结构（serde camelCase/snake_case 按 codex 实际字段名）。 */
export interface AuthDotJson {
  auth_mode: "chatgpt" | "apikey";
  openai_api_key: string | null;
  tokens: TokenData | null;
  last_refresh: string | null;
}

export function authJsonPath(codexHome: string): string {
  return join(codexHome, "auth.json");
}

export async function readAuthStore(
  codexHome: string,
): Promise<AuthDotJson | null> {
  const path = authJsonPath(codexHome);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as AuthDotJson;
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${err}`);
  }
}

/** 原子写（tmp + rename，mode 600）；调用方负责持锁编排。 */
async function writeAuthStoreAtomic(
  codexHome: string,
  auth: AuthDotJson,
): Promise<void> {
  const path = authJsonPath(codexHome);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/**
 * 无锁原子写（测试与不计交错的路径使用）。
 * 生产提交路径（登录/刷新/reset）改用带锁变体。
 */
export async function writeAuthStore(
  codexHome: string,
  auth: AuthDotJson,
): Promise<void> {
  await writeAuthStoreAtomic(codexHome, auth);
}

/** 删除 auth.json；不存在/失败返回 false。 */
export async function deleteAuthStore(codexHome: string): Promise<boolean> {
  const path = authJsonPath(codexHome);
  try {
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- 跨进程锁

export const AUTH_LOCK_FILENAME = "auth.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 30_000;

/** 提交段测试注入钩子（AC7 交错编排；生产不传）。 */
export interface AuthCommitHooks {
  /** 取锁之前（模拟"删除/新登录先取得提交锁"：把刷新挡在取锁前）。 */
  beforeLock?: () => Promise<void> | void;
  /** 取锁成功后、临界区前（模拟"刷新持锁期间发起 reset"：让 reset 等本持锁者）。 */
  onLockAcquired?: () => Promise<void> | void;
  /** 临界区内、写盘/删除前。 */
  beforeCommit?: () => Promise<void> | void;
}

export interface AuthLockOptions {
  /** 取锁等待上限；默认 10s。 */
  timeoutMs?: number;
  /** 陈旧阈值（心跳缺席多久可回收）；默认 30s。 */
  staleMs?: number;
  /** 心跳周期；默认 staleMs/3。 */
  heartbeatMs?: number;
  hooks?: AuthCommitHooks;
}

export function authLockPath(codexHome: string): string {
  return join(codexHome, AUTH_LOCK_FILENAME);
}

interface AuthLockPayload {
  pid: number;
  startedAt: number;
  owner: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 存在但无权限，视为存活
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockPayload(lockPath: string): Promise<AuthLockPayload | null> {
  let raw: string;
  try {
    raw = (await readFile(lockPath, "utf8")).trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthLockPayload>;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Number.isInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.owner === "string"
    ) {
      return {
        pid: parsed.pid as number,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
        owner: parsed.owner,
      };
    }
  } catch {
    // 空/半写
  }
  return null;
}

async function lockMtimeMs(lockPath: string): Promise<number | null> {
  try {
    return (await stat(lockPath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 回收陈旧锁：重读确认"仍陈旧"后再删（防删掉他人新锁）。
 * - 锁不存在 → true（已可继续）；
 * - 解析失败但心跳新鲜 → false（在途，等待）；
 * - pid 存活且心跳新鲜 → false（活持有者，**绝不误伤**）；
 * - 其余（pid 已死 / 心跳超期）→ 删除，true。
 */
async function tryReclaimStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const payload = await readLockPayload(lockPath);
  const mtime = await lockMtimeMs(lockPath);
  if (mtime === null) return true; // 锁已消失
  const fresh = Date.now() - mtime <= staleMs;
  if (fresh && (payload === null || isPidAlive(payload.pid))) return false;
  await rm(lockPath, { force: true }).catch(() => {});
  return true;
}

async function releaseAuthLock(lockPath: string, owner: string): Promise<void> {
  const payload = await readLockPayload(lockPath);
  if (payload?.owner !== owner) return; // 已被替换/移除：勿删他人锁
  await rm(lockPath, { force: true }).catch(() => {});
}

/**
 * 持锁执行 `fn`（O_EXCL 锁 + 心跳 + 陈旧回收）。等待超时抛错（不误抢活锁）。
 */
export async function withAuthLock<T>(
  codexHome: string,
  fn: () => Promise<T>,
  opts: AuthLockOptions = {},
): Promise<T> {
  const lockPath = authLockPath(codexHome);
  await mkdir(codexHome, { recursive: true });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const heartbeatMs = opts.heartbeatMs ?? Math.max(200, Math.floor(staleMs / 3));
  const owner = `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await opts.hooks?.beforeLock?.();

  const deadline = Date.now() + timeoutMs;
  let handle: FileHandle | null = null;
  let attempts = 0;
  for (;;) {
    try {
      handle = await open(lockPath, "wx", 0o600); // O_CREAT|O_EXCL：已存在即 EEXIST
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const payload = await readLockPayload(lockPath);
    const mtime = await lockMtimeMs(lockPath);
    const fresh = mtime !== null && Date.now() - mtime <= staleMs;
    const liveHolder = payload !== null && isPidAlive(payload.pid);
    const inFlightEmpty = payload === null && fresh;
    if (!(liveHolder && fresh) && !inFlightEmpty) {
      if (await tryReclaimStaleLock(lockPath, staleMs)) continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`获取 auth 锁超时（${timeoutMs}ms，持有者未释放）：${lockPath}`);
    }
    attempts += 1;
    await delay(Math.min(200, 20 * 2 ** Math.min(attempts, 4)));
  }

  const payload: AuthLockPayload = { pid: process.pid, startedAt: Date.now(), owner };
  let heartbeat: NodeJS.Timeout | null = null;
  try {
    await handle.writeFile(JSON.stringify(payload), "utf8");
    // 心跳=mtime（utimes 原子，不与内容读写竞争，避免半写窗口）
    heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lockPath, now, now).catch(() => {});
    }, heartbeatMs);
    heartbeat.unref?.();
    await opts.hooks?.onLockAcquired?.();
    return await fn();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      await handle.close();
    } catch {
      // 忽略关闭异常
    }
    await releaseAuthLock(lockPath, owner);
  }
}

// ------------------------------------------------------------ 三类提交段

/** 登录写入（持锁原子提交）。 */
export async function writeAuthStoreLocked(
  codexHome: string,
  auth: AuthDotJson,
  opts: AuthLockOptions = {},
): Promise<void> {
  await withAuthLock(
    codexHome,
    async () => {
      await opts.hooks?.beforeCommit?.();
      await writeAuthStoreAtomic(codexHome, auth);
    },
    opts,
  );
}

/** reset/logout 删除（持锁删除）。 */
export async function deleteAuthStoreLocked(
  codexHome: string,
  opts: AuthLockOptions = {},
): Promise<boolean> {
  return withAuthLock(
    codexHome,
    async () => {
      await opts.hooks?.beforeCommit?.();
      return deleteAuthStore(codexHome);
    },
    opts,
  );
}

export type AuthCommitOutcome =
  | { committed: true; auth: AuthDotJson }
  | { committed: false; reason: "deleted" | "replaced" };

/**
 * 刷新提交（持锁内重读校验）：
 * - 磁盘 auth.json 缺失/无 tokens → `deleted`（丢弃，不复活已删除凭证）；
 * - 磁盘 access_token ≠ `baseAccessToken`（被其他刷新替换/新登录覆盖）→ `replaced`（丢弃）；
 * - 否则 `build(current)` 原子写回，返回 committed。
 */
export async function commitAuthRefresh(
  codexHome: string,
  args: {
    /** 发起网络刷新时的 access_token 快照。 */
    baseAccessToken: string;
    build: (current: AuthDotJson) => AuthDotJson;
  },
  opts: AuthLockOptions = {},
): Promise<AuthCommitOutcome> {
  return withAuthLock(
    codexHome,
    async () => {
      let current: AuthDotJson | null;
      try {
        current = await readAuthStore(codexHome);
      } catch {
        // 磁盘损坏：无法校验身份，丢弃写回（不盲目覆盖）
        return { committed: false, reason: "replaced" };
      }
      if (!current?.tokens?.access_token) {
        return { committed: false, reason: "deleted" };
      }
      if (current.tokens.access_token !== args.baseAccessToken) {
        return { committed: false, reason: "replaced" };
      }
      await opts.hooks?.beforeCommit?.();
      const next = args.build(current);
      await writeAuthStoreAtomic(codexHome, next);
      return { committed: true, auth: next };
    },
    opts,
  );
}

/** id_token claims + account_id 的组合视图（登录与刷新后都会用到）。 */
export function describeTokens(tokens: TokenData): {
  idTokenInfo: IdTokenInfo;
  accountId: string | null;
} {
  const idTokenInfo = parseIdTokenInfo(tokens.id_token);
  return {
    idTokenInfo,
    accountId: idTokenInfo.chatgptAccountId ?? tokens.account_id ?? null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
