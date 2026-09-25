/**
 * wham 反向代理：插在 codex daemon 与 chatgpt.com 之间，落盘全部帧。
 *
 *   codex daemon ──HTTP/WS──▶ 本代理 ──curl(REST)/ws(WS)──▶ chatgpt.com
 *
 * - REST（enroll/refresh/pair/pair/status 及其他 /backend-api/*）：
 *   curl 子进程转发（undici 的 TLS 指纹被 CF 拦，curl 可过）
 * - WS（/backend-api/wham/remote/control/server）：Node ws 双向转发（wss 出站实测不被拦）
 * - 帧落盘 JSONL：{at, dir, frame}，dir ∈ rest-request|rest-response|codex→wham|wham→codex
 *
 * 用法：npm run wham:proxy -- [--port 8788] [--jsonl path]
 * 然后让 codex 用 chatgpt_base_url="http://127.0.0.1:8788/backend-api" 连接。
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const UPSTREAM_HTTP = "https://chatgpt.com";
const UPSTREAM_WS = "wss://chatgpt.com";

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const port = Number(argValue("--port") ?? 8788);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonlPath =
  args.includes("--jsonl") && argValue("--jsonl")
    ? argValue("--jsonl")!
    : join(repoRoot, ".agent-work", "tmp", "wham-probe", `real-${timestamp}.jsonl`);

const log = (line: string) => console.error(`[proxy] ${line}`);
let jsonlQueue: Promise<void> = Promise.resolve();

function logFrame(dir: string, frame: unknown): void {
  jsonlQueue = jsonlQueue
    .then(async () => {
      await mkdir(dirname(jsonlPath), { recursive: true });
      await appendFile(jsonlPath, `${JSON.stringify({ at: new Date().toISOString(), dir, frame })}\n`);
    })
    .catch(() => undefined);
}

/** 脱敏：token 类字段只保留前缀。 */
function redact(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(redact);
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] =
        (key === "remote_control_token" || key === "access_token") && typeof value === "string"
          ? `${value.slice(0, 8)}…(${value.length})`
          : redact(value);
    }
    return out;
  }
  return node;
}

// ------------------------------------------------------------------- REST

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** curl 子进程转发（CF 不拦 curl 指纹）。流式透传：-N 禁缓冲，-D - 头部先行，body 逐块 pipe（支持 SSE）。 */
async function forwardRest(
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const url = `${UPSTREAM_HTTP}${req.url}`;
  const curlArgs: string[] = [
    "-sN",
    "-D", "-",
    "-X", req.method!,
    "--max-time", "300",
    url,
  ];
  for (const [key, value] of Object.entries(req.headers)) {
    if (["host", "content-length", "connection", "accept-encoding", "transfer-encoding"].includes(key)) {
      continue;
    }
    for (const v of Array.isArray(value) ? value : [value]) {
      curlArgs.push("-H", `${key}: ${v}`);
    }
  }
  if (body.length > 0 || req.method === "POST" || req.method === "PUT") {
    curlArgs.push("--data-binary", "@-");
  }
  logFrame("rest-request", {
    method: req.method,
    path: req.url,
    body: redact(safeJson(body.toString("utf8"))),
  });

  const child = spawn("curl", curlArgs, { stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.end(body);
  req.on("close", () => child.kill());

  // stdout: 响应头块（直到 \r\n\r\n）→ 之后是 body 流
  let headerBuf = Buffer.alloc(0);
  let headerDone = false;
  let responseChunks: Buffer[] = [];
  let responseBytes = 0;
  // accounts/check 是小 JSON：缓冲完整响应后改写 workspace_backend_origin。
  // NO_CONSTRAINT 会让 codex 兜底校验本地 chatgpt_base_url（必须 HTTPS）；
  // 改写为真实 origin 后 workspace routing 不再依赖本地 URL。
  const isAccountsCheck = (req.url ?? "").includes("/wham/accounts/check");
  let rewriteBuffer: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    if (headerDone) {
      responseBytes += chunk.length;
      if (responseChunks.length < 50) {
        responseChunks.push(chunk); // 只留前几块用于日志
      }
      if (isAccountsCheck) {
        rewriteBuffer.push(chunk);
        return;
      }
      res.write(chunk);
      return;
    }
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const sep = headerBuf.indexOf("\r\n\r\n");
    if (sep < 0) {
      return;
    }
    const headerText = headerBuf.slice(0, sep).toString("utf8");
    const bodyFirst = headerBuf.slice(sep + 4);
    const lines = headerText.split("\r\n");
    const status = Number(lines[0]?.split(" ")[1] ?? 502);
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.slice(0, idx).trim().toLowerCase();
        if (!["transfer-encoding", "content-length", "connection"].includes(key)) {
          headers[key] = line.slice(idx + 1).trim();
        }
      }
    }
    logFrame("rest-response-headers", { status, path: req.url, headers });
    res.writeHead(status, headers);
    headerDone = true;
    if (bodyFirst.length > 0) {
      responseBytes += bodyFirst.length;
      if (responseChunks.length < 50) {
        responseChunks.push(bodyFirst);
      }
      if (isAccountsCheck) {
        rewriteBuffer.push(bodyFirst);
      } else {
        res.write(bodyFirst);
      }
    }
  });
  child.on("close", (code) => {
    if (isAccountsCheck && rewriteBuffer.length > 0) {
      const raw = Buffer.concat(rewriteBuffer).toString("utf8");
      try {
        const parsed = JSON.parse(raw) as { accounts?: Array<Record<string, unknown>> };
        let rewritten = false;
        for (const account of parsed.accounts ?? []) {
          if (account.workspace_backend_origin === "NO_CONSTRAINT") {
            account.workspace_backend_origin = UPSTREAM_HTTP;
            rewritten = true;
          }
        }
        const out = rewritten ? JSON.stringify(parsed) : raw;
        logFrame("rest-rewrite", { path: req.url, rewritten, body: redact(safeJson(out)) });
        res.end(out);
        return;
      } catch (err) {
        log(`accounts/check 改写失败（原样透传）: ${err instanceof Error ? err.message : err}`);
        res.end(raw);
        return;
      }
    }
    const responseBody = Buffer.concat(responseChunks);
    // SSE 流的逐块内容不落盘（量大且含增量），仅记录前 2KB 摘要
    logFrame("rest-response-body", {
      path: req.url,
      truncated: responseBytes > responseBody.length,
      totalBytes: responseBytes,
      preview: redact(safeJson(responseBody.toString("utf8").slice(0, 2048))),
    });
    res.end();
    if (code !== 0 && code !== null) {
      log(`curl exit=${code} path=${req.url}`);
    }
  });
  child.on("error", (err) => {
    log(`curl spawn 失败: ${err.message}`);
    if (!headerDone) {
      res.writeHead(502);
    }
    res.end();
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

// ------------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ noServer: true });

function proxyWebsocket(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
  const upstreamHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (["host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version",
      "sec-websocket-extensions", "sec-websocket-protocol", "content-length"].includes(key)) {
      continue;
    }
    upstreamHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  const upstream = new WebSocket(`${UPSTREAM_WS}${req.url}`, {
    headers: upstreamHeaders,
  });
  wss.handleUpgrade(req, socket, head, (downstream) => {
    log(`WS 隧道建立：${req.url}`);
    let upstreamOpen = false;
    upstream.on("open", () => {
      upstreamOpen = true;
      log("出站 wss 已连接 chatgpt.com");
    });
    upstream.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        log(`出站 wss 被拒: HTTP ${res.statusCode} ${body.slice(0, 200)}`);
        downstream.close(1011, "upstream rejected");
      });
    });
    upstream.on("error", (err) => {
      log(`出站 wss 错误: ${err.message}`);
      downstream.close(1011, "upstream error");
    });

    downstream.on("message", (data, isBinary) => {
      if (!isBinary) {
        logFrame("codex→wham", safeJson(data.toString()));
      }
      if (upstreamOpen) {
        upstream.send(data, { binary: isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (!isBinary) {
        logFrame("wham→codex", safeJson(data.toString()));
      }
      downstream.send(data, { binary: isBinary });
    });
    // 心跳：WS 协议层 ping 双向转发由各自端点自动/手动应答
    downstream.on("ping", (payload) => upstreamOpen && upstream.pong(payload));
    upstream.on("ping", (payload) => downstream.pong(payload));
    downstream.on("close", (code, reason) => {
      log(`下行关闭: ${code} ${reason.toString()}`);
      upstream.close();
    });
    upstream.on("close", (code, reason) => {
      log(`上行关闭: ${code} ${reason.toString()}`);
      downstream.close();
    });
  });
}

// ------------------------------------------------------------------- server

const server = (() => {
  const handler = (req: IncomingMessage, res: import("node:http").ServerResponse) => {
    void forwardRest(req, res);
  };
  const keyPath = argValue("--tls-key");
  const certPath = argValue("--tls-cert");
  if (keyPath && certPath) {
    return createHttpsServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      handler,
    );
  }
  return createHttpServer(handler);
})();
server.on("upgrade", (req, socket, head) => {
  // 转发全部 WS upgrade：wham 隧道 + LLM responses 流（/backend-api/codex/responses）等。
  // responses WS 连不上会触发 codex 回退 HTTPS 传输并报 workspace HTTPS 错误。
  log(`WS upgrade: ${req.url}`);
  proxyWebsocket(req, socket, head);
});
server.listen(port, "127.0.0.1", () => {
  log(`listening http://127.0.0.1:${port} → ${UPSTREAM_HTTP}`);
  log(`帧日志: ${jsonlPath}`);
  log(
    `等待 codex 连接（config: chatgpt_base_url=http://127.0.0.1:${port}/backend-api）…`,
  );
});

const shutdown = () => {
  log("shutting down…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
