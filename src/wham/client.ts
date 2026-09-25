/**
 * wham 客户端：bridge 以 codex 被控端身份对接真实 chatgpt.com 远程控制后端。
 *
 * 协议对齐 codex-rs/app-server-transport/src/transport/remote_control/：
 * - REST：enroll / refresh / pair / pair/status（server_api.rs）
 *   headers：Bearer <access_token> + chatgpt-account-id + x-codex-installation-id
 *   （走 curl 子进程：CF 拦 undici TLS 指纹，见 rest.ts）
 * - installation_id：与 codex 相同语义（每安装唯一，持久化在 CODEX_HOME）
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import type { BridgeAuthManager } from "../auth/manager.ts";
import {
  REST_PATHS,
  type EnrollRemoteServerResponse,
} from "./protocol.ts";
import { curlPostJson } from "./rest.ts";

export const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com";

/**
 * REST base → WS 隧道 URL（http→ws、https→wss）。
 * REST_PATHS 自带 /backend-api 前缀，因此这里接收 origin
 * （兼容误传带 /backend-api 后缀的 codex 风格 base）。
 */
export function websocketUrlFor(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/^http/, "ws") + REST_PATHS.websocket;
}

/** 归一化为 origin：去掉尾部斜杠与 /backend-api 后缀（REST_PATHS 已含该前缀）。 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/backend-api$/, "");
}

export interface WhamClientOptions {
  authManager: BridgeAuthManager;
  baseUrl?: string;
}

export class WhamError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`wham endpoint returned ${status}: ${body.slice(0, 300)}`);
    this.name = "WhamError";
  }
}

export class WhamClient {
  readonly baseUrl: string;
  private readonly authManager: BridgeAuthManager;

  constructor(opts: WhamClientOptions) {
    // REST_PATHS 自带 /backend-api 前缀，baseUrl 归一化为 origin
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_CHATGPT_BASE_URL);
    this.authManager = opts.authManager;
  }

  /** 读取或生成 installation_id（持久化在 CODEX_HOME）。 */
  async installationId(): Promise<string> {
    const path = join(this.authManager.codexHome, "installation_id");
    try {
      const existing = (await readFile(path, "utf8")).trim();
      if (existing) {
        return existing;
      }
    } catch {
      // 不存在则生成
    }
    const id = randomUUID();
    await writeFile(path, `${id}\n`, { mode: 0o600 });
    return id;
  }

  private async post<T>(
    path: string,
    body: unknown,
    bearerToken?: string,
  ): Promise<T> {
    // authHeaders() 保证 token 新鲜（临期先刷新）
    const headers = await this.authManager.authHeaders();
    if (bearerToken) {
      headers.authorization = `Bearer ${bearerToken}`;
    }
    headers["x-codex-installation-id"] = await this.installationId();
    // Cloudflare 会拦默认 node UA；对齐 codex 的 UA 形状（default_client.rs get_codex_user_agent）
    headers["User-Agent"] = `codex_cli_rs/0.156.1 (${osName()} ${release()}; ${process.arch}) dumb`;
    const { status, body: text } = await curlPostJson(
      `${this.baseUrl}${path}`,
      headers,
      JSON.stringify(body),
    );
    if (status < 200 || status >= 300) {
      throw new WhamError(status, text);
    }
    return JSON.parse(text) as T;
  }

  async enroll(args: {
    name: string;
    appServerVersion: string;
  }): Promise<EnrollRemoteServerResponse> {
    return this.post<EnrollRemoteServerResponse>(REST_PATHS.enroll, {
      name: args.name,
      os: platformOs(),
      arch: process.arch,
      app_server_version: args.appServerVersion,
      installation_id: await this.installationId(),
    });
  }

  async refresh(args: {
    serverId: string;
  }): Promise<EnrollRemoteServerResponse> {
    return this.post<EnrollRemoteServerResponse>(
      REST_PATHS.refresh,
      { server_id: args.serverId, installation_id: await this.installationId() },
    );
  }

  async pair(args: {
    remoteControlToken: string;
    manualCode?: boolean;
  }): Promise<{
    pairing_code: string;
    manual_pairing_code: string | null;
    server_id: string;
    environment_id: string;
    expires_at: string;
  }> {
    return this.post(REST_PATHS.pair, {
      manual_code: args.manualCode ?? false,
    }, args.remoteControlToken);
  }

  async pairStatus(args: {
    pairingCode?: string;
    manualPairingCode?: string;
    /** enroll 发放的 remote_control_token（真实后端要求，enroll.rs pairing_status）。 */
    remoteControlToken?: string;
  }): Promise<{ claimed: boolean }> {
    return this.post<{ claimed: boolean }>(
      REST_PATHS.pairStatus,
      {
        ...(args.pairingCode ? { pairing_code: args.pairingCode } : {}),
        ...(args.manualPairingCode ? { manual_pairing_code: args.manualPairingCode } : {}),
      },
      args.remoteControlToken,
    );
  }
}

function platformOs(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function osName(): string {
  switch (process.platform) {
    case "darwin":
      return "Mac OS";
    case "win32":
      return "Windows";
    default:
      return "Linux";
  }
}
