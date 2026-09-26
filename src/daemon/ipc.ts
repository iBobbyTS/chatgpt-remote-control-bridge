/**
 * 本地 IPC（PLAN S02 ④ / 边界 3）：`<root>/daemon.sock` unix socket + JSON 行协议。
 *
 * 请求：`{op, agent?}`（单行 JSON）→ 响应：`{ok:true, data}` 或
 * `{ok:false, error, message?}`（单行 JSON）。S05 CLI 经此与运行中 daemon 协作。
 *
 * 本模块只承载协议类型、服务端监听与客户端封装；业务 handler 由 CgrcbDaemon 注入，
 * 因此 ipc.ts 不依赖 daemon.ts（无环）。
 *
 * 单实例互斥（BLOCKER 4）：socket 探测（probe→unlink→listen）本身无跨进程原子性，
 * 故用 O_EXCL 锁文件 `<socketPath>.lock`（pid）做最小互斥；仅在探测确认死连接后才
 * unlink stale socket，listen 撞 EADDRINUSE 时重新探测，确认对方活着则报错退出、不删其 socket。
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  constructor(socketPath: string) {
    super(`daemon 已在运行（socket 被占用）：${socketPath}`);
    this.name = "DaemonAlreadyRunningError";
  }
}

/** 检测 socket 是否有活进程监听（能连上 = 活；ENOENT/ECONNREFUSED = stale）。 */
export function socketIsLive(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
  });
}

/** 单行 IPC 请求大小上限（NIT ②），超限断连防内存膨胀。 */
export const MAX_IPC_LINE_BYTES = 1_000_000;

export interface IpcServerOptions {
  socketPath: string;
  handler: IpcHandler;
  log?: (line: string) => void;
}

/**
 * daemon 侧 IPC 服务端：行协议分发；stale socket 在被新 daemon 接管前清理；
 * 跨进程互斥由 `<socketPath>.lock` 保证（BLOCKER 4）。
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
      if (await socketIsLive(this.socketPath)) {
        throw new DaemonAlreadyRunningError(this.socketPath);
      }
      // 仅当探测确认无监听者（死连接残留）才 unlink stale socket
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

  /** O_EXCL 锁文件：跨进程最小互斥；陈旧锁（持有者已死）清理后重试。 */
  private async acquireLock(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(this.lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
        this.lockAcquired = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const holder = await readLockPid(this.lockPath);
        // 持有者存活（含同进程测试内双 daemon）→ 拒绝；不触碰其 socket/lock
        if (holder !== null && isProcessAlive(holder)) {
          throw new DaemonAlreadyRunningError(this.socketPath);
        }
        await rm(this.lockPath, { force: true });
      }
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
   * 对方活着 → DaemonAlreadyRunningError（不删其 socket）；死连接残留 → 清理重试。
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
        if (await socketIsLive(this.socketPath)) {
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

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const text = (await readFile(lockPath, "utf8")).trim();
    const pid = Number.parseInt(text, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
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
