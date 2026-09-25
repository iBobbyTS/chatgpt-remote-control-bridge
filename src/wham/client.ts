/**
 * wham 客户端：bridge 以 codex 被控端身份对接真实 chatgpt.com 远程控制后端。
 *
 * 协议对齐 codex-rs/app-server-transport/src/transport/remote_control/：
 * - REST：enroll / refresh / pair / pair/status（server_api.rs）
 *   headers：Bearer <access_token> + chatgpt-account-id + x-codex-installation-id
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

export const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";

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
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CHATGPT_BASE_URL).replace(/\/+$/, "");
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
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new WhamError(resp.status, text);
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
  }): Promise<{ claimed: boolean }> {
    return this.post<{ claimed: boolean }>(REST_PATHS.pairStatus, {
      ...(args.pairingCode ? { pairing_code: args.pairingCode } : {}),
      ...(args.manualPairingCode ? { manual_pairing_code: args.manualPairingCode } : {}),
    });
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
