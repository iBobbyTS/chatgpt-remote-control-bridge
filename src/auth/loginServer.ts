/**
 * 本地 OAuth 回调服务器（对齐 codex-rs/login/src/server.rs 的 LoginServer）。
 *
 * - 首选 127.0.0.1:1455，占用时先向旧实例发 GET /cancel，仍占用则回退 1457
 *   （server.rs bind_server + FALLBACK_PORT）
 * - 回调路径 /auth/callback，校验 state；支持 provider error 展示
 */
import {
  createServer,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import {
  DEFAULT_LOGIN_PORT,
  FALLBACK_LOGIN_PORT,
} from "./constants.ts";

export interface CallbackOutcome {
  code: string;
  port: number;
}

export interface LoginServerOptions {
  /** 首选端口，默认 1455。 */
  port?: number;
  state: string;
  /** 等待回调的超时（毫秒），默认 5 分钟。 */
  timeoutMs?: number;
}

export interface RunningLoginServer {
  port: number;
  redirectUri: string;
  /** 等待浏览器回调完成授权码交换前的握手。reject 于 state 不匹配/用户取消/超时/服务器错误。 */
  waitForCallback: Promise<CallbackOutcome>;
  cancel: () => void;
  close: () => Promise<void>;
}

const RESPONSE_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

/** 转义 HTML 实体（回调页会回显 provider 返回的 error/error_description 查询参数）。 */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlPage(title: string, body: string): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body style="font-family:system-ui;padding:40px"><h2>${safeTitle}</h2>${body}</body></html>`;
}

function sendResponse(
  res: ServerResponse,
  status: number,
  body: string,
): void {
  res.writeHead(status, RESPONSE_HEADERS);
  res.end(body);
}

function sendCancelToExistingServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 2000 }, () => {
      socket.write(
        `GET /cancel HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
      socket.once("data", () => {
        socket.destroy();
        resolve();
      });
    });
    socket.on("error", () => resolve());
    socket.on("timeout", () => {
      socket.destroy();
      resolve();
    });
  });
}

function bindWithFallback(preferredPort: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number, isFallback: boolean, attemptsLeft: number) => {
      const server = createServer();
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EADDRINUSE" || attemptsLeft <= 0) {
          if (!isFallback && port === preferredPort) {
            // 首选端口失败 → 回退端口再试
            void sendCancelToExistingServer(preferredPort).then(() =>
              attempt(FALLBACK_LOGIN_PORT, true, 3),
            );
            return;
          }
          reject(err);
          return;
        }
        setTimeout(() => attempt(port, isFallback, attemptsLeft - 1), 200);
      });
      server.listen(port, "127.0.0.1", () => resolve(server));
    };
    attempt(preferredPort, false, 10);
  });
}

/**
 * 启动回调服务器。resolve 得到的对象持有 redirectUri，供构造 authorize URL。
 */
export async function startLoginServer(
  opts: LoginServerOptions,
): Promise<RunningLoginServer> {
  const state = opts.state;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  let server: Server;
  try {
    server = await bindWithFallback(opts.port ?? DEFAULT_LOGIN_PORT);
  } catch (err) {
    throw new Error(`unable to bind login callback server: ${err}`);
  }
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;

  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/cancel") {
      sendResponse(res, 200, htmlPage("Login cancelled", "<p>You can close this tab.</p>"));
      if (!settled) {
        settled = true;
        waitReject(new Error("login cancelled"));
      }
      return;
    }
    if (url.pathname !== "/auth/callback") {
      sendResponse(res, 404, htmlPage("Not found", "<p>Unknown path.</p>"));
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      const description = url.searchParams.get("error_description") ?? "";
      sendResponse(
        res,
        400,
        htmlPage(
          "Sign-in could not be completed",
          `<p>${escapeHtml(error)}: ${escapeHtml(description)}</p>`,
        ),
      );
      if (!settled) {
        settled = true;
        waitReject(
          new Error(`oauth callback error: ${error}: ${description}`),
        );
      }
      return;
    }
    const callbackState = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (callbackState !== state) {
      sendResponse(res, 400, htmlPage("State mismatch", "<p>Please retry sign-in.</p>"));
      return; // 不退出服务器：state 不匹配可能是陈旧标签页，继续等
    }
    if (!code) {
      sendResponse(
        res,
        400,
        htmlPage("Missing authorization code", "<p>Sign-in could not be completed.</p>"),
      );
      return;
    }
    sendResponse(
      res,
      200,
      htmlPage("Sign-in completed", "<p>You can close this tab and return to the terminal.</p>"),
    );
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      waitResolve({ code, port });
    }
  });

  let waitResolve!: (outcome: CallbackOutcome) => void;
  let waitReject!: (err: Error) => void;
  const waitForCallback = new Promise<CallbackOutcome>((resolve, reject) => {
    waitResolve = resolve;
    waitReject = reject;
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("login timed out"));
      }
    }, timeoutMs);
  });

  const close = async () => {
    clearTimeout(timer);
    if (!settled) {
      settled = true;
      waitReject(new Error("login server closed"));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { port, redirectUri, waitForCallback, cancel: () => void close(), close };
}
