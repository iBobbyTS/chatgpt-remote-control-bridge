import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  buildAuthorizeUrl,
  exchangeApiKey,
  exchangeCodeForTokens,
  generatePkce,
  isPermanentRefreshFailure,
  refreshTokens,
  TokenEndpointError,
  type FetchLike,
} from "../src/auth/oauth.ts";

function fetchStub(
  handler: (url: string, init: RequestInit) => { status: number; body: string },
): FetchLike {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    const { status, body } = handler(href, init ?? {});
    return new Response(body, { status });
  }) as FetchLike;
}

test("generatePkce 产出可验证的 S256 对", () => {
  const pkce = generatePkce();
  assert.match(pkce.verifier, /^[\w-]+$/);
  assert.equal(
    pkce.challenge,
    createHash("sha256").update(pkce.verifier).digest("base64url"),
  );
});

test("buildAuthorizeUrl 对齐 codex 参数（scope/PKCE/originator/扩展参数）", () => {
  const pkce = generatePkce();
  const url = new URL(
    buildAuthorizeUrl({
      issuer: "https://auth.openai.com/",
      clientId: "app_test",
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      pkce,
      state: "st",
    }),
  );
  assert.equal(url.pathname, "/oauth/authorize");
  const q = url.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), "app_test");
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(q.get("code_challenge"), pkce.challenge);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("state"), "st");
  assert.equal(
    q.get("scope"),
    "openid profile email offline_access api.connectors.read api.connectors.invoke",
  );
  assert.equal(q.get("id_token_add_organizations"), "true");
  assert.equal(q.get("codex_cli_simplified_flow"), "true");
  assert.equal(q.get("originator"), "codex_cli_rs");
  assert.equal(q.has("allowed_workspace_id"), false);
});

test("exchangeCodeForTokens 用 form 编码发送标准 authorization_code 参数", async () => {
  const captured: {
    url: string | null;
    body: string | null;
    contentType: string | null;
  } = { url: null, body: null, contentType: null };
  const fetch = fetchStub((_url, init) => {
    captured.url = _url;
    captured.body = String(init.body);
    captured.contentType = new Headers(init.headers).get("content-type");
    return {
      status: 200,
      body: JSON.stringify({
        id_token: "i",
        access_token: "a",
        refresh_token: "r",
      }),
    };
  });
  const tokens = await exchangeCodeForTokens({
    issuer: "https://auth.openai.com",
    clientId: "app_test",
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    verifier: "v",
    code: "c",
    fetchImpl: fetch,
  });
  assert.equal(tokens.id_token, "i");
  assert.equal(captured.url, "https://auth.openai.com/oauth/token");
  assert.equal(captured.contentType, "application/x-www-form-urlencoded");
  const form = new URLSearchParams(captured.body ?? "");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "c");
  assert.equal(form.get("code_verifier"), "v");
  assert.equal(form.get("client_id"), "app_test");
});

test("refreshTokens 用 JSON 编码（ChatGPT refresh uses JSON）", async () => {
  const captured: { body: string | null; contentType: string | null } = {
    body: null,
    contentType: null,
  };
  const fetch = fetchStub((_url, init) => {
    captured.body = String(init.body);
    captured.contentType = new Headers(init.headers).get("content-type");
    return {
      status: 200,
      body: JSON.stringify({
        id_token: "i2",
        access_token: "a2",
        refresh_token: "r2",
      }),
    };
  });
  const tokens = await refreshTokens({
    issuer: "https://auth.openai.com",
    clientId: "app_test",
    refreshToken: "r1",
    fetchImpl: fetch,
  });
  assert.equal(tokens.refresh_token, "r2");
  assert.equal(captured.contentType, "application/json");
  const body = JSON.parse(captured.body ?? "{}") as Record<string, string>;
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, "r1");
  assert.equal(body.client_id, "app_test");
});

test("刷新失败分类：401 / 400 invalid_grant / refresh_token_expired 为永久", () => {
  assert.equal(isPermanentRefreshFailure(new TokenEndpointError(401, null, "")), true);
  assert.equal(
    isPermanentRefreshFailure(new TokenEndpointError(400, "invalid_grant", "")),
    true,
  );
  assert.equal(
    isPermanentRefreshFailure(new TokenEndpointError(400, "refresh_token_expired", "")),
    true,
  );
  assert.equal(
    isPermanentRefreshFailure(new TokenEndpointError(500, "server_error", "")),
    false,
  );
  assert.equal(isPermanentRefreshFailure(new Error("network")), false);
});

test("exchangeApiKey 发送 token-exchange grant", async () => {
  const captured: { body: URLSearchParams | null } = { body: null };
  const fetch = fetchStub((_url, init) => {
    captured.body = new URLSearchParams(String(init.body));
    return { status: 200, body: JSON.stringify({ access_token: "sk-key" }) };
  });
  const key = await exchangeApiKey({
    issuer: "https://auth.openai.com",
    clientId: "app_test",
    idToken: "idt",
    fetchImpl: fetch,
  });
  assert.equal(key, "sk-key");
  const form = captured.body!;
  assert.equal(
    form.get("grant_type"),
    "urn:ietf:params:oauth:grant-type:token-exchange",
  );
  assert.equal(form.get("requested_token"), "openai-api-key");
  assert.equal(form.get("subject_token"), "idt");
  assert.equal(
    form.get("subject_token_type"),
    "urn:ietf:params:oauth:token-type:id_token",
  );
});
