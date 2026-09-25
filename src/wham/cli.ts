/**
 * mock wham 服务器 CLI：
 *   npm run wham -- [--port 8787] [--no-script] [--turn "消息"] [--workspace dir] [--jsonl path]
 *
 * 默认帧日志：.agent-work/tmp/wham-probe/session-<timestamp>.jsonl
 * 配合 codex：
 *   CODEX_HOME=var/codex-home codex remote-control start -c chatgpt_base_url="http://127.0.0.1:8787/backend-api"
 */
import { join, resolve } from "node:path";
import { MockWhamServer } from "./mockServer.ts";

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

async function main(): Promise<void> {
  const port = Number(argValue("--port") ?? 8787);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonlPath =
    argValue("--jsonl") ??
    join(process.cwd(), ".agent-work", "tmp", "wham-probe", `session-${timestamp}.jsonl`);

  const server = new MockWhamServer({
    port,
    jsonlPath,
    autoScript: !hasFlag("--no-script"),
    turnText: argValue("--turn"),
    workspace: argValue("--workspace") ? resolve(argValue("--workspace")!) : undefined,
  });
  await server.start();
  console.error(`帧日志: ${jsonlPath}`);
  console.error("等待 codex 连接（Ctrl+C 退出）…");

  const shutdown = async () => {
    console.error("\n shutting down…");
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
