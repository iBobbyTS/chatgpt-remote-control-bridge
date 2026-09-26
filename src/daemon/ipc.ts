/**
 * 本地 IPC（PLAN S02 ④ / 边界 3）：`<root>/daemon.sock` unix socket + JSON 行协议。
 *
 * 请求：`{op, agent?}`（单行 JSON）→ 响应：`{ok:true, data}` 或
 * `{ok:false, error, message?}`（单行 JSON）。S05 CLI 经此与运行中 daemon 协作。
 *
 * 本模块只承载协议类型、服务端监听与客户端封装；业务 handler 由 CgrcbDaemon 注入，
 * 因此 ipc.ts 不依赖 daemon.ts（无环）。
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { AuthStatus } from "../auth/manager.ts";

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
  /** lifecycle.json 的 everEnrolled；null = 历史不明（文件缺失）。 */
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

export interface IpcServerOptions {
  socketPath: string;
  handler: IpcHandler;
  log?: (line: string) => void;
}

/**
 * daemon 侧 IPC 服务端：行协议分发；stale socket 在被新 daemon 接管前清理。
 * 每个请求独立处理（同 agent 的互斥由 daemon 的业务锁保证）。
 */
export class IpcServer {
  private readonly socketPath: string;
  private readonly handler: IpcHandler;
  private readonly log: (line: string) => void;
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;

  constructor(opts: IpcServerOptions) {
    this.socketPath = opts.socketPath;
    this.handler = opts.handler;
    this.log = opts.log ?? (() => {});
  }

  get listening(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.socketPath), { recursive: true });
    if (await socketIsLive(this.socketPath)) {
      throw new DaemonAlreadyRunningError(this.socketPath);
    }
    // stale socket（daemon 死）→ 清理后接管
    await rm(this.socketPath, { force: true });
    const server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(this.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600).catch(() => {});
    this.server = server;
    this.log(`ipc 监听 ${this.socketPath}`);
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) {
          void this.dispatch(socket, line);
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
    if (!server) {
      // 未成功监听（如启动即被活跃 daemon 拒绝）：不属于本实例，勿删他人 socket
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.socketPath, { force: true });
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
