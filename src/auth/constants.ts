/**
 * 与 codex 官方实现（codex-rs/login）对齐的常量。
 *
 * 来源标注：
 * - issuer / 端口：codex-rs/login/src/server.rs:76-79
 * - client_id：codex-rs/login/src/auth/manager.rs:1717（CLIENT_ID），
 *   可用 CODEX_APP_SERVER_LOGIN_CLIENT_ID 覆盖（manager.rs:216）
 * - scope / 扩展参数：codex-rs/login/src/server.rs:594-613
 * - originator 默认值：codex-rs/login/src/auth/default_client.rs:44
 * - 刷新窗口：manager.rs:203-204
 *   （access_token exp ≤ now+5min 主动刷新；无 exp 时 last_refresh 超过 8 天刷新）
 * - 刷新端点覆盖：manager.rs:214（CODEX_REFRESH_TOKEN_URL_OVERRIDE）
 */

export const DEFAULT_ISSUER = "https://auth.openai.com";

export const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CLIENT_ID_OVERRIDE_ENV_VAR = "CODEX_APP_SERVER_LOGIN_CLIENT_ID";
export const ISSUER_OVERRIDE_ENV_VAR = "BRIDGE_OAUTH_ISSUER";
export const REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR =
  "CODEX_REFRESH_TOKEN_URL_OVERRIDE";

/** 本地回调服务器端口（与 codex CLI Hydra redirect URI 白名单同步）。 */
export const DEFAULT_LOGIN_PORT = 1455;
export const FALLBACK_LOGIN_PORT = 1457;

export const AUTH_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

export const DEFAULT_ORIGINATOR = "codex_cli_rs";

/** access_token 剩余寿命低于该分钟数时主动刷新。 */
export const ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5;

/** access_token 无 exp 可解析时，按 last_refresh 超过该天数强制刷新。 */
export const TOKEN_REFRESH_INTERVAL_DAYS = 8;

/** 自动刷新巡检间隔。 */
export const AUTO_REFRESH_CHECK_INTERVAL_MS = 60_000;

export function resolveIssuer(env: NodeJS.ProcessEnv = process.env): string {
  return env[ISSUER_OVERRIDE_ENV_VAR] ?? DEFAULT_ISSUER;
}

export function resolveClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env[CLIENT_ID_OVERRIDE_ENV_VAR] ?? DEFAULT_CLIENT_ID;
}

export function resolveRefreshTokenUrl(
  issuer: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env[REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR] ??
    `${issuer.replace(/\/+$/, "")}/oauth/token`
  );
}
