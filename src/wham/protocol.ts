/**
 * wham 远程控制协议类型（对齐 codex-rs/app-server-transport/src/transport/remote_control/protocol.rs）。
 *
 * 方向约定（以 codex 视角命名；codex 是被控端、WebSocket 拨出方）：
 * - ClientEvent/ClientEnvelope：**手机/wham 服务器 → codex**（codex 的 reader 解析此类型）。
 *   "client" 指远端控制器（手机 App）；wham 服务器代替手机下发。
 * - ServerEvent/ServerEnvelope：**codex → wham 服务器**（带 seq_id，服务器须回 Ack）。
 * - codex 的应用层心跳是 WS 协议层 Ping（10s 一次），服务器 WS 栈自动回 Pong。
 */

export const REMOTE_CONTROL_PROTOCOL_VERSION = "3"; // websocket.rs:69

export const WS_HEADERS = {
  serverId: "x-codex-server-id",
  name: "x-codex-name",
  protocolVersion: "x-codex-protocol-version",
  installationId: "x-codex-installation-id",
  subscribeCursor: "x-codex-subscribe-cursor",
  hostDeviceKind: "x-codex-host-device-kind",
} as const;

/** 手机/wham 服务器 → codex（protocol.rs ClientEvent + ClientEnvelope 展开）。 */
export interface ClientEnvelope {
  type:
    | "client_message"
    | "client_message_chunk"
    | "ack"
    | "ping"
    | "client_closed";
  client_id: string;
  stream_id?: string;
  /** ack：已确认的 ServerEnvelope.seq_id。 */
  seq_id?: number;
  cursor?: string;
  /** client_message：JSON-RPC 2.0 信封（请求/响应/通知）。 */
  message?: JsonRpcMessage;
  /** client_message_chunk。 */
  segment_id?: number;
  segment_count?: number;
  message_size_bytes?: number;
  message_chunk_base64?: string;
}

/** codex → wham 服务器（protocol.rs ServerEvent + ServerEnvelope 展开）。 */
export interface ServerEnvelope {
  type: "server_message" | "server_message_chunk" | "ack" | "pong";
  client_id: string;
  stream_id: string;
  seq_id: number;
  /** server_message：JSON-RPC 2.0 信封。 */
  message?: JsonRpcMessage;
  status?: "active" | "unknown";
  segment_id?: number;
  segment_count?: number;
  message_size_bytes?: number;
  message_chunk_base64?: string;
}

export type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: JsonRpcError }
  | { jsonrpc: "2.0"; method: string; params?: unknown };

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** REST 端点路径（protocol.rs normalize_remote_control_url）。 */
export const REST_PATHS = {
  enroll: "/backend-api/wham/remote/control/server/enroll",
  refresh: "/backend-api/wham/remote/control/server/refresh",
  pair: "/backend-api/wham/remote/control/server/pair",
  pairStatus: "/backend-api/wham/remote/control/server/pair/status",
  websocket: "/backend-api/wham/remote/control/server",
  /**
   * 环境客户端管理基路径（clients.rs environment_clients_url）：
   * `{environments}/{environment_id}/clients[/{client_id}]`。
   * 账号 token 鉴权（auth.rs request_headers），非 remote_control_token。
   */
  environments: "/backend-api/wham/remote/control/environments",
} as const;

/** `{environments}/{environment_id}/clients`（clients.rs environment_clients_url）。 */
export function environmentClientsPath(environmentId: string): string {
  return `${REST_PATHS.environments}/${encodeURIComponent(environmentId)}/clients`;
}

/** `{environments}/{environment_id}/clients/{client_id}`。 */
export function environmentClientPath(environmentId: string, clientId: string): string {
  return `${environmentClientsPath(environmentId)}/${encodeURIComponent(clientId)}`;
}

export interface EnrollRemoteServerRequest {
  name: string;
  os: string;
  arch: string;
  app_server_version: string;
  installation_id: string;
}

export interface EnrollRemoteServerResponse {
  server_id: string;
  environment_id: string;
  remote_control_token: string;
  expires_at: string;
}

/** 环境客户端条目（clients.rs RemoteControlClientResponse，wire 为 snake_case）。 */
export interface RemoteControlClient {
  client_id: string;
  display_name?: string | null;
  device_type?: string | null;
  platform?: string | null;
  os_version?: string | null;
  device_model?: string | null;
  app_version?: string | null;
  last_seen_at?: string | null;
}

export type RemoteControlClientsListOrder = "asc" | "desc";

/** GET clients 响应（clients.rs ListRemoteControlClientsResponse）。 */
export interface RemoteControlClientsListResponse {
  items: RemoteControlClient[];
  cursor?: string | null;
}
