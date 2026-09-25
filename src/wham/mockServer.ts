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
  type ClientEnvelope,
  type EnrollRemoteServerRequest,
  type EnrollRemoteServerResponse,
  type JsonRpcMessage,
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
  log?: (line: string) => void;
}

interface Enrollment {
  serverId: string;
  environmentId: string;
  token: string;
  expiresAt: string;
  installationId: string;
  name: string;
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

  constructor(opts: MockWhamOptions) {
    this.opts = opts;
  }

  get port(): number {
    return this.actualPort;
  }

  async start(): Promise<void> {
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
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const body = await readBody(req);
    await this.logFrame("rest-request", { path: url.pathname, body: safeJson(body) });

    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (url.pathname === REST_PATHS.enroll) {
      const request = JSON.parse(body) as EnrollRemoteServerRequest;
      this.enrollment = {
        serverId: `srv_${randomUUID()}`,
        environmentId: `env_${randomUUID()}`,
        token: `rct_${randomUUID()}`,
        // token 24h 有效（codex 侧过期前 5 分钟会 refresh）
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        installationId: request.installation_id,
        name: request.name,
      };
      this.log(
        `enroll: name=${request.name} os=${request.os} arch=${request.arch} ` +
          `app_server_version=${request.app_server_version} installation_id=${request.installation_id}`,
      );
      await this.replyJson(res, enrollResponse(this.enrollment));
      return;
    }
    if (url.pathname === REST_PATHS.refresh) {
      if (!this.enrollment || bearer !== this.enrollment.token) {
        await this.replyJson(res, { error: "invalid_token" }, 401);
        return;
      }
      const request = JSON.parse(body) as { server_id: string; installation_id: string };
      if (request.server_id !== this.enrollment.serverId) {
        await this.replyJson(res, { error: "server_id_mismatch" }, 400);
        return;
      }
      this.enrollment.token = `rct_${randomUUID()}`;
      this.enrollment.expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
      this.log(`refresh: server_id=${request.server_id} → 新 token`);
      await this.replyJson(res, enrollResponse(this.enrollment));
      return;
    }
    if (url.pathname === REST_PATHS.pair) {
      if (!this.enrollment || bearer !== this.enrollment.token) {
        await this.replyJson(res, { error: "invalid_token" }, 401);
        return;
      }
      const request = JSON.parse(body) as { manual_code: boolean };
      const response = {
        pairing_code: `pc_${randomUUID().slice(0, 8)}`,
        manual_pairing_code: request.manual_code ? "123-456" : null,
        server_id: this.enrollment.serverId,
        environment_id: this.enrollment.environmentId,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
      this.log(`pair: ${JSON.stringify(request)} → ${JSON.stringify(response)}`);
      await this.replyJson(res, response);
      return;
    }
    if (url.pathname === REST_PATHS.pairStatus) {
      // 模拟手机已 claim：直接 claimed=true（探测时手机端就是 mock 自己）
      const response = { claimed: true };
      this.log(`pair/status: ${body} → ${JSON.stringify(response)}`);
      await this.replyJson(res, response);
      return;
    }
    res.writeHead(404).end();
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
   * 处理 codex → mock 的 ServerEnvelope。
   * 收到 server_message（或重组完成的分片）后回 Ack（ClientEvent），
   * 并把 JSON-RPC 响应匹配给 pending 请求。
   */
  private async handleServerEnvelope(envelope: ServerEnvelope): Promise<void> {
    switch (envelope.type) {
      case "server_message": {
        this.ack(envelope.seq_id, envelope.stream_id);
        const message = envelope.message;
        if (!message) {
          return;
        }
        if ("id" in message && ("result" in message || "error" in message)) {
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
          this.log(
            `← codex ${"id" in message ? `request(${message.method})` : `notify(${message.method})`} ` +
              `${JSON.stringify(message.params ?? {}).slice(0, 300)}`,
          );
        }
        return;
      }
      case "server_message_chunk": {
        this.ack(envelope.seq_id, envelope.stream_id, envelope.segment_id);
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
        this.log(`pong (status=${envelope.status ?? "?"})`);
        return;
      case "ack":
        this.log(`ack（服务器方向的 ack，一般不出现）: seq_id=${envelope.seq_id}`);
        return;
    }
  }

  /** 确认 codex 发出的 envelope（ClientEvent::Ack）。 */
  private ack(seqId: number, streamId: string, segmentId?: number): void {
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
  rpc(method: string, params?: unknown, timeoutMs = 30_000): Promise<JsonRpcMessage> {
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
        stream_id: this.mobileStreamId,
        message,
      });
      this.log(`→ codex ${method} (id=${id})`);
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

  /** 向 codex 发送 ClientEnvelope（手机/服务器方向）。 */
  private sendClientEnvelope(envelope: ClientEnvelope): void {
    if (!this.codexSocket || this.codexSocket.readyState !== 1 /* OPEN */) {
      this.log(`! 发送失败（连接未就绪）: ${envelope.type}`);
      return;
    }
    this.codexSocket.send(JSON.stringify(envelope));
    void this.logFrame("mock→codex", envelope);
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
