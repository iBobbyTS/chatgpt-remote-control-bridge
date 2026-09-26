/**
 * 本地 IPC（PLAN S02 ④ / 边界 3）：`<root>/daemon.sock` unix socket + JSON 行协议。
 *
 * 请求：`{op, agent?}`（单行 JSON）→ 响应：`{ok:true, data}` 或
 * `{ok:false, error, message?}`（单行 JSON）。S05 CLI 经此与运行中 daemon 协作。
 *
 * 本模块只承载协议类型、服务端监听与客户端封装；业务 handler 由 CgrcbDaemon 注入，
 * 因此 ipc.ts 不依赖 daemon.ts（无环）。
 *
 * 单实例互斥（BLOCKER 4 + 二波 B-2/B-3/B-4）：
 * - **原子发布**锁文件 `<socketPath>.lock`：先写唯一临时文件，再 `link(2)` 到锁路径
 *   （失败 EEXIST = 已被占）。空/不可解析锁一律视为"在途/未知"，短重试后 fail-safe 拒绝，
 *   绝不当陈旧删除（避免 link 前空文件窗口竞态造成双持有）。
 * - 锁内容 `{pid, startedAt}`：startedAt 为进程启动身份（macOS `ps -o lstart= -p`）。
 *   pid 存活但启动身份不符 = pid 复用 → 孤儿锁，回收；身份相符/不可得且无 socket →
 *   宽限重试后按孤儿锁回收（"daemon 存活必有 socket"不变量）。
 * - **socket 探测保守化**：仅 ECONNREFUSED/ENOENT 判死可清理；EACCES/其他错误/超时
 *   一律抛错拒绝接管，绝不删除他人的活 socket。
 */
import { spawn } from "node:child_process";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { AuthStatus } from "../auth/manager.ts";
import { assertSocketPathFits } from "./paths.ts";

export type IpcOp =
  | "status"
  | "enable"
  | "disable"
  | "pair"
  | "pair-status"
  | "agent-init"
  | "agent-reset"
  | "agent-status"
  | "auth-reset";

export type IpcErrorCode =
  | "DAEMON_BUSY"
  | "NOT_LOGGED_IN"
  | "UNKNOWN_AGENT"
  | "PAIRING_PENDING"
  | "INTERNAL";

export interface IpcRequest {
  op: IpcOp;
  agent?: string;
}

export type IpcResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: IpcErrorCode; message?: string };

export type IpcHandler = (request: IpcRequest) => Promise<IpcResponse> | IpcResponse;

/** 实例运行状态（S04/S05 status 消费）。 */
export type AgentInstanceStatus =
  | "disabled"
  | "starting"
  | "online"
  | "failed"
  | "stopping";

export interface AgentRuntimeStatus {
  id: string;
  /** 是否已注册 agent 模块。 */
  registered: boolean;
  /** config.json 中的开关。 */
  enabled: boolean;
  status: AgentInstanceStatus;
  /** status=online 且 WSS 已连接。 */
  online: boolean;
  connected: boolean;
  serverId: string | null;
  environmentId: string | null;
  installationId: string | null;
  /** lifecycle.json 的 everEnrolled；null = 历史不明（缺失/损坏/非布尔）。 */
  everEnrolled: boolean | null;
  identityWarnings: string[];
  warnings: string[];
  error: string | null;
}

export interface DaemonRuntimeInfo {
  pid: number;
  home: string;
  startedAt: string;
  uptimeMs: number;
  running: boolean;
}

/** status op 返回形状。 */
export interface DaemonStatusPayload {
  daemon: DaemonRuntimeInfo;
  auth: AuthStatus;
  agents: Record<string, AgentRuntimeStatus>;
}

export class DaemonAlreadyRunningError extends Error {
  readonly code = "EADDRINUSE";
  constructor(socketPath: string, detail?: string) {
    super(`daemon 已在运行（socket 被占用）：${socketPath}${detail ? `（${detail}）` : ""}`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export type SocketProbe = "live" | "dead";

/**
 * 探测 socket 是否有活监听者（B-3 保守化）：
 * - connect 成功 → `"live"`；
 * - ECONNREFUSED/ENOENT → `"dead"`（死连接残留，可安全清理）；
 * - EACCES 及其他错误、或超时 → **抛错**（拒绝接管，绝不删除他人的活 socket）。
 */
export function probeSocket(socketPath: string, timeoutMs = 500): Promise<SocketProbe> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    socket.once("connect", () => done(() => resolve("live")));
    socket.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        done(() => resolve("dead"));
      } else {
        done(() =>
          reject(
            new Error(`socket 探测失败（${code ?? "unknown"}），拒绝接管：${socketPath}`),
          ),
        );
      }
    });
    const timer = setTimeout(
      () => done(() => reject(new Error(`socket 探测超时，拒绝接管：${socketPath}`))),
      timeoutMs,
    );
    timer.unref?.();
  });
}

/** 单行 IPC 请求大小上限（NIT ②），超限断连防内存膨胀。 */
export const MAX_IPC_LINE_BYTES = 1_000_000;

interface LockInfo {
  pid: number;
  /** 进程启动身份（`ps -o lstart=`）；null = 未知/旧格式。 */
  startedAt: string | null;
}

export interface IpcServerOptions {
  socketPath: string;
  handler: IpcHandler;
  log?: (line: string) => void;
}

/**
 * daemon 侧 IPC 服务端：行协议分发；stale socket 探测确认后清理；
 * 跨进程互斥由原子发布的 `<socketPath>.lock` 保证。
 * 每个请求独立处理（同 agent 的互斥由 daemon 的业务锁保证）。
 */
export class IpcServer {
  private readonly socketPath: string;
  private readonly handler: IpcHandler;
  private readonly log: (line: string) => void;
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private lockAcquired = false;

  constructor(opts: IpcServerOptions) {
    this.socketPath = opts.socketPath;
    this.handler = opts.handler;
    this.log = opts.log ?? (() => {});
  }

  get listening(): boolean {
    return this.server !== null;
  }

  private get lockPath(): string {
    return `${this.socketPath}.lock`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    assertSocketPathFits(this.socketPath);
    await mkdir(dirname(this.socketPath), { recursive: true });
    await this.acquireLock();
    try {
      // 仅探测确认死连接（或不存在）才清理陈旧 socket
      const state = await probeSocket(this.socketPath);
      if (state === "live") {
        throw new DaemonAlreadyRunningError(this.socketPath);
      }
      await rm(this.socketPath, { force: true });
      const server = await this.listenWithRetry();
      await chmod(this.socketPath, 0o600).catch(() => {});
      this.server = server;
      this.log(`ipc 监听 ${this.socketPath}`);
    } catch (err) {
      await this.releaseLock();
      throw err;
    }
  }

  /**
   * 原子发布锁：写唯一临时文件 → link(2) 到锁路径（EEXIST = 已被占）。
   * 空/不可解析锁 = 在途/未知，短重试后 fail-safe 拒绝，绝不删除。
   */
  private async acquireLock(): Promise<void> {
    const startedAt = await processStartIdentity(process.pid);
    const payload = JSON.stringify({ pid: process.pid, startedAt });
    let parseRetries = 0;
    let orphanGrace = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const tmp = `${this.lockPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2, 10)}`;
      await writeFile(tmp, payload, { mode: 0o600 });
      let linked = false;
      try {
        await link(tmp, this.lockPath); // 原子：失败 EEXIST = 已被占
        linked = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          await rm(tmp, { force: true });
          throw err;
        }
      }
      await rm(tmp, { force: true });
      if (linked) {
        this.lockAcquired = true;
        return;
      }

      const holder = await readLockInfo(this.lockPath);
      if (holder === null) {
        // 空/不可解析：在途/未知（不得当陈旧删）
        parseRetries += 1;
        if (parseRetries >= 3) throw new DaemonAlreadyRunningError(this.socketPath, "锁不可解析");
        await delay(60);
        continue;
      }
      if (holder.pid === process.pid) {
        // 同进程已有 daemon 持有（测试内双 daemon）：视为占用
        throw new DaemonAlreadyRunningError(this.socketPath);
      }
      if (!isProcessAlive(holder.pid)) {
        await rm(this.lockPath, { force: true }); // 持有者已死 → 陈旧锁
        continue;
      }
      const identity = await processStartIdentity(holder.pid);
      if (holder.startedAt && identity && holder.startedAt !== identity) {
        // pid 被复用（启动身份不符）→ 孤儿锁回收
        this.log(`锁 pid ${holder.pid} 启动身份不符（pid 复用），回收孤儿锁`);
        await rm(this.lockPath, { force: true });
        continue;
      }
      // 持有者活且身份相符/未知：daemon 存活必有 socket
      let socketLive: boolean;
      try {
        socketLive = (await probeSocket(this.socketPath)) === "live";
      } catch {
        socketLive = true; // 探测被拒（EACCES 等）→ 保守视为占用
      }
      if (socketLive) throw new DaemonAlreadyRunningError(this.socketPath);
      orphanGrace += 1;
      if (orphanGrace >= 3) {
        this.log(`锁 pid ${holder.pid} 存活但无 socket，按孤儿锁回收`);
        await rm(this.lockPath, { force: true });
        continue;
      }
      await delay(150); // 给"正在启动、尚未 listen"的 daemon 宽限
    }
    throw new DaemonAlreadyRunningError(this.socketPath);
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockAcquired) return;
    this.lockAcquired = false;
    await rm(this.lockPath, { force: true }).catch(() => {});
  }

  /**
   * listen；撞 EADDRINUSE（探测→unlink→listen 竞态窗）时重新探测：
   * 对方活着 → DaemonAlreadyRunningError（不删其 socket）；探测被拒 → 抛错；
   * 死连接残留 → 清理重试。
   */
  private async listenWithRetry(): Promise<Server> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const server = createServer((socket) => this.onConnection(socket));
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => reject(err);
          server.once("error", onError);
          server.listen(this.socketPath, () => {
            server.off("error", onError);
            resolve();
          });
        });
        return server;
      } catch (err) {
        try {
          server.close();
        } catch {
          // 未进入监听态
        }
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
        if ((await probeSocket(this.socketPath)) === "live") {
          throw new DaemonAlreadyRunningError(this.socketPath);
        }
        await rm(this.socketPath, { force: true });
      }
    }
    throw new DaemonAlreadyRunningError(this.socketPath);
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_IPC_LINE_BYTES) {
        this.log(`ipc 请求行超限（>${MAX_IPC_LINE_BYTES}B），断开连接`);
        buffer = "";
        socket.destroy();
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) {
          // NIT ①：dispatch 内 write/stringify 防御，异常不得成为 unhandledRejection
          void this.dispatch(socket, line).catch((err) =>
            this.log(`ipc 分发失败: ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      }
    });
    const cleanup = () => {
      this.sockets.delete(socket);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    let request: IpcRequest;
    try {
      request = JSON.parse(line) as IpcRequest;
    } catch (err) {
      this.write(socket, {
        ok: false,
        error: "INTERNAL",
        message: `无法解析 IPC 请求: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    let response: IpcResponse;
    try {
      response = await this.handler(request);
    } catch (err) {
      response = {
        ok: false,
        error: "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    this.write(socket, response);
  }

  private write(socket: Socket, response: IpcResponse): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(response)}\n`);
  }

  /** 关闭监听、销毁在连 socket 并移除本实例拥有的 socket 文件。 */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(this.socketPath, { force: true });
    }
    await this.releaseLock();
  }
}

export interface IpcClientOptions {
  socketPath: string;
  /** 单次请求超时；默认 10s。 */
  timeoutMs?: number;
}

/**
 * 单请求-单响应 IPC 客户端（S05 CLI 复用）。
 * - 连接失败（如 daemon 未运行 → ENOENT）**reject**，由调用方走离线降级；
 * - 收到响应行则 resolve 解析后的 IpcResponse。
 */
export function requestIpc(
  socketPath: string,
  op: IpcOp,
  args: { agent?: string } = {},
  opts: IpcClientOptions = { socketPath },
): Promise<IpcResponse> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise<IpcResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`IPC 请求超时（${op}）`)));
    }, timeoutMs);
    timer.unref?.();

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ op, agent: args.agent })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      finish(() => {
        try {
          resolve(JSON.parse(line) as IpcResponse);
        } catch (err) {
          reject(new Error(`IPC 响应解析失败: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    });
    socket.once("error", (err) => finish(() => reject(err)));
    socket.once("close", () => {
      finish(() => reject(new Error("IPC 连接在收到响应前关闭")));
    });
  });
}

// ------------------------------------------------------------------- helpers

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
  let raw: string;
  try {
    raw = (await readFile(lockPath, "utf8")).trim();
  } catch {
    return null;
  }
  if (!raw) return null; // 空文件 = 在途/未知
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const pid = Number((parsed as { pid?: unknown }).pid);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const startedAt = (parsed as { startedAt?: unknown }).startedAt;
      return { pid, startedAt: typeof startedAt === "string" ? startedAt : null };
    }
  } catch {
    // 兼容旧格式：纯 pid 文本
  }
  const legacy = Number(raw);
  return Number.isInteger(legacy) && legacy > 0 ? { pid: legacy, startedAt: null } : null;
}

/** 进程启动身份（macOS `ps -o lstart=`）；不可得返回 null。 */
function processStartIdentity(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.on("error", () => done(null));
    child.on("close", () => done(out.trim() || null));
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, 2000);
    timer.unref?.();
  });
}

/** 进程是否存活（EPERM = 存在但无权限，视为存活）。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
