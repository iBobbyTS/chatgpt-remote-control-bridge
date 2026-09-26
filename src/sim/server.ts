/**
 * SimWhamServer：sim 下游对 WhamTunnel 的适配层（整体迁移在 S03）。
 *
 * 行为与旧实现逐帧一致（seq/ack/ping-pong/分片重组/重连/token 临期续期），
 * 但隧道逻辑已提炼到通用 src/wham/tunnel.ts。本文件仅：
 * - 在未注入 app 时按旧语义构造 SimApp（含 getServerInfo，读隧道身份）
 * - 将 connected/serverId/pairToken/start/stop 转发给 WhamTunnel
 *
 *   手机 ChatGPT App ── wham 后端 ──WSS──▶ WhamTunnel（本进程）
 */
import { hostname } from "node:os";
import { join } from "node:path";
import type { BridgeAuthManager } from "../auth/manager.ts";
import { WhamTunnel } from "../wham/tunnel.ts";
import { SimApp } from "./appServer.ts";

export interface SimWhamServerOptions {
  authManager: BridgeAuthManager;
  /** 默认 https://chatgpt.com/backend-api；测试指向 mock。 */
  baseUrl?: string;
  name?: string;
  appServerVersion?: string;
  app?: SimApp;
  jsonlPath?: string;
  log?: (line: string) => void;
  /** WS 断开重连延迟；0 = 不重连（测试用）。默认 2000ms。 */
  reconnectDelayMs?: number;
}

export class SimWhamServer {
  readonly app: SimApp;
  private readonly tunnel: WhamTunnel;

  constructor(opts: SimWhamServerOptions) {
    const name = opts.name ?? `${hostname()} (bridge-sim)`;
    // app 未注入时按旧语义构造；getServerInfo 晚绑定到 tunnel（构造顺序：app → tunnel）
    let tunnelRef: WhamTunnel | null = null;
    this.app =
      opts.app ??
      new SimApp({
        codexHome: opts.authManager.codexHome,
        // 线程状态持久化：手机缓存 thread id，重启后必须可 resume
        statePath: join(opts.authManager.codexHome, "sim-state.json"),
        getServerInfo: () => tunnelRef?.identity() ?? null,
      });
    this.tunnel = new WhamTunnel({
      authManager: opts.authManager,
      app: this.app,
      baseUrl: opts.baseUrl,
      name,
      appServerVersion: opts.appServerVersion,
      installationDir: opts.authManager.codexHome,
      jsonlPath: opts.jsonlPath,
      log: opts.log ?? ((line) => console.error(`[sim] ${line}`)),
      reconnectDelayMs: opts.reconnectDelayMs,
      agentLabel: "bridge-sim",
    });
    tunnelRef = this.tunnel;
  }

  get connected(): boolean {
    return this.tunnel.connected;
  }

  get serverId(): string | null {
    return this.tunnel.serverId;
  }

  /** enroll 发放的 remote_control_token（pair REST 用）。 */
  get pairToken(): string | null {
    return this.tunnel.pairToken;
  }

  /** enroll + 拨 WSS。 */
  start(): Promise<void> {
    return this.tunnel.start();
  }

  stop(): Promise<void> {
    return this.tunnel.stop();
  }
}
