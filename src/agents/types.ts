/**
 * 下游 Agent 契约（S01 定义，S02/S03 消费）。
 *
 * WhamTunnel 只依赖本接口，不依赖任何具体 agent 实现（sim/zcode 等）。
 * 结构类型自带（不引用 src/sim 具体类型），使 sim 在 S03 前即可无改动挪入框架。
 */
import type { EventEmitter } from "node:events";

/** 客户端 + 流标识（多设备多流并行）。 */
export interface AgentClientKey {
  clientId: string;
  streamId: string;
}

/**
 * 单个 client/stream 的会话状态（对齐 src/sim/appServer.ts:193-200 恒创建语义）。
 * tunnel 仅对已注册 stream 调用 clientState。
 */
export interface AgentClientState {
  clientInfo: { name?: string; title?: string; version?: string } | null;
  optOut: Set<string>;
  unsubscribed: Set<string>;
  initialized: boolean;
}

/** fan-out 通知；threadId 存在时仅投递给订阅了该 thread 的客户端。 */
export interface AgentNotification {
  method: string;
  params: Record<string, unknown>;
  threadId?: string;
  /** 存在时仅投递给该连接（连接级通知，如 command/exec/outputDelta）。 */
  target?: AgentClientKey;
}

export interface JsonRpcOutcomeSuccess {
  id: number | string;
  result: unknown;
}

export interface JsonRpcOutcomeError {
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcOutcome = JsonRpcOutcomeSuccess | JsonRpcOutcomeError;

export interface AgentApp extends EventEmitter {
  /**
   * 处理一个 JSON-RPC 请求。实现方**不得**抛出未捕获异常：tunnel 会捕获 rejection
   * （尽力回 JSON-RPC error 响应），但正常实现应返回带 error 的 outcome。
   */
  handleRequest(
    key: AgentClientKey,
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<JsonRpcOutcome>;

  /** fan-out 通知（tunnel 订阅）。 */
  on(event: "event", cb: (notification: AgentNotification) => void): this;

  /** 心跳 pong 状态：有活跃 turn = active，否则 unknown。 */
  pongStatus(): "active" | "unknown";

  clientState(key: AgentClientKey): AgentClientState;

  forgetClient(key: AgentClientKey): void;

  close(): void;
}
