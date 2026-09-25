/**
 * OAuth 原语（对齐 codex-rs/login/src/oauth/ 与 server.rs、auth/manager.rs）。
 *
 * - 授权码交换：form 编码（oauth/client.rs:101 注释：authorization-code 用 Form）
 * - ChatGPT 刷新：JSON 编码（oauth/client.rs:100 注释：ChatGPT refresh uses JSON）
 * - API key：token-exchange grant 换 openai-api-key（server.rs obtain_api_key）
 * - 刷新失败分类：401 / 400+invalid_grant / refresh_token_expired → 永久（需重登），
 *   其余 → 暂时性（可重试）（manager.rs request_chatgpt_token_refresh 1658-1670）
 */
import { createHash, randomBytes } from "node:crypto";
import {
  AUTH_SCOPES,
  DEFAULT_ORIGINATOR,
  resolveRefreshTokenUrl,
} from "./constants.ts";

export interface PkceCodes {
  verifier: string;
  challenge: string;
}

/** PKCE S256（codex-rs/login/src/pkce.rs）。 */
export function generatePkce(): PkceCodes {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** 32 字节随机 state（server.rs oauth/authorization.rs generate_state）。 */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export interface AuthorizeUrlOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  pkce: PkceCodes;
  state: string;
  workspaceIds?: string[];
  originator?: string;
}

/** 构造 authorize URL（server.rs build_authorize_url + 594-613 的扩展参数）。 */
export function buildAuthorizeUrl(opts: AuthorizeUrlOptions): string {
  const url = new URL(`${opts.issuer.replace(/\/+$/, "")}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("code_challenge", opts.pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("scope", AUTH_SCOPES);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", opts.originator ?? DEFAULT_ORIGINATOR);
  if (opts.workspaceIds?.length) {
    url.searchParams.set("allowed_workspace_id", opts.workspaceIds.join(","));
  }
  return url.toString();
}

export interface OAuthTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

export type FetchLike = typeof globalThis.fetch;

export interface TokenRequestOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

async function postTokenEndpoint(
  url: string,
  body: string,
  contentType: string,
  opts: TokenRequestOptions,
): Promise<OAuthTokens> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const resp = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
    signal: opts.signal,
  });
  const text = await resp.text();
  if (!resp.ok) {
    let parsed: TokenErrorBody = {};
    try {
      parsed = JSON.parse(text) as TokenErrorBody;
    } catch {
      // 非 JSON 错误体：保留原始文本
    }
    throw new TokenEndpointError(resp.status, parsed.error ?? null, text);
  }
  const parsed = JSON.parse(text) as Partial<OAuthTokens>;
  if (!parsed.id_token || !parsed.access_token) {
    throw new Error(`unexpected token response: missing id_token/access_token`);
  }
  return {
    id_token: parsed.id_token,
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token ?? "",
  };
}

export class TokenEndpointError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string | null,
    public readonly rawBody: string,
  ) {
    super(`token endpoint returned ${status}: ${rawBody.slice(0, 200)}`);
    this.name = "TokenEndpointError";
  }
}

/** 授权码换 tokens（form 编码，server.rs exchange_code_for_tokens）。 */
export async function exchangeCodeForTokens(args: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
  code: string;
} & TokenRequestOptions): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.verifier,
  });
  const url = `${args.issuer.replace(/\/+$/, "")}/oauth/token`;
  return postTokenEndpoint(
    url,
    form.toString(),
    "application/x-www-form-urlencoded",
    args,
  );
}

/** 刷新 tokens（JSON 编码，manager.rs request_chatgpt_token_refresh）。 */
export async function refreshTokens(args: {
  issuer: string;
  clientId: string;
  refreshToken: string;
  env?: NodeJS.ProcessEnv;
} & TokenRequestOptions): Promise<OAuthTokens> {
  const url = resolveRefreshTokenUrl(args.issuer, args.env);
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  });
  return postTokenEndpoint(url, body, "application/json", args);
}

/** 永久失败：refresh_token 已不可用，需要重新走浏览器登录。 */
export function isPermanentRefreshFailure(err: unknown): boolean {
  if (!(err instanceof TokenEndpointError)) {
    return false;
  }
  if (err.status === 401) {
    return true;
  }
  if (err.status === 400 && err.errorCode?.toLowerCase() === "invalid_grant") {
    return true;
  }
  const code = err.errorCode?.toLowerCase();
  return code === "refresh_token_expired";
}

/** 用 id_token 做 token-exchange 换 openai-api-key（server.rs obtain_api_key）。失败不阻断登录。 */
export async function exchangeApiKey(args: {
  issuer: string;
  clientId: string;
  idToken: string;
} & TokenRequestOptions): Promise<string> {
  const url = `${args.issuer.replace(/\/+$/, "")}/oauth/token`;
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: args.clientId,
    requested_token: "openai-api-key",
    subject_token: args.idToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
  });
  const doFetch = args.fetchImpl ?? globalThis.fetch;
  const resp = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: args.signal,
  });
  if (!resp.ok) {
    throw new TokenEndpointError(resp.status, null, await resp.text());
  }
  const parsed = (await resp.json()) as { access_token?: string };
  if (!parsed.access_token) {
    throw new Error("api key exchange response missing access_token");
  }
  return parsed.access_token;
}

/** logout 时撤销 tokens（manager.rs REVOKE_TOKEN_URL）。失败仅记录，不阻断。 */
export async function revokeTokens(args: {
  issuer: string;
  clientId: string;
  refreshToken: string;
} & TokenRequestOptions): Promise<boolean> {
  const url = `${args.issuer.replace(/\/+$/, "")}/oauth/revoke`;
  const body = JSON.stringify({
    client_id: args.clientId,
    token: args.refreshToken,
  });
  const doFetch = args.fetchImpl ?? globalThis.fetch;
  const resp = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: args.signal,
  });
  return resp.ok;
}
