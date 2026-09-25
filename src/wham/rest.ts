/**
 * curl 子进程 REST 层。
 *
 * chatgpt.com 的 Cloudflare 会拦 Node undici（fetch）的 TLS 指纹（403 JS challenge），
 * 同样请求经 curl 可正常通过（docs/research/05）。因此对真实后端的 REST
 * （enroll/refresh/pair/pair/status）全部走 curl。
 */
import { spawn } from "node:child_process";

export interface RestResponse {
  status: number;
  body: string;
}

/** POST JSON 并返回 HTTP 状态码（-w "%{http_code}" 追加在 stdout 末尾）。 */
export function curlPostJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = 30_000,
): Promise<RestResponse> {
  return new Promise((resolve, reject) => {
    const args = [
      "-sS",
      "-X", "POST",
      "--max-time", String(Math.ceil(timeoutMs / 1000)),
      "-H", "Content-Type: application/json",
      "-w", "\n%{http_code}",
      "--data-binary", "@-",
      url,
    ];
    for (const [key, value] of Object.entries(headers)) {
      if (!value) continue;
      args.push("-H", `${key}: ${value}`);
    }
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      const idx = stdout.lastIndexOf("\n");
      if (idx < 0) {
        reject(new Error(`curl exit=${code} 无输出${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`));
        return;
      }
      const status = Number(stdout.slice(idx + 1).trim());
      const responseBody = stdout.slice(0, idx);
      if (!Number.isFinite(status)) {
        reject(new Error(`curl exit=${code} 无法解析状态码: ${stdout.slice(0, 200)}`));
        return;
      }
      resolve({ status, body: responseBody });
    });
    child.stdin.end(body);
  });
}
