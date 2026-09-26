/**
 * 本地 mock wham 服务器：扮演 chatgpt.com 的 remote control 后端 + 模拟手机端。
 *
 * 用途：让本机 codex（CODEX_HOME 指向 bridge 目录、chatgpt_base_url 指向本服务器）
 * 完成 enroll → WebSocket 隧道，并由「模拟手机」下发 app-server JSON-RPC，
 * 验证完整数据链路并捕获帧序列（协议实证）。
 *
 * 协议来源：codex-rs/app-server-transport/src/transport/remote_control/
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  REST_PATHS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  WS_HEADERS,
  environmentClientPath,
  environmentClientsPath,
  type ClientEnvelope,
  type EnrollRemoteServerRequest,
  type EnrollRemoteServerResponse,
  type JsonRpcMessage,
  type RemoteControlClient,
  type ServerEnvelope,
} from "./protocol.ts";

export interface MockWhamOptions {
  port: number;
  /** JSONL 帧日志路径；不传则不落盘。 */
  jsonlPath?: string;
  /** 连接建立后自动运行模拟手机脚本（initialize → thread/list → thread/start）。 */
  autoScript?: boolean;
  /** 追加 turn/start（会触发上游 LLM 调用）。 */
  turnText?: string;
  /** thread/start 使用的工作目录。 */
  workspace?: string;
  /** 模拟手机脚本起始延迟（毫秒）。 */
  scriptDelayMs?: number;
  /** enroll 发放 token 的有效期（毫秒）；默认 24h。测试注入短 TTL 触发临期续期。 */
  tokenTtlMs?: number;
  /** refresh 轮换后 token 的有效期（毫秒）；默认同 tokenTtlMs。 */
  refreshTokenTtlMs?: number;
  /** 非空时 refresh 端点恒返回该状态码（测试注入 401 验证 enroll 兜底）。 */
  refreshStatusCode?: number;
  /** refresh 成功前的延迟（毫秒），测试注入在途续期以验证 stop 收敛。 */
  refreshDelayMs?: number;
  /**
   * refresh 成功响应上叠加的字段覆盖（测试注入身份漂移：不同 environment_id/server_id）。
   * 不改变 mock 内部 storage。
   */
  refreshResponsePatch?: Partial<EnrollRemoteServerResponse>;
  /**
   * pair 发放的手输码有效期（毫秒）；默认 10min。测试注入短 TTL 触发 S04 自动续码。
   */
  pairTtlMs?: number;
  /**
   * GET clients 强制页大小（测试注入分页穷尽）：>0 时页大小取 min(limit, 该值)，
   * 使少量 client 也能触发 cursor 多页。默认不设（页大小 = limit）。
   */
  forceClientPageSize?: number;
  /**
   * 每次 GET clients 计算完页面、回响应前回调（测试注入时序，如"末页 list 之后才 claim"）。
   * `cursor` = **该请求携带的 cursor**（null=首页）；`responseCursor` = 本次响应返回的下一页游标
   * （null=末页）。回调可新建 client（S04 AC6 复核轮捕获）。
   */
  afterListClients?: (info: {
    environmentId: string;
    cursor: string | null;
    responseCursor: string | null;
    pageSize: number;
    requestIndex: number;
  }) => void | Promise<void>;
  /** 前 N 次 DELETE clients 返回 500（测试注入 S04 吊销失败）。 */
  revokeFailuresRemaining?: number;
  /** 前 N 次 pair 返回 500（测试注入 S04 自动发码瞬时失败 → tick 重试）。 */
  pairFailuresRemaining?: number;
  /** 前 N 次 enroll 返回 500（测试注入"enroll 失败但实例目录已有历史"，enrollCount 仍计次）。 */
  enrollFailuresRemaining?: number;
  /**
   * 是否对 codex 的 server_message 自动回 ack（默认 true，兼容既有用例）。
   * 关闭后需用 ack(seqId, streamId?) 手动确认（重放/未 ack 缓冲测试）。
   */
  autoAck?: boolean;
  log?: (line: string) => void;
}

interface Enrollment {
  serverId: string;
  environmentId: string;
  token: string;
  expiresAt: string;
  installationId: string;
  name: string;
  /** 稳定账号身份（chatgpt-account-id 头优先），幂等键/鉴权的账号维度。 */
  accountIdentity: string;
  accountId: string | null;
}

interface PendingRpc {
  method: string;
  resolve: (msg: JsonRpcMessage) => void;
  timer: NodeJS.Timeout;
}

export class MockWhamServer {
  private readonly opts: Required<Pick<MockWhamOptions, "port">> &
    MockWhamOptions;
  private server!: Server;
  private wss!: WebSocketServer;
  private actualPort = 0;
  private enrollment: Enrollment | null = null;
  /**
   * enroll 幂等（测试脚手架假设）：key=`(稳定账号身份, installation_id)` → 稳定 server/environment。
   * 账号身份=chatgpt-account-id 头（缺失时退化为该次使用的 bearer），因此同账号轮换
   * access token 后再 enroll 仍得同一身份。
   */
  private readonly enrollmentsByKey = new Map<string, Enrollment>();
  /** 账号维度登记历次有效 access token（refresh/clients 鉴权）。 */
  private readonly accountTokens = new Map<string, Set<string>>();
  private codexSocket: WebSocket | null = null;
  private codexHeaders: Record<string, string> = {};
  private nextRpcId = 1;
  private pending = new Map<string, PendingRpc>();
  /** codex → mock 方向的分片重组：key = `${client_id}/${stream_id}`。 */
  private reassembler = new Map<string, Map<number, ServerEnvelope>>();
  private jsonlQueue: Promise<void> = Promise.resolve();
  private closed = false;
  /** 模拟手机身份（envelope 字段用）。 */
  readonly mobileClientId = "mock-mobile-client";
  readonly mobileStreamId = randomUUID();
  /** 探测结果汇总（脚本跑完后填充）。 */
  readonly scriptResults: Array<{ method: string; response: unknown }> = [];
  /** 收到的 codex 通知（method+params，测试断言用）。 */
  readonly receivedNotifications: Array<{ method: string; params: unknown }> = [];
  /**
   * 按 (client_id, stream_id, seq_id) 去重后的通知序列（重连重放不会重复计数），
   * 保留 seqId 以断言「每条恰好一次、seq 全序无空洞」。原 receivedNotifications
   * 保持原样（含重放造成的重复），供既有断言与重放计数。
   */
  readonly dedupedNotifications: Array<{ seqId: number; method: string; params: unknown }> = [];
  private readonly dedupedNotificationKeys = new Set<string>();
  /**
   * server_message 到达时序（响应/服务器请求/通知同序记录，测试断言
   * 「响应先于某通知上线」的线上顺序用——分片消息在重组后记录一次）。
   */
  readonly receivedEnvelopeLog: Array<{
    seqId: number;
    kind: "response" | "serverRequest" | "notification";
    id?: string | number;
    method?: string;
  }> = [];
  /** 收到的 codex 请求（codex 主动发起，如 attestation/generate）。 */
  readonly receivedServerRequests: Array<{ method: string; params: unknown }> = [];
  /** 收到的 server_message 帧 seq_id 序列（按到达顺序）。 */
  readonly receivedSeqIds: number[] = [];
  /** 收到的 pong 帧（心跳断言用）；seq_id 供重放/seq 连续性断言（pong 也占 per-stream seq）。 */
  readonly receivedPongs: Array<{
    client_id: string;
    stream_id: string;
    status?: string;
    seq_id?: number;
  }> = [];
  /** clients 管理端点每次请求（CLI/测试断言分页参数与鉴权头）。 */
  readonly clientsRequests: Array<{
    method: "GET" | "DELETE";
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
  }> = [];
  /** 「已配对客户端」按 environment 归属存储（BLOCKER 4：跨 env 不泄漏）。 */
  private readonly clientsByEnvironment = new Map<string, RemoteControlClient[]>();
  /** 被 DELETE 吊销过的 client_id 集合。 */
  readonly revokedClients = new Set<string>();
  /** 端点调用计数（AC7 的「enroll 增量为 0」判据）。 */
  enrollCount = 0;
  refreshCount = 0;
  /**
   * S04 配对 claim 模拟：pair(manual_code) 发放的手输码 → {environmentId, claimed}。
   * `addClient(environmentId, …)` 视为该 environment 下发的手输码均已 claim（模拟手机配对成功）。
   */
  private readonly pendingPairings = new Map<
    string,
    { environmentId: string; claimed: boolean }
  >();
  /** 手输码序号：首个 = "123-456"（保持既有探测断言），后续递增互异。 */
  private manualCodeSeq = 0;
  /** pair 请求记录（测试断言码生成/覆盖）。 */
  readonly pairRequests: Array<{
    body: unknown;
    headers: Record<string, string>;
    response: unknown;
  }> = [];
  /** pair/status 请求记录（测试断言轮询所用 token 与是否成功）。 */
  readonly pairStatusRequests: Array<{
    body: unknown;
    headers: Record<string, string>;
    claimed: boolean;
    /** HTTP 2xx = true；401（token 过期/未知）等 = false（AC5 断言新 token 轮询成功）。 */
    ok: boolean;
  }> = [];
  /** 剩余强制失败的 DELETE 次数（测试注入吊销失败；运行期可改）。 */
  revokeFailuresRemaining = 0;
  /** 剩余强制失败的 pair 次数（测试注入发码失败；运行期可改）。 */
  pairFailuresRemaining = 0;
  /** 剩余强制失败的 enroll 次数（测试注入 enroll 失败；计数仍递增）。 */
  enrollFailuresRemaining = 0;
  /** 是否自动回 ack（默认 true）。测试可运行期置 false，再用 ack(seqId) 手动确认。 */
  autoAck: boolean;
  private listRequestCount = 0;

  constructor(opts: MockWhamOptions) {
    this.opts = opts;
    this.autoAck = opts.autoAck ?? true;
  }

  get port(): number {
    return this.actualPort;
  }

  async start(): Promise<void> {
    this.revokeFailuresRemaining = this.opts.revokeFailuresRemaining ?? 0;
    this.pairFailuresRemaining = this.opts.pairFailuresRemaining ?? 0;
    this.enrollFailuresRemaining = this.opts.enrollFailuresRemaining ?? 0;
    const address = await new Promise<string>((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.handleRest(req, res);
      });
      this.server.once("error", reject);
      this.server.listen(this.opts.port, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.actualPort = addr.port;
          resolve(`127.0.0.1:${addr.port}`);
        } else {
          reject(new Error("无法确定监听地址"));
        }
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const { pathname } = new URL(req.url ?? "/", `http://${address}`);
      if (pathname !== REST_PATHS.websocket) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleCodexSocket(ws, req);
      });
    });
    this.log(`mock wham listening on http://${address}`);
  }

  async stop(): Promise<void> {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
    // 终止所有活动客户端 socket（含故障注入场景下 daemon 侧未在 codexSocket 引用的旧连接），
    // 避免测试进程因残留句柄不退出。
    for (const client of this.wss?.clients ?? []) {
      client.terminate();
    }
    this.codexSocket?.close();
    this.wss?.close();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  // ------------------------------------------------------------------ REST

  private async handleRest(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.opts.port}`);

    // clients 管理端点（GET list / DELETE revoke）：账号 token 鉴权
    if (url.pathname.startsWith(`${REST_PATHS.environments}/`)) {
      await this.handleClientsRequest(req, res, url);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const body = await readBody(req);
    await this.logFrame("rest-request", { path: url.pathname, body: safeJson(body) });

    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (url.pathname === REST_PATHS.enroll) {
      this.enrollCount += 1;
      if (this.enrollFailuresRemaining > 0) {
        this.enrollFailuresRemaining -= 1;
        await this.replyJson(res, { error: "injected_enroll_failure" }, 500);
        return;
      }
      const request = JSON.parse(body) as EnrollRemoteServerRequest;
      const accountId = headerValue(req, "chatgpt-account-id");
      // 稳定账号身份：优先 account id，其次该次 bearer（无账号头的本地探测）
      const accountIdentity = accountId ?? (bearer ? `token:${bearer}` : "anonymous");
      if (bearer) {
        // 登记该账号历次有效 token（refresh/clients 鉴权按账号维度接受）
        const tokens = this.accountTokens.get(accountIdentity) ?? new Set<string>();
        tokens.add(bearer);
        this.accountTokens.set(accountIdentity, tokens);
      }
      // 幂等（测试脚手架假设）：同 (账号身份, installation_id) 稳定返回同一 server/environment
      const key = `${accountIdentity}|${request.installation_id}`;
      const existing = this.enrollmentsByKey.get(key);
      const serverId = existing?.serverId ?? `srv_${randomUUID()}`;
      const environmentId = existing?.environmentId ?? `env_${randomUUID()}`;
      this.enrollment = {
        serverId,
        environmentId,
        token: `rct_${randomUUID()}`,
        expiresAt: this.expiryFromNow(this.opts.tokenTtlMs ?? 24 * 3600_000),
        installationId: request.installation_id,
        name: request.name,
        accountIdentity,
        accountId,
      };
      this.enrollmentsByKey.set(key, this.enrollment);
      this.log(
        `enroll: name=${request.name} os=${request.os} arch=${request.arch} ` +
          `app_server_version=${request.app_server_version} installation_id=${request.installation_id} ` +
          `(server_id=${serverId}${existing ? " 复用" : " 新建"})`,
      );
      await this.replyJson(res, enrollResponse(this.enrollment));
      return;
    }
    if (url.pathname === REST_PATHS.refresh) {
      this.refreshCount += 1;
      if (typeof this.opts.refreshStatusCode === "number") {
        await this.replyJson(res, { error: "injected_refresh_failure" }, this.opts.refreshStatusCode);
        return;
      }
      if (this.opts.refreshDelayMs) {
        await new Promise((r) => setTimeout(r, this.opts.refreshDelayMs));
      }
      // 鉴权=账号 token（该账号历次有效 token 集合）+ x-codex-installation-id
      const installationId = headerValue(req, "x-codex-installation-id");
      if (
        !this.enrollment ||
        !this.accountTokenIsValid(this.enrollment, bearer) ||
        installationId !== this.enrollment.installationId
      ) {
        await this.replyJson(res, { error: "invalid_token" }, 401);
        return;
      }
      const request = JSON.parse(body) as { server_id: string; installation_id: string };
      if (request.server_id !== this.enrollment.serverId) {
        await this.replyJson(res, { error: "server_id_mismatch" }, 400);
        return;
      }
      this.enrollment.token = `rct_${randomUUID()}`;
      this.enrollment.expiresAt = this.expiryFromNow(
        this.opts.refreshTokenTtlMs ?? this.opts.tokenTtlMs ?? 24 * 3600_000,
      );
      this.log(`refresh: server_id=${request.server_id} → 新 token`);
      const response = enrollResponse(this.enrollment);
      if (this.opts.refreshResponsePatch) {
        Object.assign(response, this.opts.refreshResponsePatch);
      }
      await this.replyJson(res, response);
      return;
    }
    if (url.pathname === REST_PATHS.pair) {
      if (!this.enrollment || bearer !== this.enrollment.token) {
        await this.replyJson(res, { error: "invalid_token" }, 401);
        return;
      }
      const request = JSON.parse(body) as { manual_code: boolean };
      if (this.pairFailuresRemaining > 0) {
        this.pairFailuresRemaining -= 1;
        this.pairRequests.push({ body: request, headers: headerRecord(req), response: { error: "injected_pair_failure" } });
        await this.replyJson(res, { error: "injected_pair_failure" }, 500);
        return;
      }
      const manualCode = request.manual_code ? this.nextManualCode() : null;
      if (manualCode) {
        this.pendingPairings.set(manualCode, {
          environmentId: this.enrollment.environmentId,
          claimed: false,
        });
      }
      const response = {
        pairing_code: `pc_${randomUUID().slice(0, 8)}`,
        manual_pairing_code: manualCode,
        server_id: this.enrollment.serverId,
        environment_id: this.enrollment.environmentId,
        expires_at: new Date(Date.now() + (this.opts.pairTtlMs ?? 10 * 60_000)).toISOString(),
      };
      this.pairRequests.push({ body: request, headers: headerRecord(req), response });
      this.log(`pair: ${JSON.stringify(request)} → ${JSON.stringify(response)}`);
      await this.replyJson(res, response);
      return;
    }
    if (url.pathname === REST_PATHS.pairStatus) {
      const request = JSON.parse(body) as {
        pairing_code?: string;
        manual_pairing_code?: string;
      };
      const manual = request.manual_pairing_code;
      if (manual !== undefined) {
        // S04 claim 轮询：只传 manualPairingCode + remoteControlToken。
        // token 已轮换时旧 token 一律 401（pairStatusRequests.ok=false 供 AC5 断言）。
        if (!this.remoteControlTokenIsValid(bearer)) {
          this.pairStatusRequests.push({
            body: request,
            headers: headerRecord(req),
            claimed: false,
            ok: false,
          });
          await this.replyJson(res, { error: "invalid_token" }, 401);
          return;
        }
        const claimed = this.pendingPairings.get(manual)?.claimed ?? false;
        this.pairStatusRequests.push({ body: request, headers: headerRecord(req), claimed, ok: true });
        this.log(`pair/status: ${body} → ${JSON.stringify({ claimed })}`);
        await this.replyJson(res, { claimed });
        return;
      }
      // 兼容旧探测语义：无 manual code → claimed=true（手机端就是 mock 自己）
      this.pairStatusRequests.push({ body: request, headers: headerRecord(req), claimed: true, ok: true });
      this.log(`pair/status: ${body} → {"claimed":true}`);
      await this.replyJson(res, { claimed: true });
      return;
    }
    res.writeHead(404).end();
  }

  private expiryFromNow(ttlMs: number): string {
    return new Date(Date.now() + ttlMs).toISOString();
  }

  /**
   * GET/DELETE `/backend-api/wham/remote/control/environments/{env}/clients[/{id}]`。
   * 账号 token 鉴权（非 remote_control_token bearer）；limit ∈ 1..=100；order asc|desc；
   * cursor 为不透明分页游标（此处用偏移编码）。
   */
  private async handleClientsRequest(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
    url: URL,
  ): Promise<void> {
    const prefix = `${REST_PATHS.environments}/`;
    const rest = url.pathname.slice(prefix.length);
    const segments = rest.split("/").filter(Boolean);
    const environmentId = decodeURIComponent(segments[0] ?? "");
    const isClientsPath = segments[1] === "clients";
    const clientId = segments[2] ? decodeURIComponent(segments[2]) : null;
    const method = req.method === "DELETE" ? "DELETE" : req.method === "GET" ? "GET" : null;
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    if (method) {
      this.clientsRequests.push({
        method,
        path: url.pathname,
        query,
        headers: headerRecord(req),
      });
    }
    await this.logFrame("rest-request", {
      path: url.pathname,
      method: req.method,
      query,
    });

    if (!isClientsPath || !method) {
      res.writeHead(405).end();
      return;
    }
    const enrollment = this.enrollmentForEnvironment(environmentId);
    if (!enrollment) {
      await this.replyJson(res, { error: "environment_not_found" }, 404);
      return;
    }
    // 账号鉴权：该账号历次有效 token（非 remote_control_token）
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const accountId = headerValue(req, "chatgpt-account-id");
    if (
      !this.accountTokenIsValid(enrollment, bearer) ||
      (enrollment.accountId !== null && accountId !== enrollment.accountId)
    ) {
      await this.replyJson(res, { error: "invalid_account_token" }, 401);
      return;
    }

    // BLOCKER 4：客户端按 environment 归属操作，绝不跨 env
    const envClients = this.clientsByEnvironment.get(environmentId) ?? [];

    if (method === "DELETE") {
      if (this.revokeFailuresRemaining > 0) {
        this.revokeFailuresRemaining -= 1;
        await this.replyJson(res, { error: "injected_revoke_failure" }, 500);
        return;
      }
      if (!clientId) {
        await this.replyJson(res, { error: "client_id_required" }, 400);
        return;
      }
      const idx = envClients.findIndex((c) => c.client_id === clientId);
      if (idx < 0) {
        await this.replyJson(res, { error: "client_not_found" }, 404);
        return;
      }
      envClients.splice(idx, 1);
      this.revokedClients.add(clientId);
      this.log(`clients revoke: ${clientId} (env=${environmentId})`);
      // 2xx 空 body（WhamClient.revokeClient 必须容忍）
      res.writeHead(204).end();
      return;
    }

    // GET list
    const limitRaw = url.searchParams.get("limit");
    let limit = 100;
    if (limitRaw !== null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        await this.replyJson(res, { error: "limit must be between 1 and 100" }, 400);
        return;
      }
    }
    const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
    const offset = decodeCursor(url.searchParams.get("cursor"));
    const sorted = [...envClients].sort((a, b) => {
      const at = Date.parse(a.last_seen_at ?? "") || 0;
      const bt = Date.parse(b.last_seen_at ?? "") || 0;
      return order === "asc" ? at - bt : bt - at;
    });
    // 强制页大小（测试注入）：仅影响响应分页，不改变客户端传入 limit 的语义
    const pageSize =
      this.opts.forceClientPageSize && this.opts.forceClientPageSize > 0
        ? Math.min(limit, this.opts.forceClientPageSize)
        : limit;
    const page = sorted.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    const cursor = nextOffset < sorted.length ? encodeCursor(nextOffset) : null;
    this.listRequestCount += 1;
    if (this.opts.afterListClients) {
      await this.opts.afterListClients({
        environmentId,
        cursor: url.searchParams.get("cursor"),
        responseCursor: cursor,
        pageSize: page.length,
        requestIndex: this.listRequestCount,
      });
    }
    await this.replyJson(res, { items: page, cursor });
  }

  /** 手输码：首个 "123-456"（保持既有探测断言），后续 "123-457" … 互异。 */
  private nextManualCode(): string {
    this.manualCodeSeq += 1;
    return `123-${String(455 + this.manualCodeSeq).padStart(3, "0")}`;
  }

  /** remote_control_token 有效性（pair/status 的 bearer；含 refresh 轮换后的旧值）。 */
  private remoteControlTokenIsValid(bearer: string): boolean {
    if (!bearer) return false;
    if (this.enrollment?.token === bearer) return true;
    for (const enrollment of this.enrollmentsByKey.values()) {
      if (enrollment.token === bearer) return true;
    }
    return false;
  }

  /** 账号鉴权：bearer ∈ 该账号历次有效 token 集合，且不同于 remote_control_token。 */
  private accountTokenIsValid(enrollment: Enrollment, bearer: string): boolean {
    if (!bearer) return false;
    if (bearer === enrollment.token) return false; // 明确拒绝 remote_control_token
    return this.accountTokens.get(enrollment.accountIdentity)?.has(bearer) ?? false;
  }

  private enrollmentForEnvironment(environmentId: string): Enrollment | null {
    if (this.enrollment?.environmentId === environmentId) {
      return this.enrollment;
    }
    for (const enrollment of this.enrollmentsByKey.values()) {
      if (enrollment.environmentId === environmentId) {
        return enrollment;
      }
    }
    return null;
  }

  /**
   * 测试脚手架：给指定 environment 播种一个已配对客户端
   * （last_seen_at 默认按该 env 内播种顺序递减）。
   */
  addClient(
    environmentId: string,
    client: Partial<RemoteControlClient> & { client_id?: string } = {},
  ): RemoteControlClient {
    const list = this.clientsByEnvironment.get(environmentId) ?? [];
    const entry: RemoteControlClient = {
      client_id: client.client_id ?? `cli_${randomUUID()}`,
      display_name: client.display_name ?? "mock device",
      device_type: client.device_type ?? "phone",
      platform: client.platform ?? "ios",
      os_version: client.os_version ?? "18.0",
      device_model: client.device_model ?? "iPhone",
      app_version: client.app_version ?? "1.0.0",
      last_seen_at:
        client.last_seen_at ?? new Date(Date.now() - list.length * 1000).toISOString(),
    };
    list.push(entry);
    this.clientsByEnvironment.set(environmentId, list);
    // S04 claim 模拟：该 environment 下发的手输码视为已 claim（手机配对成功）
    for (const pending of this.pendingPairings.values()) {
      if (pending.environmentId === environmentId) {
        pending.claimed = true;
      }
    }
    return entry;
  }

  /** 某 environment 当前已配对客户端快照（测试断言用）。 */
  clientsFor(environmentId: string): RemoteControlClient[] {
    return [...(this.clientsByEnvironment.get(environmentId) ?? [])];
  }

  private async replyJson(
    res: import("node:http").ServerResponse,
    body: unknown,
    status = 200,
  ): Promise<void> {
    const payload = JSON.stringify(body);
    await this.logFrame("rest-response", { status, body: safeJson(payload) });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
  }

  // -------------------------------------------------------------- WebSocket

  private handleCodexSocket(ws: WebSocket, req: IncomingMessage): void {
    this.codexSocket = ws;
    this.reassembler.clear();
    this.codexHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      this.codexHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    const decodedName = this.codexHeaders[WS_HEADERS.name]
      ? Buffer.from(this.codexHeaders[WS_HEADERS.name], "base64").toString("utf8")
      : "(none)";
    this.log(
      `codex websocket connected: server_id=${this.codexHeaders[WS_HEADERS.serverId] ?? "?"} ` +
        `name=${decodedName} protocol=${this.codexHeaders[WS_HEADERS.protocolVersion] ?? "?"} ` +
        `installation_id=${this.codexHeaders[WS_HEADERS.installationId] ?? "?"} ` +
        `subscribe_cursor=${this.codexHeaders[WS_HEADERS.subscribeCursor] ?? "(none)"}`,
    );

    ws.on("message", (data) => {
      const text = data.toString();
      let envelope: ServerEnvelope;
      try {
        envelope = JSON.parse(text) as ServerEnvelope;
      } catch {
        this.log(`! 无法解析帧: ${text.slice(0, 200)}`);
        return;
      }
      void this.logFrame("codex→mock", envelope);
      this.handleServerEnvelope(envelope).catch((err) =>
        this.log(`! handleServerEnvelope 出错: ${err}`),
      );
    });
    ws.on("close", (code, reason) => {
      this.log(`codex websocket closed: ${code} ${reason.toString()}`);
      this.codexSocket = null;
    });
    ws.on("error", (err) => this.log(`codex websocket error: ${err}`));

    if (this.opts.autoScript !== false) {
      const delay = this.opts.scriptDelayMs ?? 1500;
      setTimeout(() => {
        void this.runMobileScript();
      }, delay);
    }
  }

  /**
   * 只断开 codex↔mock 的 WS（模拟隧道掉线），HTTP/WSS 监听保持，供重连/重放测试。
   * 不置 closed，不影响 REST 与后续重连（新连接由 tunnel 侧 scheduleReconnect 发起）。
   */
  dropCodexSocket(): void {
    const ws = this.codexSocket;
    this.codexSocket = null;
    ws?.terminate();
  }

  /**
   * 处理 codex → mock 的 ServerEnvelope。
   * 收到 server_message（或重组完成的分片）后回 Ack（ClientEvent），
   * 并把 JSON-RPC 响应匹配给 pending 请求。
   */
  private async handleServerEnvelope(envelope: ServerEnvelope): Promise<void> {
    switch (envelope.type) {
      case "server_message": {
        if (this.autoAck) this.ack(envelope.seq_id, envelope.stream_id);
        this.receivedSeqIds.push(envelope.seq_id);
        const message = envelope.message;
        if (!message) {
          return;
        }
        if ("id" in message && ("result" in message || "error" in message)) {
          this.receivedEnvelopeLog.push({ seqId: envelope.seq_id, kind: "response", id: message.id });
          const pending = this.pending.get(String(message.id));
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(String(message.id));
            pending.resolve(message);
          } else {
            this.log(`? 未匹配的响应 id=${String(message.id)}`);
          }
        } else if ("method" in message) {
          // codex 主动通知 / codex 发起的请求（如 approval 请求）
          if ("id" in message) {
            this.receivedEnvelopeLog.push({
              seqId: envelope.seq_id,
              kind: "serverRequest",
              id: message.id,
              method: message.method,
            });
            this.receivedServerRequests.push({ method: message.method, params: message.params });
          } else {
            this.receivedEnvelopeLog.push({
              seqId: envelope.seq_id,
              kind: "notification",
              method: message.method,
            });
            this.receivedNotifications.push({ method: message.method, params: message.params });
            const dedupKey = `${envelope.client_id}/${envelope.stream_id}/${envelope.seq_id}`;
            if (!this.dedupedNotificationKeys.has(dedupKey)) {
              this.dedupedNotificationKeys.add(dedupKey);
              this.dedupedNotifications.push({
                seqId: envelope.seq_id,
                method: message.method,
                params: message.params,
              });
            }
          }
          this.log(
            `← codex ${"id" in message ? `request(${message.method})` : `notify(${message.method})`} ` +
              `${JSON.stringify(message.params ?? {}).slice(0, 300)}`,
          );
        }
        return;
      }
      case "server_message_chunk": {
        if (this.autoAck) this.ack(envelope.seq_id, envelope.stream_id, envelope.segment_id);
        const key = `${envelope.client_id}/${envelope.stream_id}`;
        let segments = this.reassembler.get(key);
        if (!segments) {
          segments = new Map();
          this.reassembler.set(key, segments);
        }
        segments.set(envelope.segment_id ?? 0, envelope);
        if (segments.size < (envelope.segment_count ?? 1)) {
          return;
        }
        // 全部分片到齐：按序拼接 base64 → JSON
        this.reassembler.delete(key);
        const ordered = [...segments.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, seg]) => seg.message_chunk_base64 ?? "");
        const jsonText = Buffer.from(ordered.join(""), "base64").toString("utf8");
        try {
          const message = JSON.parse(jsonText) as JsonRpcMessage;
          this.log(`◦ 重组完成分片消息（${envelope.segment_count} 段）`);
          await this.handleServerEnvelope({
            type: "server_message",
            client_id: envelope.client_id,
            stream_id: envelope.stream_id,
            seq_id: envelope.seq_id,
            message,
          });
        } catch (err) {
          this.log(`! 分片重组失败: ${err}`);
        }
        return;
      }
      case "pong":
        // pong 与 server_message 同走 codex 的有界可靠层（占 per-stream seq、入未 ack 缓冲），
        // 故真实手机/后端会对所有信封回 ack。仅 autoAck 时同步回 ack（带该帧 seq_id/stream_id），
        // 否则连续 pong 会占满 128 缓冲造成假背压。autoAck 关闭时由测试手动 ack(seq_id, stream_id)。
        if (this.autoAck) this.ack(envelope.seq_id, envelope.stream_id);
        this.receivedPongs.push({
          client_id: envelope.client_id,
          stream_id: envelope.stream_id,
          status: envelope.status,
          seq_id: envelope.seq_id,
        });
        this.log(`pong (status=${envelope.status ?? "?"}, seq_id=${envelope.seq_id ?? "?"})`);
        return;
      case "ack":
        this.log(`ack（服务器方向的 ack，一般不出现）: seq_id=${envelope.seq_id}`);
        return;
    }
  }

  /**
   * 确认 codex 发出的 envelope（ClientEvent::Ack）。autoAck 关闭时由测试手动调用
   * （streamId 省略 = 模拟手机默认 stream，与 rpc 下发的 stream 一致）。
   */
  ack(seqId: number, streamId: string = this.mobileStreamId, segmentId?: number): void {
    this.sendClientEnvelope({
      type: "ack",
      client_id: this.mobileClientId,
      stream_id: streamId,
      seq_id: seqId,
      segment_id: segmentId,
    });
  }

  // ------------------------------------------------------------- 模拟手机端

  /** 以模拟手机身份下发一个 JSON-RPC 请求给 codex，等待响应。 */
  rpc(method: string, params?: unknown, timeoutMs = 30_000, streamId?: string): Promise<JsonRpcMessage> {
    const id = this.nextRpcId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`rpc ${method} 超时`));
      }, timeoutMs);
      this.pending.set(String(id), {
        method,
        resolve: (msg) => resolve(msg),
        timer,
      });
      this.sendClientEnvelope({
        type: "client_message",
        client_id: this.mobileClientId,
        stream_id: streamId ?? this.mobileStreamId,
        message,
      });
      this.log(`→ codex ${method} (id=${id})`);
    });
  }

  /** 以模拟手机身份发送一个 ping 帧（codex 应答 pong）。 */
  sendPing(streamId = this.mobileStreamId): void {
    this.sendClientEnvelope({
      type: "ping",
      client_id: this.mobileClientId,
      stream_id: streamId,
    });
  }

  private async runMobileScript(): Promise<void> {
    if (this.closed || !this.codexSocket) {
      return;
    }
    const steps: Array<{ method: string; params?: unknown }> = [
      {
        method: "initialize",
        params: {
          // JSON-RPC 参数为 camelCase（app-server-protocol serde rename_all）
          clientInfo: {
            name: "codex_mobile_probe",
            title: "ChatGPT Mobile (mock)",
            version: "0.1.0",
          },
        },
      },
      { method: "thread/list", params: {} },
      {
        method: "thread/start",
        params: { cwd: this.opts.workspace ?? process.cwd() },
      },
    ];
    for (const step of steps) {
      try {
        const response = await this.rpc(step.method, step.params);
        this.scriptResults.push({ method: step.method, response });
        if ("error" in response && response.error) {
          this.log(`✗ ${step.method} 错误: ${JSON.stringify(response.error)}`);
        } else {
          this.log(`✓ ${step.method}: ${JSON.stringify(("result" in response && response.result) ?? null).slice(0, 400)}`);
        }
      } catch (err) {
        this.log(`✗ ${step.method} 失败: ${err instanceof Error ? err.message : err}`);
        break;
      }
    }
    if (this.opts.turnText) {
      const started = this.scriptResults.find((r) => r.method === "thread/start");
      const result = started?.response as
        | { result?: { thread_id?: string } }
        | undefined;
      const threadId = result?.result?.thread_id;
      if (!threadId) {
        this.log("✗ turn/start 跳过：未拿到 thread_id");
      } else {
        try {
          const response = await this.rpc("turn/start", {
            thread_id: threadId,
            input: [{ type: "text", text: this.opts.turnText }],
          });
          this.scriptResults.push({ method: "turn/start", response });
          this.log(`✓ turn/start: ${JSON.stringify(response).slice(0, 300)}`);
        } catch (err) {
          this.log(`✗ turn/start 失败: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    this.log(
      `模拟手机脚本完成：${this.scriptResults.length} 个方法调用成功记录（继续保活等待 codex 事件）`,
    );
  }

  // ---------------------------------------------------------------- helpers

  /**
   * 向 codex 发送 ClientEnvelope（手机/服务器方向）。`cursor` 非空时附加订阅游标字段
   * （T6：验证 tunnel 以 x-codex-subscribe-cursor 重连）。
   */
  sendClientEnvelope(envelope: ClientEnvelope, cursor?: string): void {
    if (!this.codexSocket || this.codexSocket.readyState !== 1 /* OPEN */) {
      this.log(`! 发送失败（连接未就绪）: ${envelope.type}`);
      return;
    }
    const frame = cursor === undefined ? envelope : { ...envelope, cursor };
    this.codexSocket.send(JSON.stringify(frame));
    void this.logFrame("mock→codex", frame);
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.error(`[wham] ${l}`)))(line);
  }

  private logFrame(dir: string, frame: unknown): Promise<void> {
    if (!this.opts.jsonlPath) {
      return Promise.resolve();
    }
    const record = JSON.stringify({ at: new Date().toISOString(), dir, frame });
    this.jsonlQueue = this.jsonlQueue
      .then(async () => {
        await mkdir(dirname(this.opts.jsonlPath!), { recursive: true });
        await appendFile(this.opts.jsonlPath!, `${record}\n`);
      })
      .catch(() => undefined);
    return this.jsonlQueue;
  }
}

function enrollResponse(enrollment: Enrollment): EnrollRemoteServerResponse {
  return {
    server_id: enrollment.serverId,
    environment_id: enrollment.environmentId,
    remote_control_token: enrollment.token,
    expires_at: enrollment.expiresAt,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value.join(", ");
  return value ?? null;
}

/** 所有请求头（小写名）快照，测试断言鉴权头用。 */
function headerRecord(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/** 不透明分页游标（mock 内部用偏移编码，对客户端保持不透明）。 */
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: number;
    };
    return typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}
