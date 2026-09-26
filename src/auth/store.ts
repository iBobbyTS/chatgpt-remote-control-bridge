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
import { chmod, link, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
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
  /** 抢占陈旧锁前（模拟"双回收者并发"：让两个回收者同时进入抢占点）。 */
  beforeReclaim?: () => Promise<void> | void;
  /** 还原隔离文件前（模拟"误偷活锁时第三方已取新锁"：注入空缺窗口的新锁）。 */
  beforeRestore?: () => Promise<void> | void;
  /** 心跳 fd 校验属主后、futimes 前（模拟"读后换锁"交错）。 */
  beforeHeartbeat?: () => Promise<void> | void;
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
    raw = await readFile(lockPath, "utf8");
  } catch {
    return null;
  }
  return parseLockPayload(raw);
}

/** 解析锁内容（从字符串；空/半写/非法 → null）。 */
function parseLockPayload(raw: string): AuthLockPayload | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<AuthLockPayload>;
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

/** 抢占/还原用的隔离路径（同目录，rename 原子）。 */
let quarantineCounter = 0;
function quarantinePath(lockPath: string, kind: "reclaim" | "release"): string {
  quarantineCounter += 1;
  return `${lockPath}.${kind}-${process.pid}-${Date.now()}-${quarantineCounter}-${randomBytes(4).toString("hex")}`;
}

type LockView = "live" | "stale" | "gone";

/**
 * 判定锁当前视图（读内容 + mtime 心跳）：
 * - 锁不存在 → gone；
 * - pid 存活且心跳新鲜，或空/半写且心跳新鲜（在途）→ live；
 * - 其余（pid 已死 / 心跳超期）→ stale。
 */
async function lockView(lockPath: string, staleMs: number): Promise<LockView> {
  const payload = await readLockPayload(lockPath);
  const mtime = await lockMtimeMs(lockPath);
  if (mtime === null) return "gone";
  const fresh = Date.now() - mtime <= staleMs;
  if (payload === null) return fresh ? "live" : "stale";
  return isPidAlive(payload.pid) && fresh ? "live" : "stale";
}

/**
 * 把隔离文件**不覆盖式**还原到锁路径：`link(quarantine, lockPath)` + `unlink(quarantine)`。
 * 不用 rename——POSIX rename 会**静默覆盖**第三方在空缺窗口重建的新锁。
 * 错误分类（避免静默留无锁窗口）：
 * - `EEXIST` = 已有第三方新锁 → 不覆盖，删隔离副本，返回 `"taken"`；
 * - `ENOENT` = 隔离文件已不在 → `"taken"`；
 * - `EPERM`/`EIO` 等其他错误 → **保留隔离文件**并重试，仍失败则抛错（绝不静默通过）。
 */
async function restoreQuarantine(
  quarantine: string,
  lockPath: string,
  hooks?: AuthCommitHooks,
): Promise<"restored" | "taken"> {
  await hooks?.beforeRestore?.();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await link(quarantine, lockPath);
      await rm(quarantine, { force: true }).catch(() => {}); // 去掉隔离名（同 inode 的额外链接）
      return "restored";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        await rm(quarantine, { force: true }).catch(() => {});
        return "taken";
      }
      if (code === "ENOENT") {
        return "taken"; // 隔离文件已不存在
      }
      if (attempt >= 2) {
        // 隔离文件保留（供人工/后续重试），显式报错——绝不留无锁窗口静默通过
        throw new Error(
          `auth 锁还原失败（隔离文件保留：${quarantine}）：${code ?? String(err)}`,
        );
      }
      await delay(50 * (attempt + 1));
    }
  }
}

/**
 * rename-steal 抢占陈旧锁（原子，无 read→rm 竞态）：
 * `rename(lockPath, quarantine)` 只有一个调用者能成功；随后**重读偷得文件**验证确属陈旧——
 * 真陈旧 → 删除；实为活锁/在途（竞态中误判）→ 不覆盖式还原并等待。另一调用者 rename 失败
 * （ENOENT，锁已被偷）→ gone，调用方重试。绝不基于旧读取结果直接 rm。
 */
async function stealStaleLock(
  lockPath: string,
  staleMs: number,
  hooks: AuthCommitHooks | undefined,
): Promise<"stolen" | "gone" | "live"> {
  await hooks?.beforeReclaim?.();
  const quarantine = quarantinePath(lockPath, "reclaim");
  try {
    await rename(lockPath, quarantine);
  } catch (err) {
    // ENOENT = 已被他人偷走/释放；其余错误保守按活锁处理（等待，不抢）
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "live";
  }
  const payload = await readLockPayload(quarantine);
  const mtime = await lockMtimeMs(quarantine);
  const fresh = mtime !== null && Date.now() - mtime <= staleMs;
  const live = payload !== null && isPidAlive(payload.pid);
  const inFlightEmpty = payload === null && fresh;
  if ((live && fresh) || inFlightEmpty) {
    await restoreQuarantine(quarantine, lockPath, hooks); // 误判活锁：不覆盖式还原（可能已被接管）
    return "live";
  }
  await rm(quarantine, { force: true }).catch(() => {});
  return "stolen";
}

/**
 * 释放锁（rename 协议）：先把锁文件原子移到隔离路径，**偷到且 owner 匹配才删**；
 * owner 不匹配（说明已被替换）→ 不覆盖式还原，绝不删他人锁。
 */
async function releaseAuthLock(lockPath: string, owner: string): Promise<void> {
  const quarantine = quarantinePath(lockPath, "release");
  try {
    await rename(lockPath, quarantine);
  } catch {
    return; // 锁已不在
  }
  const payload = await readLockPayload(quarantine);
  if (payload?.owner === owner) {
    await rm(quarantine, { force: true }).catch(() => {});
    return;
  }
  await restoreQuarantine(quarantine, lockPath);
}

/** 持有者守卫：临界区真正提交前重读校验所有权，失主即中止（安全失败）。 */
export interface AuthLockGuard {
  assertOwner(): Promise<void>;
}

/** 锁被并发回收/替换导致持有者失主：提交中止（可重试）。 */
export class AuthLockLostError extends Error {
  constructor(lockPath: string) {
    super(`auth 锁已丢失（提交中止，可重试）：${lockPath}`);
    this.name = "AuthLockLostError";
  }
}

/**
 * 持锁执行 `fn`（O_EXCL 锁 + 心跳 + rename-steal 陈旧回收）。等待超时抛错（不误抢活锁）。
 * `fn` 收到 guard：提交前必须 `assertOwner()`，失主则中止（不静默破坏他人提交）。
 */
export async function withAuthLock<T>(
  codexHome: string,
  fn: (guard: AuthLockGuard) => Promise<T>,
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
    const view = await lockView(lockPath, staleMs);
    if (view === "gone") continue; // 锁已消失：立即重试 open
    if (view === "stale") {
      const outcome = await stealStaleLock(lockPath, staleMs, opts.hooks);
      if (outcome === "stolen" || outcome === "gone") continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`获取 auth 锁超时（${timeoutMs}ms，持有者未释放）：${lockPath}`);
    }
    attempts += 1;
    await delay(Math.min(200, 20 * 2 ** Math.min(attempts, 4)));
  }

  const payload: AuthLockPayload = { pid: process.pid, startedAt: Date.now(), owner };
  let heartbeat: NodeJS.Timeout | null = null;
  let wroteLock = false;
  const guard: AuthLockGuard = {
    assertOwner: async () => {
      const current = await readLockPayload(lockPath);
      if (current?.owner !== owner) throw new AuthLockLostError(lockPath);
    },
  };
  try {
    await handle.writeFile(JSON.stringify(payload), "utf8");
    wroteLock = true;
    // 心跳 fd 化（根治 TOCTOU）：open 取 fd → 从**同一 fd** 读内容校验 owner===self
    // → 用 fs.futimes(fd) 更新该 inode 时间。路径若在两步间被替换，命中旧 inode（无害）；
    // owner 不符/打开失败 → 关 fd 停跳，绝不触碰新持有者的锁文件。
    heartbeat = setInterval(() => {
      void (async () => {
        let fh: FileHandle | null = null;
        try {
          fh = await open(lockPath, "r");
          const current = parseLockPayload(await fh.readFile("utf8"));
          if (current?.owner !== owner) {
            if (heartbeat) clearInterval(heartbeat);
            return;
          }
          await opts.hooks?.beforeHeartbeat?.();
          const now = new Date();
          await fh.utimes(now, now); // futimes：作用于已打开的旧 inode
        } catch {
          if (heartbeat) clearInterval(heartbeat); // 锁文件被移除/替换：停跳
        } finally {
          await fh?.close().catch(() => {});
        }
      })();
    }, heartbeatMs);
    heartbeat.unref?.();
    await opts.hooks?.onLockAcquired?.();
    return await fn(guard);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      await handle.close();
    } catch {
      // 忽略关闭异常
    }
    if (wroteLock) await releaseAuthLock(lockPath, owner);
    else await rm(lockPath, { force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------ 三类提交段

/** 登录写入（持锁原子提交；失主中止）。 */
export async function writeAuthStoreLocked(
  codexHome: string,
  auth: AuthDotJson,
  opts: AuthLockOptions = {},
): Promise<void> {
  await withAuthLock(
    codexHome,
    async (guard) => {
      await opts.hooks?.beforeCommit?.();
      await guard.assertOwner();
      await writeAuthStoreAtomic(codexHome, auth);
    },
    opts,
  );
}

/** reset/logout 删除（持锁删除；失主中止，可重试）。 */
export async function deleteAuthStoreLocked(
  codexHome: string,
  opts: AuthLockOptions = {},
): Promise<boolean> {
  return withAuthLock(
    codexHome,
    async (guard) => {
      await opts.hooks?.beforeCommit?.();
      await guard.assertOwner();
      return deleteAuthStore(codexHome);
    },
    opts,
  );
}

export type AuthCommitOutcome =
  | { committed: true; auth: AuthDotJson }
  | { committed: false; reason: "deleted" | "replaced" | "lock-lost" };

/**
 * 刷新提交（持锁内重读校验 + 所有权守卫）：
 * - 磁盘 auth.json 缺失/无 tokens → `deleted`（丢弃，不复活已删除凭证）；
 * - 磁盘 access_token ≠ `baseAccessToken`（被其他刷新替换/新登录覆盖）→ `replaced`（丢弃）；
 * - 提交前失锁（被 rename-steal 回收）→ `lock-lost`（丢弃，不静默覆盖）；
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
    async (guard) => {
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
      try {
        await guard.assertOwner();
      } catch (err) {
        if (err instanceof AuthLockLostError) {
          return { committed: false, reason: "lock-lost" };
        }
        throw err;
      }
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
