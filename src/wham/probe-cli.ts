/**
 * 真实 wham 后端探测 CLI：
 *   npm run wham:probe             # enroll 验证
 *   npm run wham:probe -- --pair   # enroll + pair，打印配对码并轮询手机 claim
 *
 * token 永不完整打印（只显示前缀）。
 */
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeAuthManager } from "../auth/manager.ts";
import { WhamClient } from "./client.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function redact(token: string): string {
  return `${token.slice(0, 8)}…(${token.length} chars)`;
}

async function main(): Promise<void> {
  const codexHome = process.env.BRIDGE_CODEX_HOME
    ? resolve(process.env.BRIDGE_CODEX_HOME)
    : join(repoRoot, "var", "codex-home");
  const authManager = new BridgeAuthManager({ codexHome });
  const status = await authManager.getStatus();
  if (!status.loggedIn) {
    console.error("未登录：先运行 npm run auth -- login");
    process.exit(1);
  }
  console.error(`账号: ${status.email} (plan=${status.planType ?? "?"})`);

  const client = new WhamClient({ authManager });
  const enrolled = await client.enroll({
    name: hostname(),
    appServerVersion: "0.156.1",
  });
  console.error(
    `enroll ✓ server_id=${enrolled.server_id}\n` +
      `  environment_id=${enrolled.environment_id}\n` +
      `  remote_control_token=${redact(enrolled.remote_control_token)}\n` +
      `  expires_at=${enrolled.expires_at}`,
  );

  if (process.argv.includes("--pair")) {
    const pairing = await client.pair({
      remoteControlToken: enrolled.remote_control_token,
      manualCode: true,
    });
    console.error(
      `pair ✓ pairing_code=${pairing.pairing_code} ` +
        `manual_pairing_code=${pairing.manual_pairing_code} expires=${pairing.expires_at}`,
    );
    console.error("在手机 ChatGPT App（Settings → Remote/Codex）中输入配对码…");
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const { claimed } = await client.pairStatus({
        pairingCode: pairing.pairing_code,
        manualPairingCode: pairing.manual_pairing_code ?? undefined,
      });
      if (claimed) {
        console.error("✓ 手机已 claim 本机（配对完成）");
        return;
      }
      process.stderr.write(".");
    }
    console.error("\n超时：手机未完成配对（可重试）");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
