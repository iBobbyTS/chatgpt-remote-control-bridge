import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test, after } from "node:test";
import { BridgeAuthManager } from "../src/auth/manager.ts";
import { makeTestJwt } from "../src/auth/jwt.ts";
import {
  readAuthStore,
  writeAuthStore,
  authJsonPath,
  type AuthDotJson,
} from "../src/auth/store.ts";
import {
  startLoginServer,
  type CallbackOutcome,
} from "../src/auth/loginServer.ts";
import type { FetchLike } from "../src/auth/oauth.ts";

const cleanupDirs: string[] = [];
after(async () => {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  // 项目规则：测试临时文件放 .agent-work/tmp/，不写系统 /tmp
  const base = join(process.cwd(), ".agent-work", "tmp", "auth-tests");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "home-"));
  cleanupDirs.push(dir);
  return dir;
}

function tokenJwt(expSeconds?: number): string {
  return makeTestJwt({
    ...(expSeconds ? { exp: expSeconds } : {}),
    email: "user@example.com",
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "pro",
      chatgpt_user_id: "u1",
      chatgpt_account_id: "acc-1",
    },
  });
}

function makeAuth(opts: {
  expSeconds?: number;
  lastRefresh: string;
}): AuthDotJson {
  return {
    auth_mode: "chatgpt",
    openai_api_key: null,
    tokens: {
      id_token: tokenJwt(),
      access_token: tokenJwt(opts.expSeconds),
      refresh_token: "rt-1",
      account_id: "acc-1",
    },
    last_refresh: opts.lastRefresh,
  };
}

test("auth.json roundtrip：原子写、权限 600、格式对齐 codex", async () => {
  const home = await tempHome();
  const auth = makeAuth({ lastRefresh: new Date().toISOString() });
  await writeAuthStore(home, auth);
  const info = await stat(authJsonPath(home));
  assert.equal(info.mode & 0o777, 0o600);
  const text = await readFile(authJsonPath(home), "utf8");
  const parsed = JSON.parse(text);
  assert.equal(parsed.auth_mode, "chatgpt");
  assert.equal(parsed.tokens.account_id, "acc-1");
  assert.deepEqual(await readAuthStore(home), auth);
  assert.equal(await readAuthStore(join(home, "missing")), null);
});

test("shouldRefreshProactively：exp 5 分钟窗口与 8 天 fallback（manager.rs:3004）", async () => {
  const manager = new BridgeAuthManager({ codexHome: "/nonexistent" });
  const now = Date.now();

  // exp 还有 1 小时：不刷
  assert.equal(
    manager.shouldRefreshProactively(
      makeAuth({ expSeconds: Math.floor(now / 1000) + 3600, lastRefresh: new Date().toISOString() }),
    ),
    false,
  );
  // exp 还有 3 分钟（≤5min 窗口）：刷
  assert.equal(
    manager.shouldRefreshProactively(
      makeAuth({ expSeconds: Math.floor(now / 1000) + 180, lastRefresh: new Date().toISOString() }),
    ),
    true,
  );
  // 无 exp、last_refresh 9 天前：刷
  assert.equal(
    manager.shouldRefreshProactively(
      makeAuth({ lastRefresh: new Date(now - 9 * 86_400_000).toISOString() }),
    ),
    true,
  );
  // 无 exp、last_refresh 1 天前：不刷
  assert.equal(
    manager.shouldRefreshProactively(
      makeAuth({ lastRefresh: new Date(now - 86_400_000).toISOString() }),
    ),
    false,
  );
  // 未登录：不刷
  assert.equal(manager.shouldRefreshProactively(null), false);
});

test("refreshNow：成功后持久化新 token 并发 changed；无 exp 回退旧 refresh_token", async () => {
  const home = await tempHome();
  await writeAuthStore(home, makeAuth({ expSeconds: Math.floor(Date.now() / 1000) + 60, lastRefresh: new Date().toISOString() }));
  let refreshCallCount = 0;
  const fetch: FetchLike = (async () => {
    refreshCallCount += 1;
    return new Response(
      JSON.stringify({
        id_token: tokenJwt(),
        access_token: tokenJwt(Math.floor(Date.now() / 1000) + 3600),
        // 服务端未轮换 refresh_token 的情况：响应缺 refresh_token 字段
      }),
      { status: 200 },
    );
  }) as FetchLike;
  const manager = new BridgeAuthManager({ codexHome: home, fetchImpl: fetch });
  let changed = 0;
  manager.on("changed", () => (changed += 1));

  assert.equal(await manager.refreshNow(), true);
  assert.equal(refreshCallCount, 1);
  assert.equal(changed, 1);
  const updated = await readAuthStore(home);
  assert.ok(updated);
  assert.equal(updated!.tokens!.refresh_token, "rt-1"); // 沿用旧值
  const status = await manager.getStatus();
  assert.equal(status.accessTokenExpired, false);
  assert.equal(status.needsReLogin, false);
  // 并发 refreshNow 去重为一次网络请求
  await Promise.all([manager.refreshNow(), manager.refreshNow()]);
  assert.equal(refreshCallCount, 2);
});

test("refreshNow：永久失败 → needsReLogin + relogin-required 事件", async () => {
  const home = await tempHome();
  await writeAuthStore(home, makeAuth({ lastRefresh: new Date().toISOString() }));
  const fetch: FetchLike = (async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
    })) as FetchLike;
  const manager = new BridgeAuthManager({ codexHome: home, fetchImpl: fetch });
  let reloginRequired = 0;
  manager.on("relogin-required", () => (reloginRequired += 1));

  assert.equal(await manager.refreshNow(), false);
  assert.equal(reloginRequired, 1);
  const status = await manager.getStatus();
  assert.equal(status.needsReLogin, true);
});

test("refreshNow：暂时性失败不发 relogin-required，可重试", async () => {
  const home = await tempHome();
  await writeAuthStore(home, makeAuth({ lastRefresh: new Date().toISOString() }));
  let call = 0;
  const fetch: FetchLike = (async () => {
    call += 1;
    if (call === 1) {
      return new Response("boom", { status: 500 });
    }
    return new Response(
      JSON.stringify({
        id_token: tokenJwt(),
        access_token: tokenJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: "rt-2",
      }),
      { status: 200 },
    );
  }) as FetchLike;
  const manager = new BridgeAuthManager({ codexHome: home, fetchImpl: fetch });
  let reloginRequired = 0;
  let refreshFailed = 0;
  manager.on("relogin-required", () => (reloginRequired += 1));
  manager.on("refresh-failed", () => (refreshFailed += 1));

  assert.equal(await manager.refreshNow(), false);
  assert.equal(reloginRequired, 0);
  assert.equal(refreshFailed, 1);
  assert.equal(await manager.refreshNow(), true);
  assert.equal((await readAuthStore(home))!.tokens!.refresh_token, "rt-2");
});

test("handleUnauthorized：磁盘已变 → reloaded；刷新成功 → refreshed；永久失败 → relogin", async () => {
  // 场景 1：其他进程已刷新磁盘（token 不同）
  const home1 = await tempHome();
  await writeAuthStore(home1, makeAuth({ lastRefresh: new Date().toISOString() }));
  const m1 = new BridgeAuthManager({ codexHome: home1 });
  const before = await readAuthStore(home1);
  await writeAuthStore(home1, {
    ...makeAuth({ lastRefresh: new Date().toISOString() }),
    tokens: {
      ...makeAuth({ lastRefresh: new Date().toISOString() }).tokens!,
      access_token: tokenJwt(Math.floor(Date.now() / 1000) + 3600),
    },
  });
  assert.equal(
    (await m1.handleUnauthorized(before!.tokens!.access_token)).action,
    "reloaded",
  );

  // 场景 2：磁盘未变，靠刷新恢复
  const home2 = await tempHome();
  await writeAuthStore(home2, makeAuth({ lastRefresh: new Date().toISOString() }));
  const okFetch: FetchLike = (async () =>
    new Response(
      JSON.stringify({
        id_token: tokenJwt(),
        access_token: tokenJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: "rt-2",
      }),
      { status: 200 },
    )) as FetchLike;
  const m2 = new BridgeAuthManager({ codexHome: home2, fetchImpl: okFetch });
  const diskToken2 = (await readAuthStore(home2))!.tokens!.access_token;
  assert.equal((await m2.handleUnauthorized(diskToken2)).action, "refreshed");

  // 场景 3：刷新永久失败
  const home3 = await tempHome();
  await writeAuthStore(home3, makeAuth({ lastRefresh: new Date().toISOString() }));
  const badFetch: FetchLike = (async () =>
    new Response(JSON.stringify({ error: "refresh_token_expired" }), {
      status: 400,
    })) as FetchLike;
  const m3 = new BridgeAuthManager({ codexHome: home3, fetchImpl: badFetch });
  const diskToken3 = (await readAuthStore(home3))!.tokens!.access_token;
  assert.equal(
    (await m3.handleUnauthorized(diskToken3)).action,
    "relogin-required",
  );
});

test("authHeaders：临期先刷新，产出 Bearer + chatgpt-account-id", async () => {
  const home = await tempHome();
  await writeAuthStore(
    home,
    makeAuth({
      expSeconds: Math.floor(Date.now() / 1000) + 60,
      lastRefresh: new Date().toISOString(),
    }),
  );
  const fetch: FetchLike = (async () =>
    new Response(
      JSON.stringify({
        id_token: tokenJwt(),
        access_token: tokenJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: "rt-2",
      }),
      { status: 200 },
    )) as FetchLike;
  const manager = new BridgeAuthManager({ codexHome: home, fetchImpl: fetch });
  const headers = await manager.authHeaders();
  assert.match(headers.authorization, /^Bearer /);
  assert.equal(headers["chatgpt-account-id"], "acc-1");
});

test("loginServer：正确回调拿到 code；错误 state 不放行", async () => {
  // port:0 由系统分配临时端口，避免与并发套件/残留实例争用 1455 导致 ECONNRESET。
  const server = await startLoginServer({ port: 0, state: "expected-state", timeoutMs: 3000 });
  let callbackPromise: Promise<CallbackOutcome> | undefined;
  try {
    callbackPromise = server.waitForCallback;

    // 错误 state：不应 resolve
    const bad = await fetch(`http://127.0.0.1:${server.port}/auth/callback?code=x&state=wrong`);
    assert.equal(bad.status, 400);

    // 正确 state：resolve 出 code
    const good = await fetch(
      `http://127.0.0.1:${server.port}/auth/callback?code=abc&state=expected-state`,
    );
    assert.equal(good.status, 200);
    const outcome = await callbackPromise;
    assert.equal(outcome.code, "abc");
  } finally {
    // 任意断言失败也保证关闭服务器，避免 1455/临时端口 LISTEN 泄漏导致 node:test 子进程不退出。
    await server.close();
    await callbackPromise?.catch(() => {});
  }
});

test("loginServer：oauth error 回调 → reject 并带错误信息", async () => {
  const server = await startLoginServer({ port: 0, state: "s", timeoutMs: 3000 });
  let rejection: Promise<void> | undefined;
  try {
    rejection = assert.rejects(
      server.waitForCallback,
      /oauth callback error: access_denied/,
    );
    await fetch(
      `http://127.0.0.1:${server.port}/auth/callback?error=access_denied&error_description=no+entitlement`,
    );
    await rejection;
  } finally {
    await server.close();
    await rejection?.catch(() => {});
  }
});
