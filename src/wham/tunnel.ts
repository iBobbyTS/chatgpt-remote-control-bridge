/**
 * WhamTunnel：通用上游隧道（桥以 codex 被控端身份直连真实 wham 后端）。
 *
 *   手机 ChatGPT App ── wham 后端 ──WSS──▶ WhamTunnel（本进程）
 *
 * - REST enroll/refresh 走 curl（WhamClient）；clients list/revoke 由调用方直接使用 WhamClient
 * - WS 隧道：拨出 wss://{chatgpt_base_url_host}/backend-api/wham/remote/control/server，
 *   握手头对齐 websocket.rs build_remote_control_websocket_request
 *   （x-codex-server-id / x-codex-name(base64) / x-codex-protocol-version=3 /
 *    authorization=Bearer <remote_control_token> / x-codex-installation-id）
 * - 信封层（对齐 protocol.rs，方向以 codex 视角）：
 *   收 ClientEnvelope（client_message / client_message_chunk / ack / ping / client_closed），
 *   发 ServerEnvelope（server_message / pong，均带 per-(client,stream) 递增 seq_id）。
 * - 通知 fan-out：跳过 initialize 时 capabilities.optOutNotificationMethods 声明的方法
 *   与 thread/unsubscribe 过的线程（由 AgentApp.clientState 提供状态）。
 * - 重连：WS 断开后延迟重连；token 临近过期则续期。
 * - 出站可靠层（对齐 websocket.rs BoundedOutboundBuffer/背压）：所有 ServerEnvelope
 *   （server_message 与 pong 一视同仁，对齐 codex websocket.rs:101/:1062）先入每流 pending，
 *   WS open 且全局未 ack 缓冲 < 128 时分配 seq、入缓冲并发送；ack 清除 seq ≤ 游标的缓冲帧，
 *   并按轮询跨流排空所有流的 pending（B1：容量释放后他流积压不得滞留）；重连先按原 seq
 *   重放缓冲（含 pong）再补发 pending（seq 单调连续）。pending 每流上限 256，溢出先合并
 *   相邻同 itemId delta（pong 不合并），仍溢出才丢最旧（未分配 seq，无空洞）。
 *   订阅游标：任意入站信封 cursor last-writer-wins，重连握手带 x-codex-subscribe-cursor。
 *
 * 与具体下游解耦：只依赖 AgentApp 接口（src/agents/types.ts）。
 *
 * enrollment 唯一管理方（S01 新契约）：
 * - 身份策略 refresh-first：实例目录有 enrollment 记录 → 先 refresh(server_id) 续 token 保身份；
 *   refresh 失败或无记录 → enroll。兜底 enroll 可能铸新身份 → WARN + identityWarnings。
 * - 临期检查挂在 ping 定时器每周期执行（剩余寿命 < refreshThresholdMs → 按上述策略续期），
 *   与重连路径共用同一 ensureFreshEnrollment。
 * - enrollment 变更通过 `on("enrollment", cb)` 通知订阅方（S02 持久化 / S04 配对）。
 * - enrollment.json 持久化在实例目录（存在则启动时加载）。
 *
 * 异步边界：所有 fire-and-forget 异步链自带 .catch（吞错 → 日志 + onFault 回调），
 * AgentApp.handleRequest 的 rejection 由 tunnel 捕获并尽力回 JSON-RPC error 响应，
 * 不产生 unhandledRejection。
 */
import { EventEmitter } from "node:events";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, release } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import type { AgentApp, AgentNotification, JsonRpcOutcome } from "../agents/types.ts";
import type { BridgeAuthManager } from "../auth/manager.ts";
import {
  DEFAULT_CHATGPT_BASE_URL,
  WhamClient,
  websocketUrlFor,
} from "./client.ts";
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  WS_HEADERS,
  type ClientEnvelope,
  type EnrollRemoteServerResponse,
  type JsonRpcMessage,
} from "./protocol.ts";

/** 实例目录内的 enrollment 缓存文件名（S02 数据布局边界 4）。 */
export const ENROLLMENT_FILENAME = "enrollment.json";

export interface WhamTunnelOptions {
  authManager: BridgeAuthManager;
  /** 下游 AgentApp（S02/S03 构造并注入）。 */
  app: AgentApp;
  /** 默认 https://chatgpt.com；测试指向 mock。 */
  baseUrl?: string;
  name?: string;
  appServerVersion?: string;
  /** 实例目录（installation_id / enrollment.json）；默认 authManager.codexHome。 */
  installationDir?: string;
  jsonlPath?: string;
  log?: (line: string) => void;
  /** WS 断开重连延迟；0 = 不重连（测试用）。默认 2000ms。 */
  reconnectDelayMs?: number;
  /** token 剩余寿命低于该值即续期。默认 60s。 */
  refreshThresholdMs?: number;
  /** ping/临期检查定时器周期。默认 10_000ms。 */
  pingIntervalMs?: number;
  /** WSS 握手 UA 后缀标识。默认 "bridge"。 */
  agentLabel?: string;
  /** 实例故障回调（内部 API，S02 消费）：异步链错误/handleRequest rejection。 */
  onFault?: (err: unknown, context: string) => void;
}

export interface TunnelIdentity {
  serverName: string;
  installationId: string;
  environmentId: string;
}

type Enrollment = EnrollRemoteServerResponse;

/**
 * 已发未 ack 缓冲上限（对齐 codex remote_control CHANNEL_CAPACITY=128，全局计数）。
 * 达到上限即背压：新事件不再分配 seq，转入该流 pending 等 ack 释放空位。
 */
const OUTBOUND_BUFFER_CAPACITY = 128;
/** 每流 pending（未分配 seq）上限；溢出先合并相邻同 itemId delta，仍溢出才丢最旧。 */
const OUTBOUND_PENDING_CAPACITY = 256;

/**
 * pending 队列元素：server_message 载荷或 pong。两者走同一有界可靠层（对齐 codex
 * websocket.rs：所有 ServerEnvelope 含 pong 统一入有界缓冲、共享 per-stream seq、
 * 重连原样重放）；pong 无 delta 语义，故不参与相邻 delta 合并。
 */
type PendingEvent =
  | { kind: "server_message"; message: unknown }
  | { kind: "pong"; status: "active" | "unknown" };

interface StreamState {
  clientId: string;
  streamId: string;
  lastAckedSeq: number;
  sentSeq: number;
  /** 已发送未 ack 的出站帧（seq 升序、整帧含 seq_id）：重连时原样重放（含 pong）。 */
  buffer: Array<{ seq: number; frame: Record<string, unknown> }>;
  /** WS 未就绪/缓冲满时暂存的出站事件（未分配 seq，server_message 可合并/丢弃）。 */
  pending: PendingEvent[];
}

/** item/agentMessage/delta 通知的合并判据（同 itemId 的相邻 delta 文本可拼接）。 */
function deltaNotification(message: unknown): { itemId: string; delta: string } | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as { method?: unknown; params?: unknown };
  if (m.method !== "item/agentMessage/delta") return null;
  if (typeof m.params !== "object" || m.params === null) return null;
  const p = m.params as { itemId?: unknown; delta?: unknown };
  if (typeof p.itemId !== "string" || typeof p.delta !== "string") return null;
  return { itemId: p.itemId, delta: p.delta };
}

export class WhamTunnel extends EventEmitter {
  readonly app: AgentApp;
  /** 累计 WARN（含 refresh 失败回退、身份变更/漂移），供 status 展示。 */
  readonly warnings: string[] = [];
  /** 身份相关 WARN 子集（S04 status.identityWarnings 的出口）。 */
  readonly identityWarnings: string[] = [];
  private readonly authManager: BridgeAuthManager;
  private readonly baseUrl: string;
  private readonly name: string;
  private readonly appServerVersion: string;
  private readonly installationDir: string;
  private readonly log: (line: string) => void;
  private readonly reconnectDelayMs: number;
  private readonly refreshThresholdMs: number;
  private readonly pingIntervalMs: number;
  private readonly agentLabel: string;
  private readonly onFault?: (err: unknown, context: string) => void;
  private readonly jsonlPath?: string;
  private readonly streams = new Map<string, StreamState>();
  private readonly chunkReassembler = new Map<string, Map<number, ClientEnvelope>>();
  /** 全局已发未 ack 缓冲计数（= 各流 buffer 长度之和，背压判据）。 */
  private bufferedUsed = 0;
  /** 入站 client 信封携带的订阅游标（last-writer-wins），重连握手以 HTTP 头携带。 */
  private subscribeCursor: string | null = null;
  /** pending 相邻 delta 合并次数（累计，诊断/测试）。 */
  private mergedPendingCount = 0;
  /** pending 溢出丢弃最旧事件次数（累计，诊断/测试）。 */
  private droppedPendingCount = 0;
  private enrollment: Enrollment | null = null;
  private ws: WebSocket | null = null;
  private cachedInstallationId: string | null = null;
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private renewalInFlight: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lastPongAt = 0;
  private jsonlQueue: Promise<void> = Promise.resolve();

  constructor(opts: WhamTunnelOptions) {
    super();
    this.app = opts.app;
    this.authManager = opts.authManager;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CHATGPT_BASE_URL).replace(/\/+$/, "");
    this.name = opts.name ?? `${hostname()} (bridge)`;
    this.appServerVersion = opts.appServerVersion ?? "0.157.0";
    this.installationDir = opts.installationDir ?? opts.authManager.codexHome;
    this.log = opts.log ?? ((line) => console.error(`[wham-tunnel] ${line}`));
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 2000;
    this.refreshThresholdMs = opts.refreshThresholdMs ?? 60_000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 10_000;
    this.agentLabel = opts.agentLabel ?? "bridge";
    this.onFault = opts.onFault;
    this.jsonlPath = opts.jsonlPath;
    this.app.on("event", (event: AgentNotification) => this.fanOut(event));
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

  /** 当前 enrollment 快照（含 token/expiry）。 */
  get enrollmentSnapshot(): Enrollment | null {
    return this.enrollment ? { ...this.enrollment } : null;
  }

  /** 身份快照（AgentApp getServerInfo / daemon status 用）。 */
  identity(): TunnelIdentity | null {
    if (!this.cachedInstallationId || !this.enrollment) {
      return null;
    }
    return {
      serverName: this.name,
      installationId: this.cachedInstallationId,
      environmentId: this.enrollment.environment_id,
    };
  }

  /**
   * 出站可靠层状态快照（诊断/测试）：全局未 ack 缓冲数、各流 pending 合计、累计
   * 合并/丢弃数。stop() 后 streams 清空 → buffered/pending 归零。
   */
  outboundBacklog(): { buffered: number; pending: number; merged: number; dropped: number } {
    let pending = 0;
    for (const state of this.streams.values()) pending += state.pending.length;
    return {
      buffered: this.bufferedUsed,
      pending,
      merged: this.mergedPendingCount,
      dropped: this.droppedPendingCount,
    };
  }

  /** 续期身份（refresh-first）后拨 WSS。 */
  async start(): Promise<void> {
    await this.renewEnrollment("start");
    this.connectWs();
  }

  // ------------------------------------------------------------- enrollment

  private whamClient(): WhamClient {
    return new WhamClient({
      authManager: this.authManager,
      baseUrl: this.baseUrl,
      installationDir: this.installationDir,
    });
  }

  private enrollmentPath(): string {
    return join(this.installationDir, ENROLLMENT_FILENAME);
  }

  private async loadPersistedEnrollment(): Promise<Enrollment | null> {
    try {
      const parsed = JSON.parse(await readFile(this.enrollmentPath(), "utf8")) as Enrollment;
      if (parsed?.server_id && parsed?.environment_id) {
        return parsed;
      }
    } catch {
      // 无记录/损坏：走 enroll
    }
    return null;
  }

  private async persistEnrollment(enrollment: Enrollment): Promise<void> {
    const path = this.enrollmentPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(enrollment, null, 2)}\n`, { mode: 0o600 });
  }

  /** 并发去重：ping 定时器 / 重连 / start 共用一次续期。 */
  private async renewEnrollment(reason: string): Promise<void> {
    if (this.renewalInFlight) {
      return this.renewalInFlight;
    }
    this.renewalInFlight = this.doRenewEnrollment(reason).finally(() => {
      this.renewalInFlight = null;
    });
    return this.renewalInFlight;
  }

  private async doRenewEnrollment(reason: string): Promise<void> {
    if (this.stopped) return;
    const client = this.whamClient();
    const previous = this.enrollment ?? (await this.loadPersistedEnrollment());
    if (previous) {
      try {
        const refreshed = await client.refresh({ serverId: previous.server_id });
        await this.applyEnrollment(refreshed, previous, "refresh", reason);
        return;
      } catch (err) {
        if (this.stopped) return;
        this.warn(
          `refresh 失败（${reason}），回退 enroll 兜底（可能铸新身份）: ${errorMessage(err)}`,
        );
      }
    }
    if (this.stopped) return;
    const enrolled = await client.enroll({
      name: this.name,
      appServerVersion: this.appServerVersion,
    });
    await this.applyEnrollment(enrolled, previous, "enroll", reason);
  }

  private async applyEnrollment(
    next: Enrollment,
    previous: Enrollment | null,
    mode: "refresh" | "enroll",
    reason: string,
  ): Promise<void> {
    // 停止与续期提交互斥（BLOCKER 1）：stop() 置位后到达的结果一律丢弃，不写盘、不发事件
    if (this.stopped) {
      this.log(`${mode} 结果在 stop 之后到达，已丢弃（${reason}）`);
      return;
    }
    if (previous) {
      const serverChanged = next.server_id !== previous.server_id;
      const environmentChanged = next.environment_id !== previous.environment_id;
      if (mode === "refresh" && (serverChanged || environmentChanged)) {
        // BLOCKER 2：refresh 必须保身份；漂移接受但可见（codex server_api.rs 视为硬错误）
        this.warnIdentity(
          `身份漂移：refresh 返回 server_id ${previous.server_id} → ${next.server_id}、` +
            `environment_id ${previous.environment_id} → ${next.environment_id}（${reason}）`,
        );
      } else if (mode === "enroll" && (serverChanged || environmentChanged)) {
        this.warnIdentity(
          `身份变更：server_id ${previous.server_id} → ${next.server_id}、` +
            `environment_id ${previous.environment_id} → ${next.environment_id}（${reason}）；` +
            `兜底 enroll 可能已铸新 environment`,
        );
      }
    }
    this.enrollment = next;
    try {
      await this.persistEnrollment(next);
    } catch (err) {
      this.warn(`enrollment 持久化失败: ${errorMessage(err)}`);
    }
    // stop() 可能在 persist await 期间置位：再次确认后不再对外发布
    if (this.stopped) {
      this.log(`enrollment 在 stop 之后到达，已丢弃事件（${reason}）`);
      return;
    }
    this.safeEmit("enrollment", { ...next });
    this.log(
      `${mode} ✓ (${reason}) server_id=${next.server_id} environment_id=${next.environment_id} ` +
        `expires_at=${next.expires_at}`,
    );
  }

  /** 临期（< refreshThresholdMs）才续期：重连路径与 ping 定时器共用。 */
  private async ensureFreshEnrollment(): Promise<void> {
    if (!this.enrollment) {
      await this.renewEnrollment("no-enrollment");
      return;
    }
    const expiresAt = Date.parse(this.enrollment.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() < this.refreshThresholdMs) {
      await this.renewEnrollment("expiry");
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
        "User-Agent": `codex_cli_rs/${this.appServerVersion} (Mac OS ${release()}; ${process.arch}) ${this.agentLabel}`,
      };
      // 订阅游标：任意入站信封记录过 cursor 后，重连握手必须携带最近值
      if (this.subscribeCursor !== null) {
        headers[WS_HEADERS.subscribeCursor] = this.subscribeCursor;
      }
      this.openWebSocket(url, headers);
    })().catch((err) => {
      this.fault(err, "connectWs");
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
      // 重连（含首连）先重放未 ack 缓冲，再按序排空 pending，保证 seq 单调连续
      this.replayBuffered();
    });
    ws.on("message", (data) => {
      // fire-and-forget：自带接收边界，agent 异常不得成为 unhandledRejection
      void this.handleFrame(data.toString()).catch((err) => this.fault(err, "handleFrame"));
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
      this.cachedInstallationId = await this.whamClient().installationId();
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
      // 临期检查（S01 新契约）：WSS 长连接期间也必须刷新 token
      void this.ensureFreshEnrollment().catch((err) => this.fault(err, "expiry-renew"));
    }, this.pingIntervalMs);
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
        await this.ensureFreshEnrollment();
        this.connectWs();
      })().catch((err) => {
        this.fault(err, "reconnect");
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }

  /**
   * 停止隧道。BLOCKER 1：置 stopped 后等待在途续期收敛（其结果在 applyEnrollment
   * 处被丢弃），因此 stop() resolve 后不再有任何 enrollment 落盘/事件。
   */
  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopped = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // 出站可靠层随 stop 一并清空：缓冲与 pending 全清，迟到出站帧被 stopped 拦截
    this.streams.clear();
    this.chunkReassembler.clear();
    this.bufferedUsed = 0;
    const inFlight = this.renewalInFlight;
    // 二波3（有界授权加固）：app.close 抛错不得跳过 ws.close()/stopPromise 建立，
    // 否则旧 WS 泄漏且 stop() 永不收敛。吞错仅记日志，不改变其余语义。
    try {
      this.app.close();
    } catch (err) {
      this.log(`app.close 失败（忽略，继续关闭 WS）: ${errorMessage(err)}`);
    }
    this.ws?.close();
    this.ws = null;
    this.stopPromise = (async () => {
      if (inFlight) {
        // 只等待其结束，不消费其结果；续期失败也不得让 stop 抛错
        await inFlight.catch(() => undefined);
      }
    })();
    return this.stopPromise;
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
    this.logFrame("wham→agent", envelope);
    // 订阅游标：任意入站 client 信封的 cursor 都记为隧道单一最近值（last-writer-wins）
    if (envelope.cursor !== undefined) {
      this.subscribeCursor = envelope.cursor;
    }
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
        // 清除已确认的缓冲帧，再按轮询跨流排空 pending（缓冲有空位即分配 seq 发送）。
        // B1：不能只排空本流——他流在全局背压期间积压的 pending 会因本流 ack 释放的
        // 空位无人认领而永久滞留。
        this.removeAcked(state, state.lastAckedSeq);
        this.drainPendingAcrossStreams();
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
        // 保留既有语义：清流状态（含未 ack 缓冲与 pending；有意识偏差已在计划记录）
        const removed = this.streams.get(key);
        if (removed) this.bufferedUsed -= removed.buffer.length;
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
      ).catch((err) => this.fault(err, "dispatchMessage(chunk)"));
    } catch (err) {
      this.log(`! 分片重组失败: ${errorMessage(err)}`);
    }
  }

  private async dispatchMessage(envelope: ClientEnvelope, message: JsonRpcMessage): Promise<void> {
    if (!("method" in message) || !("id" in message)) {
      // 手机对我们发起的请求（attestation 等）的响应；本实现不主动发请求，忽略
      return;
    }
    const method = message.method;
    const key = { clientId: envelope.client_id, streamId: envelope.stream_id ?? "" };
    let outcome: JsonRpcOutcome;
    try {
      outcome = await this.app.handleRequest(key, message.id, method, message.params ?? null);
    } catch (err) {
      // 接收边界：agent rejection 不得逃逸；尽力回 JSON-RPC error 响应
      this.fault(err, `handleRequest(${method})`);
      outcome = {
        id: message.id,
        error: { code: -32000, message: `agent error: ${errorMessage(err)}` },
      };
    }
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

  private fanOut(event: AgentNotification): void {
    try {
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
    } catch (err) {
      this.fault(err, "fanOut");
    }
  }

  private streamState(envelope: { client_id: string; stream_id?: string }): StreamState {
    const clientId = envelope.client_id;
    const streamId = envelope.stream_id ?? "";
    const key = `${clientId}/${streamId}`;
    let state = this.streams.get(key);
    if (!state) {
      state = {
        clientId,
        streamId,
        lastAckedSeq: 0,
        sentSeq: 0,
        buffer: [],
        pending: [],
      };
      this.streams.set(key, state);
    }
    return state;
  }

  /**
   * 出站可靠层入口：所有 ServerEnvelope（server_message 与 pong）一律先入 pending，再按序排空。
   * - WS open 且缓冲有空位 → 立即分配 seq、入未 ack 缓冲、发送；
   * - WS 未开或缓冲满（背压）→ 留在 pending（不分配 seq、不发送、不丢弃）。
   * B2 修复：旧计划"pong 不入缓冲、连接未就绪即丢"的偏差作废，pong 与 server_message 同走
   * 此路径（对齐 codex 蓝本：所有 ServerEnvelope 统一入有界缓冲）。否则 pong 在断线后丢失，
   * 重放只剩 server_message，per-stream seq 出现空洞，违反"seq 连续、重放不改 seq"合同。
   */
  private sendEnvelope(
    clientId: string,
    streamId: string,
    event:
      | { type: "server_message"; message: unknown }
      | { type: "pong"; status: "active" | "unknown" },
  ): void {
    if (this.stopped) {
      // 迟到响应/事件：stop 后一律丢弃，不入队、不发送、不抛错
      this.log(`! stop 后丢弃出站帧: ${event.type}`);
      return;
    }
    const state = this.streamState({ client_id: clientId, stream_id: streamId });
    state.pending.push(
      event.type === "pong"
        ? { kind: "pong", status: event.status }
        : { kind: "server_message", message: event.message },
    );
    this.enforcePendingCap(state);
    this.drainPending(state);
  }

  /** 重连/首连：按 seq 顺序原样重放各流未 ack 缓冲帧（含 pong，不重置 sentSeq），再跨流排空 pending。 */
  private replayBuffered(): void {
    const ws = this.ws;
    if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    for (const state of this.streams.values()) {
      for (const entry of state.buffer) {
        ws.send(JSON.stringify(entry.frame));
        this.logFrame("agent→wham", entry.frame);
      }
    }
    this.drainPendingAcrossStreams();
  }

  /** 移除 seq ≤ ackedSeq 的缓冲帧（ack 游标清除；未 ack 帧永不丢弃）。 */
  private removeAcked(state: StreamState, ackedSeq: number): void {
    if (state.buffer.length === 0) return;
    const remaining = state.buffer.filter((entry) => entry.seq > ackedSeq);
    this.bufferedUsed -= state.buffer.length - remaining.length;
    state.buffer = remaining;
  }

  /** 按序排空本流 pending：缓冲有空位即分配 seq、入缓冲、发送（保持单调连续）。 */
  private drainPending(state: StreamState): void {
    const ws = this.ws;
    if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    while (state.pending.length > 0 && this.bufferedUsed < OUTBOUND_BUFFER_CAPACITY) {
      this.drainOne(state);
    }
  }

  /**
   * 跨流公平排空（容量释放路径：ack / 重连重放后）：全局缓冲仍有余位时，按 streams
   * 插入序轮询，逐流每次最多补一帧，直到容量耗尽或所有 pending 清空。
   *
   * B1：从前只在 ack 的流上 drainPending，全局背压期间进入他流 pending 的事件（该流
   * 无新事件/ack/重连）会永久滞留。轮询而非"逐流一次性灌满"保证公平——任一流的
   * pending 都不会独占刚释放的空位而饿死他流；循环条件恒检 bufferedUsed < 128，
   * 绝不越过全局上限。
   */
  private drainPendingAcrossStreams(): void {
    const ws = this.ws;
    if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    // 快照插入序：drainOne 不新增/删除流，轮询序在本方法内稳定
    const states = [...this.streams.values()];
    let progressed = true;
    while (progressed && this.bufferedUsed < OUTBOUND_BUFFER_CAPACITY) {
      progressed = false;
      for (const state of states) {
        if (state.pending.length === 0) continue;
        if (this.bufferedUsed >= OUTBOUND_BUFFER_CAPACITY) break;
        this.drainOne(state);
        progressed = true;
      }
    }
  }

  /** 取 pending 首帧分配 seq、入未 ack 缓冲并发送（调用方须保证 WS open 且缓冲有余位）。 */
  private drainOne(state: StreamState): void {
    const ws = this.ws!;
    const event = state.pending.shift()!;
    state.sentSeq += 1;
    const frame: Record<string, unknown> =
      event.kind === "pong"
        ? {
            type: "pong",
            client_id: state.clientId,
            stream_id: state.streamId,
            seq_id: state.sentSeq,
            status: event.status,
          }
        : {
            type: "server_message",
            client_id: state.clientId,
            stream_id: state.streamId,
            seq_id: state.sentSeq,
            message: event.message,
          };
    state.buffer.push({ seq: state.sentSeq, frame });
    this.bufferedUsed += 1;
    ws.send(JSON.stringify(frame));
    this.logFrame("agent→wham", frame);
  }

  /**
   * pending 溢出闭环（内存有界）：先合并相邻且同 itemId 的 server_message delta
   * （delta 文本拼接，不丢内容；pong 不参与合并），仍超上限才丢最旧未发送事件
   * （未分配 seq → 无 seq 空洞），记 WARN。已发送未 ack 缓冲永不经过此路径。
   */
  private enforcePendingCap(state: StreamState): void {
    if (state.pending.length <= OUTBOUND_PENDING_CAPACITY) return;
    const merged = this.mergeAdjacentDeltas(state);
    if (merged > 0) {
      this.mergedPendingCount += merged;
      this.log(
        `pending 合并 ${merged} 条相邻 item/agentMessage/delta（${state.clientId}/${state.streamId}）`,
      );
    }
    while (state.pending.length > OUTBOUND_PENDING_CAPACITY) {
      state.pending.shift();
      this.droppedPendingCount += 1;
      this.warn(
        `pending 溢出（${state.clientId}/${state.streamId}）丢弃最旧未发送事件（未分配 seq，无空洞）；` +
          `累计丢弃 ${this.droppedPendingCount}`,
      );
    }
  }

  /** 把 pending 中相邻（队列位置相邻）且同 itemId 的 delta 合并为一条，返回合并次数。 */
  private mergeAdjacentDeltas(state: StreamState): number {
    const merged: PendingEvent[] = [];
    let count = 0;
    for (const event of state.pending) {
      const previous = merged.at(-1);
      if (previous !== undefined && this.mergeDeltaInto(previous, event)) {
        count += 1;
        continue;
      }
      merged.push(event);
    }
    state.pending = merged;
    return count;
  }

  /** 把 next 的 delta 文本并入 previous（同 itemId 的 server_message）；成功返回 true。 */
  private mergeDeltaInto(previous: PendingEvent, next: PendingEvent): boolean {
    // pong 无 delta 语义：任一非 server_message 都不合并
    if (previous.kind !== "server_message" || next.kind !== "server_message") return false;
    const a = deltaNotification(previous.message);
    const b = deltaNotification(next.message);
    if (!a || !b || a.itemId !== b.itemId) return false;
    const target = previous.message as { params?: unknown; emittedAtMs?: unknown };
    const source = next.message as { params: Record<string, unknown>; emittedAtMs?: unknown };
    target.params = { ...source.params, delta: a.delta + b.delta };
    if (source.emittedAtMs !== undefined) {
      target.emittedAtMs = source.emittedAtMs;
    }
    return true;
  }

  // ----------------------------------------------------------------- 故障

  private fault(err: unknown, context: string): void {
    const message = errorMessage(err);
    this.log(`! [${context}] ${message}`);
    this.safeEmit("fault", err, context);
    this.callFaultHandler(err, context);
  }

  /**
   * NIT 2：故障回调的同步 throw 与异步 rejection 都不得反噬 tunnel / 变成
   * unhandledRejection——返回值若是 thenable 必须挂 .catch。
   */
  private callFaultHandler(err: unknown, context: string): void {
    if (!this.onFault) return;
    let result: unknown;
    try {
      result = this.onFault(err, context);
    } catch (handlerErr) {
      this.log(`! [onFault] ${errorMessage(handlerErr)}`);
      return;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void (result as Promise<unknown>).catch((handlerErr) => {
        this.log(`! [onFault async] ${errorMessage(handlerErr)}`);
      });
    }
  }

  private warn(line: string): void {
    this.warnings.push(line);
    this.log(`WARN ${line}`);
    this.safeEmit("warn", line);
  }

  /** 身份相关 WARN：同时进入 warnings 与 identityWarnings（S04 status 出口）。 */
  private warnIdentity(line: string): void {
    this.identityWarnings.push(line);
    this.warn(line);
  }

  /**
   * 逐个调用监听器（rawListeners 保留 once 语义；.call(this) 保持 emit 的
   * this === tunnel 语义），使同步 throw 与返回的 rejected Promise 都不成为
   * unhandledRejection，且单个监听器失败不阻断后续订阅者。
   */
  private safeEmit(event: string, ...args: unknown[]): void {
    for (const listener of this.rawListeners(event)) {
      let result: unknown;
      try {
        result = (listener as (...a: unknown[]) => unknown).call(this, ...args);
      } catch (listenerErr) {
        this.log(`! [emit ${event}] ${errorMessage(listenerErr)}`);
        continue;
      }
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        // 用 Promise.resolve 包一层：合法但无 .catch 的 thenable 不得在 safeEmit 内同步抛错
        void Promise.resolve(result).catch((listenerErr) => {
          this.log(`! [emit ${event} async] ${errorMessage(listenerErr)}`);
        });
      }
    }
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
