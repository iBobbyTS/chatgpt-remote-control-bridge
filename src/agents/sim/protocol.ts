/**
 * sim 层 JSON-RPC 协议原语（从 appServer.ts 拆出，AUD-009）。
 *
 * JSON-RPC 请求/响应/通知的 sim 侧形状与错误类型，供 appServer（dispatch/turn 引擎）、
 * fsOverlay（fs 方法错误码）、shellEmulation 共用。与 `src/agents/types.ts` 的
 * AgentApp 契约（JsonRpcOutcome 等）结构同形但独立演化：sim 内部错误码
 * （-32600/-32601/-32602/-32603/-32000）逐方法对齐 codex app-server。
 */

/** 客户端 + 流标识（多设备多流并行）。 */
export interface SimClientKey {
  clientId: string;
  streamId: string;
}

/** 单个 client/stream 的会话状态（clientState 恒创建语义）。 */
export interface SimClientState {
  clientInfo: { name?: string; title?: string; version?: string } | null;
  optOut: Set<string>;
  unsubscribed: Set<string>;
  /** attach 过的线程（正向订阅跟踪，仅服务空闲卸载判定）。 */
  attached: Set<string>;
  initialized: boolean;
}

/** fan-out 通知；threadId 存在时仅投给订阅了该 thread 的客户端。 */
export interface SimNotification {
  method: string;
  params: Record<string, unknown>;
  /** 存在时仅投递给订阅了该 thread 的客户端。 */
  threadId?: string;
  /** 存在时仅投递给该连接（连接级通知，如 command/exec/outputDelta）。 */
  target?: SimClientKey;
}

export interface JsonRpcSuccess {
  id: number | string;
  result: unknown;
}
export interface JsonRpcFailure {
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}
export type JsonRpcOutcome = JsonRpcSuccess | JsonRpcFailure;

export type AnyParams = Record<string, any>;

export const ERR_NOT_INITIALIZED = { code: -32600, message: "Not initialized" };
export const ERR_METHOD_NOT_FOUND = { code: -32601, message: "Method not found" };

/** sim 方法错误：code 逐方法对齐 codex app-server（见各 handler 注释）。 */
export class SimMethodError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "SimMethodError";
  }
}
