/**
 * BridgeAuthManager：codex AuthManager 的 TS 等价物。
 *
 * 职责（对齐 codex-rs/login/src/auth/manager.rs）：
 * - login：本地回调服务器 + PKCE 浏览器登录，换取 tokens 与 openai-api-key
 * - logout：删除 auth.json（可选 revoke）
 * - 状态检测：登录态、账号、计划、access_token 过期时间
 * - 主动刷新：access_token exp ≤ now+5min 或 last_refresh > 8 天
 *   （manager.rs should_refresh_proactively，常量 203-204）
 * - 过期感知：refresh 永久失败（401/invalid_grant/refresh_token_expired）
 *   → needsReLogin + relogin-required 事件
 * - 401 恢复：UnauthorizedRecovery 两步——Reload（重读磁盘，manager.rs:1890）
 *   → RefreshToken；两步后仍失败则要求重新登录
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import {
  ACCESS_TOKEN_REFRESH_WINDOW_MINUTES,
  AUTO_REFRESH_CHECK_INTERVAL_MS,
  TOKEN_REFRESH_INTERVAL_DAYS,
  resolveClientId,
  resolveIssuer,
} from "./constants.ts";
import { parseJwtExpiration, parseIdTokenInfo } from "./jwt.ts";
import {
  buildAuthorizeUrl,
  exchangeApiKey,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
  isPermanentRefreshFailure,
  refreshTokens,
  revokeTokens,
  type FetchLike,
} from "./oauth.ts";
import { startLoginServer } from "./loginServer.ts";
import {
  commitAuthRefresh,
  deleteAuthStoreLocked,
  describeTokens,
  readAuthStore,
  writeAuthStoreLocked,
  type AuthDotJson,
  type AuthLockOptions,
} from "./store.ts";

export interface AuthStatus {
  loggedIn: boolean;
  email: string | null;
  planType: string | null;
  accountId: string | null;
  isFedramp: boolean;
  accessTokenExpiresAt: string | null;
  accessTokenExpired: boolean;
  lastRefresh: string | null;
  needsReLogin: boolean;
}

export interface LoginOptions {
  /** 打开系统浏览器（默认 true）。 */
  openBrowser?: boolean;
  /** 拿到 authorize URL 后回调（CLI 打印 / UI 展示二维码等）。 */
  onAuthUrl?: (url: string) => void;
  timeoutMs?: number;
  workspaceIds?: string[];
}

export type UnauthorizedRecoveryResult =
  | { action: "reloaded" }
  | { action: "refreshed" }
  | { action: "relogin-required"; error: Error };

export class ReloginRequiredError extends Error {
  constructor(cause: unknown) {
    super(`re-login required: ${cause instanceof Error ? cause.message : cause}`);
    this.name = "ReloginRequiredError";
  }
}

export interface BridgeAuthManagerOptions {
  /** bridge 自己的 CODEX_HOME（与 ~/.codex 完全隔离）。 */
  codexHome: string;
  issuer?: string;
  clientId?: string;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** 自动刷新巡检间隔（测试用）。 */
  autoRefreshIntervalMs?: number;
  /** 跨进程提交锁参数/测试注入钩子（S05 ④）。 */
  lockOptions?: AuthLockOptions;
}

export class BridgeAuthManager extends EventEmitter {
  readonly codexHome: string;
  readonly issuer: string;
  readonly clientId: string;
  private readonly fetchImpl?: FetchLike;
  private readonly env: NodeJS.ProcessEnv;
  private readonly autoRefreshIntervalMs: number;
  private readonly lockOptions: AuthLockOptions;
  private autoRefreshTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private needsReLogin = false;

  constructor(opts: BridgeAuthManagerOptions) {
    super();
    this.codexHome = opts.codexHome;
    this.env = opts.env ?? process.env;
    this.issuer = opts.issuer ?? resolveIssuer(this.env);
    this.clientId = opts.clientId ?? resolveClientId(this.env);
    this.fetchImpl = opts.fetchImpl;
    this.lockOptions = opts.lockOptions ?? {};
    this.autoRefreshIntervalMs =
      opts.autoRefreshIntervalMs ?? AUTO_REFRESH_CHECK_INTERVAL_MS;
  }

  // ---------------------------------------------------------------- login

  async login(opts: LoginOptions = {}): Promise<AuthStatus> {
    const pkce = generatePkce();
    const state = generateState();
    const server = await startLoginServer({
      state,
      timeoutMs: opts.timeoutMs,
    });
    const authUrl = buildAuthorizeUrl({
      issuer: this.issuer,
      clientId: this.clientId,
      redirectUri: server.redirectUri,
      pkce,
      state,
      workspaceIds: opts.workspaceIds,
    });
    opts.onAuthUrl?.(authUrl);
    if (opts.openBrowser !== false) {
      openBrowser(authUrl);
    }
    try {
      const { code } = await server.waitForCallback;
      const tokens = await exchangeCodeForTokens({
        issuer: this.issuer,
        clientId: this.clientId,
        redirectUri: server.redirectUri,
        verifier: pkce.verifier,
        code,
        fetchImpl: this.fetchImpl,
      });
      // token-exchange 换 API key：失败不阻断登录（codex 同样 .ok() 容忍）
      let apiKey: string | null = null;
      try {
        apiKey = await exchangeApiKey({
          issuer: this.issuer,
          clientId: this.clientId,
          idToken: tokens.id_token,
          fetchImpl: this.fetchImpl,
        });
      } catch (err) {
        this.emit("warn", `api key exchange failed (non-fatal): ${err}`);
      }
      const { accountId } = describeTokens({
        id_token: tokens.id_token,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        account_id: null,
      });
      const auth: AuthDotJson = {
        auth_mode: "chatgpt",
        openai_api_key: apiKey,
        tokens: {
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          account_id: accountId,
        },
        last_refresh: new Date().toISOString(),
      };
      await writeAuthStoreLocked(this.codexHome, auth, this.lockOptions);
      this.needsReLogin = false;
      this.emit("changed", this.getStatusSync(auth));
      return this.getStatusSync(auth);
    } finally {
      await server.close();
    }
  }

  async logout(opts: { revoke?: boolean } = {}): Promise<boolean> {
    const auth = await readAuthStore(this.codexHome);
    if (opts.revoke && auth?.tokens?.refresh_token) {
      try {
        await revokeTokens({
          issuer: this.issuer,
          clientId: this.clientId,
          refreshToken: auth.tokens.refresh_token,
          fetchImpl: this.fetchImpl,
        });
      } catch (err) {
        this.emit("warn", `token revoke failed (non-fatal): ${err}`);
      }
    }
    const removed = await deleteAuthStoreLocked(this.codexHome, this.lockOptions);
    this.needsReLogin = false;
    this.emit("changed", this.getStatusSync(null));
    return removed;
  }

  // ---------------------------------------------------------------- status

  async getStatus(): Promise<AuthStatus> {
    return this.getStatusSync(await this.readStoreSafe());
  }

  /** 当前凭证的请求头（先保证尽量新鲜）。供 wham 客户端等下游使用。 */
  async authHeaders(): Promise<Record<string, string>> {
    const auth = await this.readStoreSafe();
    const tokens = auth?.tokens;
    if (!tokens) {
      throw new Error("not logged in");
    }
    if (this.shouldRefreshProactively(auth)) {
      const ok = await this.refreshNow();
      if (!ok) {
        throw new ReloginRequiredError("refresh failed before authHeaders");
      }
    }
    const fresh = (await this.readStoreSafe())?.tokens ?? tokens;
    const headers: Record<string, string> = {
      authorization: `Bearer ${fresh.access_token}`,
    };
    const { accountId } = describeTokens(fresh);
    if (accountId) {
      // codex remote control 用小写 header 名（remote_control/auth.rs:64）
      headers["chatgpt-account-id"] = accountId;
    }
    return headers;
  }

  // ---------------------------------------------------------------- refresh

  /**
   * 主动刷新判定（manager.rs:3004 should_refresh_proactively）：
   * access_token exp ≤ now+5min → true；无 exp 时 last_refresh < now-8d → true。
   */
  shouldRefreshProactively(auth: AuthDotJson | null): boolean {
    const tokens = auth?.tokens;
    if (!tokens) {
      return false;
    }
    const expiresAt = parseJwtExpiration(tokens.access_token);
    if (expiresAt) {
      return (
        expiresAt.getTime() <=
        Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MINUTES * 60_000
      );
    }
    const lastRefresh = auth?.last_refresh ? Date.parse(auth.last_refresh) : NaN;
    if (Number.isNaN(lastRefresh)) {
      return false;
    }
    return lastRefresh < Date.now() - TOKEN_REFRESH_INTERVAL_DAYS * 86_400_000;
  }

  /** 立即刷新并持久化。返回是否成功；永久失败会置 needsReLogin。 */
  async refreshNow(): Promise<boolean> {
    // 并发去重：巡检、authHeaders、401 恢复共用一次刷新
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<boolean> {
    const auth = await this.readStoreSafe();
    const tokens = auth?.tokens;
    if (!tokens) {
      return false;
    }
    // 网络刷新在锁外；提交段持锁并重读校验（S05 ④，关闭覆盖新登录/复活已删凭证窗口）
    const baseAccessToken = tokens.access_token;
    try {
      const next = await refreshTokens({
        issuer: this.issuer,
        clientId: this.clientId,
        refreshToken: tokens.refresh_token,
        env: this.env,
        fetchImpl: this.fetchImpl,
      });
      const { accountId } = describeTokens({
        id_token: next.id_token,
        access_token: next.access_token,
        // 服务端未轮换 refresh_token 时沿用旧值
        refresh_token: next.refresh_token || tokens.refresh_token,
        account_id: tokens.account_id,
      });
      const outcome = await commitAuthRefresh(
        this.codexHome,
        {
          baseAccessToken,
          build: (current) => ({
            ...current,
            tokens: {
              id_token: next.id_token,
              access_token: next.access_token,
              refresh_token: next.refresh_token || tokens.refresh_token,
              account_id: accountId ?? current.tokens?.account_id ?? tokens.account_id,
            },
            last_refresh: new Date().toISOString(),
          }),
        },
        this.lockOptions,
      );
      if (!outcome.committed) {
        // 已删/已替换/失锁：丢弃写回，不得复活/覆盖
        const reason =
          outcome.reason === "deleted"
            ? "已删除"
            : outcome.reason === "lock-lost"
              ? "提交锁已丢失"
              : "已被替换";
        this.emit("warn", `刷新结果提交被丢弃（凭证${reason}）`);
        return false;
      }
      this.needsReLogin = false;
      this.emit("changed", this.getStatusSync(outcome.auth));
      return true;
    } catch (err) {
      if (isPermanentRefreshFailure(err)) {
        this.needsReLogin = true;
        this.emit("relogin-required", err);
        return false;
      }
      this.emit("refresh-failed", err);
      return false;
    }
  }

  // ---------------------------------------------------------- auto refresh

  startAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      return;
    }
    const tick = async () => {
      try {
        const auth = await this.readStoreSafe();
        if (!auth?.tokens) {
          return; // 未登录：静默跳过
        }
        if (this.shouldRefreshProactively(auth)) {
          await this.refreshNow();
        }
      } catch (err) {
        this.emit("refresh-failed", err);
      }
    };
    this.autoRefreshTimer = setInterval(
      () => void tick(),
      this.autoRefreshIntervalMs,
    );
    this.autoRefreshTimer.unref?.();
  }

  stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  /**
   * 等待在途刷新收敛（S05 auth-reset 协停）：`stopAutoRefresh()` 后调用，
   * 处理期间新起的刷新也一并等待（有界重试，防持续新起的死循环）。
   */
  async waitForInflightRefresh(): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
      const inflight = this.refreshInFlight;
      if (!inflight) return;
      try {
        await inflight;
      } catch {
        // 刷新失败也不阻塞 reset
      }
    }
  }

  // ------------------------------------------------------- 401 recovery

  /**
   * 收到 401 后的恢复（对齐 UnauthorizedRecovery，manager.rs:1880-1990）：
   * 第一步 Reload——重读 auth.json（其他进程可能已刷新），
   *   判据：磁盘上的 access_token 已不同于发起请求时所用的那份；
   * 第二步 RefreshToken——本地刷新。
   * 两步后凭证仍不可用则要求重新登录。
   */
  async handleUnauthorized(
    usedAccessToken?: string,
  ): Promise<UnauthorizedRecoveryResult> {
    if (usedAccessToken) {
      const current = await this.readStoreSafe();
      const currentToken = current?.tokens?.access_token;
      if (currentToken && currentToken !== usedAccessToken) {
        return { action: "reloaded" };
      }
    }
    if (await this.refreshNow()) {
      return { action: "refreshed" };
    }
    const error = new Error("unauthorized after reload+refresh");
    this.needsReLogin = true;
    this.emit("relogin-required", error);
    return { action: "relogin-required", error };
  }

  // ---------------------------------------------------------------- internal

  /** 读 auth.json；missing 返回 null。 */
  private async readStoreSafe(): Promise<AuthDotJson | null> {
    try {
      return await readAuthStore(this.codexHome);
    } catch (err) {
      this.emit("warn", `failed to read auth store: ${err}`);
      return null;
    }
  }

  private getStatusSync(auth: AuthDotJson | null): AuthStatus {
    const tokens = auth?.tokens;
    if (!tokens) {
      return {
        loggedIn: false,
        email: null,
        planType: null,
        accountId: null,
        isFedramp: false,
        accessTokenExpiresAt: null,
        accessTokenExpired: false,
        lastRefresh: null,
        needsReLogin: this.needsReLogin,
      };
    }
    let idTokenInfo;
    try {
      idTokenInfo = parseIdTokenInfo(tokens.id_token);
    } catch {
      idTokenInfo = null;
    }
    const expiresAt = parseJwtExpiration(tokens.access_token);
    return {
      loggedIn: true,
      email: idTokenInfo?.email ?? null,
      planType: idTokenInfo?.chatgptPlanType ?? null,
      accountId:
        idTokenInfo?.chatgptAccountId ?? tokens.account_id ?? null,
      isFedramp: idTokenInfo?.chatgptAccountIsFedramp ?? false,
      accessTokenExpiresAt: expiresAt?.toISOString() ?? null,
      accessTokenExpired: expiresAt ? expiresAt.getTime() <= Date.now() : false,
      lastRefresh: auth?.last_refresh ?? null,
      needsReLogin: this.needsReLogin,
    };
  }
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // 打不开浏览器不致命：调用方已通过 onAuthUrl 拿到 URL
  }
}
