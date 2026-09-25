/**
 * JWT claims 解析（对齐 codex-rs/login/src/token_data.rs）。
 *
 * codex 不校验签名（token 全部来自 auth.openai.com 的 TLS 响应），
 * 这里只做 base64url payload 解码。
 */

export interface IdTokenInfo {
  email: string | null;
  chatgptPlanType: string | null;
  chatgptUserId: string | null;
  chatgptAccountId: string | null;
  chatgptAccountIsFedramp: boolean;
  rawJwt: string;
}

interface IdClaims {
  email?: string;
  "https://api.openai.com/profile"?: { email?: string };
  "https://api.openai.com/auth"?: {
    chatgpt_plan_type?: string;
    chatgpt_user_id?: string;
    user_id?: string;
    chatgpt_account_id?: string;
    chatgpt_account_is_fedramp?: boolean;
  };
}

function base64UrlDecodeToJson(jwt: string): unknown {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("invalid ID token format");
  }
  const payload = Buffer.from(parts[1], "base64url");
  return JSON.parse(payload.toString("utf8"));
}

/** 解析 id_token 中的 ChatGPT 相关 claims（token_data.rs parse_chatgpt_jwt_claims）。 */
export function parseIdTokenInfo(jwt: string): IdTokenInfo {
  const claims = base64UrlDecodeToJson(jwt) as IdClaims;
  const email = claims.email ?? claims["https://api.openai.com/profile"]?.email ?? null;
  const auth = claims["https://api.openai.com/auth"];
  return {
    email: email ?? null,
    chatgptPlanType: auth?.chatgpt_plan_type ?? null,
    chatgptUserId: auth?.chatgpt_user_id ?? auth?.user_id ?? null,
    chatgptAccountId: auth?.chatgpt_account_id ?? null,
    chatgptAccountIsFedramp: auth?.chatgpt_account_is_fedramp ?? false,
    rawJwt: jwt,
  };
}

/** 解析 JWT 的 exp（token_data.rs parse_jwt_expiration），无 exp 返回 null。 */
export function parseJwtExpiration(jwt: string): Date | null {
  const claims = base64UrlDecodeToJson(jwt) as { exp?: number };
  if (typeof claims.exp !== "number") {
    return null;
  }
  return new Date(claims.exp * 1000);
}

/** 构造仅用于测试的 JWT（alg none，不做签名）。 */
export function makeTestJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.sig`;
}
