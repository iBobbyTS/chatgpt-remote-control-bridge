/**
 * 模拟层 CLI：桥扮演 codex 被控端，对手机端请求返回固定/模拟响应（不接 LLM）。
 *
 *   npm run sim                 # enroll → WSS → 配对码 → 持续服务
 *   npm run sim -- --no-pair    # 跳过配对（此前已配对过时）
 *   npm run sim -- --name "我的模拟机" --base-url http://127.0.0.1:8787/backend-api
 *
 * 认证：复用 bridge 自己的 codex-home（npm run auth -- login），绝不读 ~/.codex。
 */
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeAuthManager } from "../auth/manager.ts";
import { WhamClient } from "../wham/client.ts";
import { SimWhamServer } from "./server.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const doPair = !args.includes("--no-pair");
const codexHome = resolve(
  process.env.BRIDGE_CODEX_HOME
    ? process.env.BRIDGE_CODEX_HOME
    : argValue("--codex-home")
      ? argValue("--codex-home")!
      : join(repoRoot, "var", "codex-home"),
);
const baseUrl = argValue("--base-url");
const name = argValue("--name") ?? `${hostname()} (bridge-sim)`;
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonlPath =
  argValue("--jsonl") ??
  join(repoRoot, ".agent-work", "tmp", "sim", `frames-${timestamp}.jsonl`);

async function main(): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  const authManager = new BridgeAuthManager({ codexHome });
  const status = await authManager.getStatus();
  if (!status.loggedIn) {
    console.error("未登录：先运行 npm run auth -- login");
    process.exit(1);
  }
  console.error(`账号: ${status.email} (plan=${status.planType ?? "?"})`);
  authManager.startAutoRefresh();

  const server = new SimWhamServer({
    authManager,
    baseUrl,
    name,
    jsonlPath,
    log: (line) => console.error(`[sim] ${line}`),
  });
  await server.start();
  console.error(`帧日志: ${jsonlPath}`);

  const shutdown = () => {
    console.error("[sim] shutting down…");
    void server.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!doPair) {
    console.error("（--no-pair：跳过配对；此前已配对的手机可直接使用）");
    return;
  }
  // 配对：pair 接口用 remote_control_token，而非账号 token
  const client = new WhamClient({ authManager, baseUrl });
  const pairing = await client.pair({
    remoteControlToken: server.pairToken!,
    manualCode: true,
  });
  console.error(
    `\n配对码: ${pairing.manual_pairing_code ?? pairing.pairing_code}` +
      `（在手机 ChatGPT App 的 Codex/Remote 配对入口输入；有效期至 ${pairing.expires_at}）\n`,
  );
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const { claimed } = await client.pairStatus({
        // 后端要求「恰好一个」code：只传手机实际输入的 manual code
        manualPairingCode: pairing.manual_pairing_code ?? pairing.pairing_code,
        remoteControlToken: server.pairToken!,
      });
      if (claimed) {
        console.error("✓ 手机已 claim 本机（配对完成）。现在可以在手机上看到模拟服务器并开始任务。");
        return;
      }
    } catch (err) {
      // 单次轮询失败不终止服务（token 过期重配等场景）
      console.error(`pair/status 轮询失败（继续）: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.error("（5 分钟内未完成配对；进程继续运行，可手动重试）");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
