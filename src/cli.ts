/**
 * 认证 CLI：
 *   npm run auth -- login [--no-browser] [--json]
 *   npm run auth -- status [--json]
 *   npm run auth -- refresh
 *   npm run auth -- logout [--revoke]
 *   npm run auth -- headers     # 输出给下游（wham 客户端）用的请求头
 *
 * CODEX_HOME 环境变量指定 bridge 自己的凭证目录，
 * 默认 <repo>/var/codex-home（与 ~/.codex 完全隔离）。
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeAuthManager } from "./auth/manager.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function defaultCodexHome(): string {
  if (process.env.BRIDGE_CODEX_HOME) {
    return resolve(process.env.BRIDGE_CODEX_HOME);
  }
  if (process.env.CODEX_HOME) {
    return resolve(process.env.CODEX_HOME);
  }
  return join(repoRoot, "var", "codex-home");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(`usage: npm run auth -- <login|status|refresh|logout|headers> [options]
  login [--no-browser] [--json]   浏览器登录 ChatGPT（codex 同款 OAuth 流程）
  status [--json]                 登录状态与过期时间
  refresh                         立即刷新 tokens
  logout [--revoke]               登出（--revoke 同时撤销服务端 tokens）
  headers                         输出下游请求头（先保证 token 新鲜）`);
    return 0;
  }
  const codexHome = defaultCodexHome();
  await mkdir(codexHome, { recursive: true });
  const manager = new BridgeAuthManager({ codexHome });

  switch (command) {
    case "login": {
      const openBrowser = !rest.includes("--no-browser");
      const status = await manager.login({
        openBrowser,
        onAuthUrl: (url) => {
          console.error("请在浏览器中完成 ChatGPT 登录：");
          console.error(url);
        },
      });
      printResult(status, rest.includes("--json"));
      console.error(`已登录：${status.email ?? status.accountId}`);
      return 0;
    }
    case "status": {
      const status = await manager.getStatus();
      printResult(status, rest.includes("--json"));
      if (!rest.includes("--json")) {
        if (!status.loggedIn) {
          console.log("未登录。运行 npm run auth -- login");
        } else {
          console.log(`已登录: ${status.email ?? "(unknown email)"}`);
          console.log(`计划: ${status.planType ?? "unknown"}  账号: ${status.accountId ?? "-"}`);
          console.log(`access_token 过期: ${status.accessTokenExpiresAt ?? "unknown"}`);
          if (status.accessTokenExpired) console.log("access_token 已过期（下次使用时会自动刷新）");
          if (status.needsReLogin) console.log("需要重新登录（refresh_token 已失效）");
        }
      }
      return 0;
    }
    case "refresh": {
      const ok = await manager.refreshNow();
      const status = await manager.getStatus();
      printResult(status, rest.includes("--json"));
      if (!ok) {
        console.error(status.needsReLogin
          ? "刷新永久失败：请重新登录（npm run auth -- login）"
          : "刷新失败（暂时性），稍后自动重试");
        return 1;
      }
      console.error("刷新成功");
      return 0;
    }
    case "logout": {
      const removed = await manager.logout({ revoke: rest.includes("--revoke") });
      console.error(removed ? "已登出（auth.json 已删除）" : "本就未登录");
      return 0;
    }
    case "headers": {
      try {
        const headers = await manager.authHeaders();
        // 仅输出 authorization 前缀，避免完整 token 落入终端日志
        for (const [k, v] of Object.entries(headers)) {
          console.log(`${k}: ${k === "authorization" ? `${v.slice(0, 21)}…` : v}`);
        }
        return 0;
      } catch (err) {
        if (err instanceof Error && err.message === "not logged in") {
          console.error("未登录");
          return 1;
        }
        throw err;
      }
    }
    default:
      console.error(`未知命令: ${command}`);
      return 2;
  }
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
