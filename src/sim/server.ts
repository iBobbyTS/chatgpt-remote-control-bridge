/**
 * SimWhamServer：桥以 codex 被控端身份直连真实 wham 后端（chatgpt.com）。
 *
 *   手机 ChatGPT App ── wham 后端 ──WSS──▶ SimWhamServer（本进程）
 *
 * - REST enroll/refresh/pair 走 curl（WhamClient）
 * - WS 隧道：拨出 wss://{chatgpt_base_url_host}/backend-api/wham/remote/control/server，
 *   握手头对齐 websocket.rs build_remote_control_websocket_request
 *   （x-codex-server-id / x-codex-name(base64) / x-codex-protocol-version=3 /
 *    authorization=Bearer <remote_control_token> / x-codex-installation-id）
 * - 信封层（对齐 protocol.rs，方向以 codex 视角）：
 *   收 ClientEnvelope（client_message / client_message_chunk / ack / ping / client_closed），
 *   发 ServerEnvelope（server_message 带 per-(client,stream) 递增 seq_id / pong）。
 *   codex 从不回 Ack（protocol.rs ServerEvent::Ack 为 dead_code）——本实现同样不回。
 * - 通知 fan-out：跳过 initialize 时 capabilities.optOutNotificationMethods 声明的
 *   方法、以及 thread/unsubscribe 过的线程。
 * - 重连：WS 断开后延迟重连；remote_control_token 临近过期则重新 enroll。
 */
import { appendFile, mkdir } from "node:fs/promises";
import { hostname, release } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import type { BridgeAuthManager } from "../auth/manager.ts";
import {
  DEFAULT_CHATGPT_BASE_URL,
  WhamClient,
  websocketUrlFor,
} from "../wham/client.ts";
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  WS_HEADERS,
  type ClientEnvelope,
  type EnrollRemoteServerResponse,
  type JsonRpcMessage,
} from "../wham/protocol.ts";
import { SimApp, type SimNotification } from "./appServer.ts";

export interface SimWhamServerOptions {
  authManager: BridgeAuthManager;
  /** 默认 https://chatgpt.com/backend-api；测试指向 mock。 */
  baseUrl?: string;
  name?: string;
  appServerVersion?: string;
  app?: SimApp;
  jsonlPath?: string;
  log?: (line: string) => void;
  /** WS 断开重连延迟；0 = 不重连（测试用）。默认 2000ms。 */
  reconnectDelayMs?: number;
}

interface Enrollment extends EnrollRemoteServerResponse {}

interface StreamState {
  lastAckedSeq: number;
  sentSeq: number;
}

export class SimWhamServer {
  readonly app: SimApp;
  private readonly authManager: BridgeAuthManager;
  private readonly baseUrl: string;
  private readonly name: string;
  private readonly appServerVersion: string;
  private readonly log: (line: string) => void;
  private readonly reconnectDelayMs: number;
  private readonly jsonlPath?: string;
  private readonly streams = new Map<string, StreamState>();
  private readonly chunkReassembler = new Map<string, Map<number, ClientEnvelope>>();
  private enrollment: Enrollment | null = null;
  private ws: WebSocket | null = null;
  private cachedInstallationId: string | null = null;
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private jsonlQueue: Promise<void> = Promise.resolve();

  constructor(opts: SimWhamServerOptions) {
    this.authManager = opts.authManager;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CHATGPT_BASE_URL).replace(/\/+$/, "");
    this.name = opts.name ?? `${hostname()} (bridge-sim)`;
    this.appServerVersion = opts.appServerVersion ?? "0.157.0";
    this.app =
      opts.app ??
      new SimApp({
        codexHome: opts.authManager.codexHome,
        // 线程状态持久化：手机缓存 thread id，重启后必须可 resume
        statePath: join(opts.authManager.codexHome, "sim-state.json"),
        getServerInfo: () =>
          this.cachedInstallationId && this.enrollment
            ? {
                serverName: this.name,
                installationId: this.cachedInstallationId,
                environmentId: this.enrollment.environment_id,
              }
            : null,
      });
    this.log = opts.log ?? ((line) => console.error(`[sim] ${line}`));
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 2000;
    this.jsonlPath = opts.jsonlPath;
    this.app.on("event", (event: SimNotification) => this.fanOut(event));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get serverId(): string | null {
    return this.enrollment?.server_id ?? null;
  }

  /** enroll 发放的 remote_control_token（pair REST 用）。 */
  get pairToken(): string | null {
    return this.enrollment?.remote_control_token ?? null;
  }

  /** enroll + 拨 WSS。 */
  async start(): Promise<void> {
    await this.enroll();
    this.connectWs();
  }

  private async enroll(): Promise<void> {
    const client = new WhamClient({ authManager: this.authManager, baseUrl: this.baseUrl });
    this.enrollment = await client.enroll({
      name: this.name,
      appServerVersion: this.appServerVersion,
    });
    this.log(
      `enroll ✓ server_id=${this.enrollment.server_id} environment_id=${this.enrollment.environment_id} ` +
        `expires_at=${this.enrollment.expires_at}`,
    );
  }

  /** token 临近过期（<60s）则重新 enroll。 */
  private async ensureFreshEnrollment(): Promise<void> {
    if (!this.enrollment) {
      await this.enroll();
      return;
    }
    const expiresAt = Date.parse(this.enrollment.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() < 60_000) {
      await this.enroll();
    }
  }

  // -------------------------------------------------------------- WebSocket

  private connectWs(): void {
    if (this.stopped) return;
    void (async () => {
      const installationId = await this.installationId();
      if (this.stopped) return;
      const url = websocketUrlFor(this.baseUrl);
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.enrollment!.remote_control_token}`,
        [WS_HEADERS.serverId]: this.enrollment!.server_id,
        [WS_HEADERS.name]: Buffer.from(this.name, "utf8").toString("base64"),
        [WS_HEADERS.protocolVersion]: REMOTE_CONTROL_PROTOCOL_VERSION,
        [WS_HEADERS.installationId]: installationId,
        "User-Agent": `codex_cli_rs/${this.appServerVersion} (Mac OS ${release()}; ${process.arch}) bridge-sim`,
      };
      this.openWebSocket(url, headers);
    })().catch((err) => {
      this.log(`wss 建立失败: ${err instanceof Error ? err.message : err}`);
      this.scheduleReconnect();
    });
  }

  private openWebSocket(url: string, headers: Record<string, string>): void {
    const ws = new WebSocket(url, { headers });
    this.ws = ws;
    ws.on("open", () => {
      this.lastPongAt = Date.now();
      this.log(`wss 已连接 ${url}`);
      this.startPing();
    });
    ws.on("message", (data) => {
      void this.handleFrame(data.toString());
    });
    ws.on("pong", () => {
      this.lastPongAt = Date.now();
    });
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        this.log(`wss 被拒: HTTP ${res.statusCode} ${body.slice(0, 200)}`);
      });
    });
    ws.on("error", (err) => {
      this.log(`wss 错误: ${err.message}`);
    });
    ws.on("close", (code, reason) => {
      this.stopPing();
      this.log(`wss 关闭: ${code} ${reason.toString()}`);
      if (this.ws === ws) {
        this.ws = null;
      }
      this.scheduleReconnect();
    });
  }

  private async installationId(): Promise<string> {
    if (!this.cachedInstallationId) {
      const client = new WhamClient({ authManager: this.authManager, baseUrl: this.baseUrl });
      this.cachedInstallationId = await client.installationId();
    }
    return this.cachedInstallationId;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > 45_000) {
        this.log("pong 超时，主动断开重连");
        ws.terminate();
        return;
      }
      ws.ping();
    }, 10_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectDelayMs <= 0) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void (async () => {
        try {
          await this.ensureFreshEnrollment();
          this.connectWs();
        } catch (err) {
          this.log(`重连失败: ${err instanceof Error ? err.message : err}`);
          this.scheduleReconnect();
        }
      })();
    }, this.reconnectDelayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.app.close();
    this.ws?.close();
    this.ws = null;
  }

  // ----------------------------------------------------------------- 帧处理

  private async handleFrame(text: string): Promise<void> {
    let envelope: ClientEnvelope;
    try {
      envelope = JSON.parse(text) as ClientEnvelope;
    } catch {
      this.log(`! 无法解析入站帧: ${text.slice(0, 120)}`);
      return;
    }
    this.logFrame("wham→sim", envelope);
    switch (envelope.type) {
      case "client_message": {
        const message = envelope.message;
        if (!message) return;
        await this.dispatchMessage(envelope, message);
        return;
      }
      case "client_message_chunk": {
        this.handleChunk(envelope);
        return;
      }
      case "ack": {
        const state = this.streamState(envelope);
        state.lastAckedSeq = Math.max(state.lastAckedSeq, envelope.seq_id ?? 0);
        return;
      }
      case "ping": {
        this.sendEnvelope(envelope.client_id, envelope.stream_id ?? "", {
          type: "pong",
          status: this.app.pongStatus(),
        });
        return;
      }
      case "client_closed": {
        const key = `${envelope.client_id}/${envelope.stream_id ?? ""}`;
        this.streams.delete(key);
        this.chunkReassembler.delete(key);
        this.app.forgetClient({ clientId: envelope.client_id, streamId: envelope.stream_id ?? "" });
        return;
      }
    }
  }

  /** 分片重组（手机大消息会走 client_message_chunk，base64 分段）。 */
  private handleChunk(envelope: ClientEnvelope): void {
    const key = `${envelope.client_id}/${envelope.stream_id ?? ""}`;
    let segments = this.chunkReassembler.get(key);
    if (!segments) {
      segments = new Map();
      this.chunkReassembler.set(key, segments);
    }
    segments.set(envelope.segment_id ?? 0, envelope);
    if (segments.size < (envelope.segment_count ?? 1)) return;
    this.chunkReassembler.delete(key);
    const ordered = [...segments.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, seg]) => seg.message_chunk_base64 ?? "");
    try {
      const message = JSON.parse(
        Buffer.from(ordered.join(""), "base64").toString("utf8"),
      ) as JsonRpcMessage;
      void this.dispatchMessage(
        {
          ...envelope,
          type: "client_message",
          message,
        },
        message,
      );
    } catch (err) {
      this.log(`! 分片重组失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async dispatchMessage(envelope: ClientEnvelope, message: JsonRpcMessage): Promise<void> {
    if (!("method" in message) || !("id" in message)) {
      // 手机对我们发起的请求（attestation 等）的响应；本实现不主动发请求，忽略
      return;
    }
    const method = message.method;
    const key = { clientId: envelope.client_id, streamId: envelope.stream_id ?? "" };
    const outcome = await this.app.handleRequest(key, message.id, method, message.params ?? null);
    if ("error" in outcome) {
      this.log(`✗ ${method} 错误: ${JSON.stringify(outcome.error)}`);
    } else {
      this.log(`✓ ${method} → ${JSON.stringify(outcome.result).slice(0, 160)}`);
    }
    this.sendEnvelope(envelope.client_id, envelope.stream_id ?? "", {
      type: "server_message",
      message: "error" in outcome
        ? { id: outcome.id, error: outcome.error }
        : { id: outcome.id, result: outcome.result },
    });
  }

  // ----------------------------------------------------------------- 出站

  private fanOut(event: SimNotification): void {
    for (const key of this.streams.keys()) {
      const separator = key.indexOf("/");
      const clientId = key.slice(0, separator);
      const streamId = key.slice(separator + 1);
      const clientState = this.app.clientState({ clientId, streamId });
      if (clientState.optOut.has(event.method)) continue;
      if (event.threadId && clientState.unsubscribed.has(event.threadId)) continue;
      this.sendEnvelope(clientId, streamId, {
        type: "server_message",
        message: {
          method: event.method,
          params: event.params,
          emittedAtMs: Date.now(),
        },
      });
    }
  }

  private streamState(envelope: { client_id: string; stream_id?: string }): StreamState {
    const key = `${envelope.client_id}/${envelope.stream_id ?? ""}`;
    let state = this.streams.get(key);
    if (!state) {
      state = { lastAckedSeq: 0, sentSeq: 0 };
      this.streams.set(key, state);
    }
    return state;
  }

  private sendEnvelope(
    clientId: string,
    streamId: string,
    event:
      | { type: "server_message"; message: unknown }
      | { type: "pong"; status: "active" | "unknown" },
  ): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.log(`! 发送失败（连接未就绪）: ${event.type}`);
      return;
    }
    const state = this.streamState({ client_id: clientId, stream_id: streamId });
    state.sentSeq += 1;
    const frame = {
      type: event.type,
      client_id: clientId,
      stream_id: streamId,
      seq_id: state.sentSeq,
      ...(event.type === "server_message" ? { message: event.message } : { status: event.status }),
    };
    ws.send(JSON.stringify(frame));
    this.logFrame("sim→wham", frame);
  }

  // ----------------------------------------------------------------- 日志

  private logFrame(dir: string, frame: unknown): void {
    if (!this.jsonlPath) return;
    const record = JSON.stringify({ at: new Date().toISOString(), dir, frame });
    this.jsonlQueue = this.jsonlQueue
      .then(async () => {
        await mkdir(dirname(this.jsonlPath!), { recursive: true });
        await appendFile(this.jsonlPath!, `${record}\n`);
      })
      .catch(() => undefined);
  }
}
