/**
 * CgrcbDaemon（PLAN S02 ③）：配置 → 逐 enabled agent 建实例 → WhamTunnel 启停，
 * 单实例故障隔离 + 指数退避重启，SIGTERM/SIGINT 优雅停，本地 IPC 服务端。
 *
 * 职责边界：
 * - 实例创建走**注册表延迟工厂**（src/agents/registry.ts），daemon 不 import 具体 agent。
 * - **enrollment.json 唯一生产者 = WhamTunnel**（构造时传 installationDir，tunnel 自写）。
 *   daemon 只订阅 `"enrollment"` 事件更新 lifecycle.json，绝不重复写 enrollment.json
 *   （避免双写冲突；文件由实例生命周期保证存在）。
 * - **lifecycle.json**：实例目录首次创建时（daemon 亲历 mkdir）写 {everEnrolled:false}；
 *   首个 enrollment 事件置 true，此后不重置/删除；已有目录缺失该文件时 enable 不补写。
 * - 本节 enable/disable 不实现配对吊销（S04）；pair/pair-status/agent-init/agent-reset/
 *   auth-reset 仅分发骨架，返回 INTERNAL "not implemented"。
 */
import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import type { AgentApp } from "../agents/types.ts";
import {
  getAgent,
  listAgents,
  type AgentInstanceContext,
  type AgentModule,
} from "../agents/registry.ts";
import { BridgeAuthManager } from "../auth/manager.ts";
import { WhamTunnel } from "../wham/tunnel.ts";
import { readLifecycle, readConfig, writeConfig, writeLifecycle, withAgentEnabled, type AgentConfig, type CgrcbConfig } from "./config.ts";
import {
  cgrcbPaths,
  instanceDirFor,
  instancePaths,
  resolveCgrcbHome,
  type CgrcbPaths,
} from "./paths.ts";
import {
  IpcServer,
  type AgentInstanceStatus,
  type AgentRuntimeStatus,
  type DaemonStatusPayload,
  type IpcRequest,
  type IpcResponse,
} from "./ipc.ts";

export interface CgrcbDaemonOptions {
  /** 数据根目录；默认 CGRCB_HOME / ~/.cgrcb。 */
  home?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** 注入登录态管理器（测试用）；默认按 <root>/home 建。 */
  authManager?: BridgeAuthManager;
  /** wham REST/WS baseUrl（测试指向 mock）。 */
  baseUrl?: string;
  name?: string;
  appServerVersion?: string;
  jsonlPath?: string;
  reconnectDelayMs?: number;
  pingIntervalMs?: number;
  refreshThresholdMs?: number;
  agentLabel?: string;
  /** 故障重启退避基数；默认 1000ms。 */
  restartBaseDelayMs?: number;
  /** 故障重启退避上限；默认 30000ms。 */
  restartMaxDelayMs?: number;
  /** 是否安装 SIGTERM/SIGINT 处理（默认 true）。 */
  installSignalHandlers?: boolean;
  /** 收到信号并在 shutdown 完成后是否 process.exit(0)（默认 false；S05 daemon 入口用）。 */
  exitOnSignal?: boolean;
}

interface InstanceRuntime {
  id: string;
  status: AgentInstanceStatus;
  tunnel: WhamTunnel | null;
  app: AgentApp | null;
  error: string | null;
  attempts: number;
  restartTimer: NodeJS.Timeout | null;
  everEnrolled: boolean;
  warnings: string[];
  identityWarnings: string[];
}

const NOT_IMPLEMENTED_OPS = new Set<IpcRequest["op"]>([
  "pair",
  "pair-status",
  "agent-init",
  "agent-reset",
  "auth-reset",
]);

export class CgrcbDaemon {
  readonly paths: CgrcbPaths;
  private readonly opts: CgrcbDaemonOptions;
  private authManager: BridgeAuthManager | null = null;
  private config: CgrcbConfig = { version: 1, agents: {} };
  private ipcServer: IpcServer | null = null;
  private readonly instances = new Map<string, InstanceRuntime>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private stopping = false;
  private running = false;
  private startedAt = 0;
  private stopPromise: Promise<void> | null = null;
  private signalsInstalled = false;
  private readonly signalHandler = (): void => {
    this.logLine("收到停止信号，优雅退出…");
    void this.shutdown("signal")
      .catch((err) => this.logLine(`shutdown 失败: ${errorMessage(err)}`))
      .finally(() => {
        if (this.opts.exitOnSignal) process.exit(0);
      });
  };

  constructor(opts: CgrcbDaemonOptions = {}) {
    this.opts = opts;
    this.paths = cgrcbPaths(opts.home ?? resolveCgrcbHome(opts.env));
  }

  get home(): string {
    return this.paths.root;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 加载配置 → 起 IPC → 逐 enabled agent 建实例。 */
  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    this.stopPromise = null;
    await mkdir(this.paths.root, { recursive: true });
    await mkdir(this.paths.instancesDir, { recursive: true });
    await mkdir(this.paths.logsDir, { recursive: true });
    this.config = await readConfig(this.paths.configPath);
    this.authManager =
      this.opts.authManager ??
      new BridgeAuthManager({ codexHome: this.paths.codexHome });

    this.ipcServer = new IpcServer({
      socketPath: this.paths.socketPath,
      handler: (request) => this.handleIpc(request),
      log: (line) => this.logLine(line),
    });
    await this.ipcServer.start(); // stale socket 在此清理；占用则抛 DaemonAlreadyRunningError

    this.authManager.startAutoRefresh();
    this.installSignals();
    this.running = true;
    this.startedAt = Date.now();
    this.logLine(`daemon 已启动 home=${this.paths.root} pid=${process.pid}`);

    for (const [id, cfg] of Object.entries(this.config.agents)) {
      if (cfg.enabled) {
        // 同步登记 starting 记录后异步启动，status 立即可见
        void this.startInstance(id).catch((err) =>
          this.logLine(`[${id}] 启动失败: ${errorMessage(err)}`),
        );
      }
    }
  }

  /** 幂等优雅停：先停全部隧道（内部关 app）→ 关 IPC + 清 socket → 停自动刷新。 */
  shutdown(reason = "manual"): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.doShutdown(reason);
    }
    return this.stopPromise;
  }

  private async doShutdown(reason: string): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.removeSignals();
    for (const inst of this.instances.values()) {
      if (inst.restartTimer) {
        clearTimeout(inst.restartTimer);
        inst.restartTimer = null;
      }
      if (inst.status !== "stopping") inst.status = "stopping";
    }
    // 先停全部隧道（tunnel.stop 内部调 app.close）
    await Promise.all([...this.instances.values()].map((inst) => this.disposeInstance(inst)));
    this.instances.clear();
    if (this.ipcServer) {
      await this.ipcServer.close();
      this.ipcServer = null;
    }
    this.authManager?.stopAutoRefresh();
    this.logLine(`daemon 已停止（${reason}）`);
  }

  // ------------------------------------------------------------------ 实例

  private newInstance(id: string): InstanceRuntime {
    return {
      id,
      status: "starting",
      tunnel: null,
      app: null,
      error: null,
      attempts: 0,
      restartTimer: null,
      everEnrolled: false,
      warnings: [],
      identityWarnings: [],
    };
  }

  private async startInstance(id: string): Promise<void> {
    if (this.stopping) return;
    const existing = this.instances.get(id);
    if (existing && (existing.status === "online" || existing.status === "starting")) {
      return;
    }
    const inst = existing ?? this.newInstance(id);
    this.instances.set(id, inst);
    inst.status = "starting";
    const module = getAgent(id);
    try {
      await this.startInto(inst, module);
      inst.status = "online";
      inst.error = null;
      inst.attempts = 0;
      this.logLine(`[${id}] 实例在线`);
    } catch (err) {
      inst.status = "failed";
      inst.error = errorMessage(err);
      this.logLine(`[${id}] 实例启动失败: ${inst.error}`);
      await this.disposeInstance(inst);
      // 未注册模块不可恢复，不调度重启
      if (module) this.scheduleRestart(inst);
    }
  }

  /** 建 app（工厂）→ 建 tunnel → 订阅事件 → start。工厂同步抛错由调用方捕获。 */
  private async startInto(inst: InstanceRuntime, module: AgentModule | undefined): Promise<void> {
    if (!module) {
      inst.status = "failed";
      inst.error = `agent 模块未注册: ${inst.id}`;
      this.logLine(`[${inst.id}] agent 模块未注册，无法启动`);
      return;
    }
    const dir = instanceDirFor(this.paths.root, inst.id);
    await this.ensureInstanceDir(dir); // 首次创建 → 写 lifecycle.json
    const paths = instancePaths(dir);
    const lifecycle = await readLifecycle(paths.lifecycle);
    inst.everEnrolled = lifecycle?.everEnrolled === true;

    let tunnelRef: WhamTunnel | null = null;
    const ctx: AgentInstanceContext = {
      instanceDir: dir,
      authManager: this.authManager!,
      identity: () => tunnelRef?.identity() ?? null,
      log: (line) => this.logLine(`[${inst.id}] ${line}`),
    };
    const app = module.createInstance(ctx); // 可能同步抛错

    const cfg = this.config.agents[inst.id] as AgentConfig | undefined;
    const name =
      (typeof cfg?.name === "string" && cfg.name) ||
      this.opts.name ||
      `${hostname()} (${inst.id})`;
    const tunnel = new WhamTunnel({
      authManager: this.authManager!,
      app,
      baseUrl: this.opts.baseUrl,
      name,
      appServerVersion: this.opts.appServerVersion,
      installationDir: dir,
      jsonlPath: this.opts.jsonlPath,
      log: (line) => this.logLine(`[${inst.id}] ${line}`),
      reconnectDelayMs: this.opts.reconnectDelayMs,
      pingIntervalMs: this.opts.pingIntervalMs,
      refreshThresholdMs: this.opts.refreshThresholdMs,
      agentLabel: this.opts.agentLabel ?? `bridge-${inst.id}`,
    });
    tunnelRef = tunnel;
    inst.app = app;
    inst.tunnel = tunnel;
    tunnel.on("warn", (line) => inst.warnings.push(String(line)));
    tunnel.on("enrollment", () => {
      void this.onEnrollment(inst).catch((err) =>
        this.logLine(`[${inst.id}] lifecycle 更新失败: ${errorMessage(err)}`),
      );
    });
    tunnel.on("fault", (err, context) =>
      this.onInstanceFault(inst.id, err, String(context)),
    );
    await tunnel.start();
  }

  private async disposeInstance(inst: InstanceRuntime): Promise<void> {
    const tunnel = inst.tunnel;
    const app = inst.app;
    inst.tunnel = null;
    inst.app = null;
    if (tunnel) {
      try {
        await tunnel.stop(); // 内部调 app.close
      } catch (err) {
        this.logLine(`[${inst.id}] 隧道停止失败: ${errorMessage(err)}`);
      }
    } else if (app) {
      try {
        app.close();
      } catch {
        // 忽略关闭异常
      }
    }
  }

  private scheduleRestart(inst: InstanceRuntime): void {
    if (this.stopping || inst.restartTimer) return;
    const delay = Math.min(
      (this.opts.restartBaseDelayMs ?? 1000) * 2 ** inst.attempts,
      this.opts.restartMaxDelayMs ?? 30_000,
    );
    inst.attempts += 1;
    this.logLine(`[${inst.id}] ${delay}ms 后重启（第 ${inst.attempts} 次退避）`);
    inst.restartTimer = setTimeout(() => {
      inst.restartTimer = null;
      void this.restartInstance(inst.id).catch((err) =>
        this.logLine(`[${inst.id}] 重启失败: ${errorMessage(err)}`),
      );
    }, delay);
  }

  private async restartInstance(id: string): Promise<void> {
    if (this.stopping) return;
    const inst = this.instances.get(id);
    if (!inst || this.config.agents[id]?.enabled !== true) return;
    await this.disposeInstance(inst);
    inst.status = "starting";
    try {
      await this.startInto(inst, getAgent(id));
      inst.status = "online";
      inst.error = null;
      inst.attempts = 0;
      this.logLine(`[${id}] 实例已恢复在线`);
    } catch (err) {
      inst.status = "failed";
      inst.error = errorMessage(err);
      this.logLine(`[${id}] 实例恢复失败: ${inst.error}`);
      await this.disposeInstance(inst);
      this.scheduleRestart(inst);
    }
  }

  private onInstanceFault(id: string, err: unknown, context: string): void {
    if (this.stopping) return;
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.error = `${context}: ${errorMessage(err)}`;
    if (inst.status === "online") inst.status = "failed";
    this.scheduleRestart(inst);
  }

  /**
   * enrollment 事件 → lifecycle.everEnrolled 置 true。
   * 文件缺失（历史不明）时**不补写**（S04 (c) 分支②依赖此语义）。
   */
  private async onEnrollment(inst: InstanceRuntime): Promise<void> {
    const dir = instanceDirFor(this.paths.root, inst.id);
    const paths = instancePaths(dir);
    const current = await readLifecycle(paths.lifecycle);
    if (!current) {
      this.logLine(`[${inst.id}] lifecycle.json 缺失，不补写（历史不明）`);
      return;
    }
    if (current.everEnrolled) {
      inst.everEnrolled = true;
      return;
    }
    await writeLifecycle(paths.lifecycle, { ...current, everEnrolled: true });
    inst.everEnrolled = true;
    this.logLine(`[${inst.id}] lifecycle.everEnrolled=true`);
  }

  /** 实例目录首次创建时写 lifecycle.json；已存在目录不补写。 */
  private async ensureInstanceDir(dir: string): Promise<void> {
    try {
      await mkdir(dir); // 父目录 instances/ 已在 start 建立；已存在 → EEXIST
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      throw err;
    }
    await writeLifecycle(instancePaths(dir).lifecycle, { everEnrolled: false });
  }

  // -------------------------------------------------------------------- IPC

  private isKnownAgent(id: string): boolean {
    return !!getAgent(id) || this.config.agents[id] !== undefined || this.instances.has(id);
  }

  private async handleIpc(request: IpcRequest): Promise<IpcResponse> {
    try {
      switch (request.op) {
        case "status":
          return { ok: true, data: await this.statusPayload() };
        case "agent-status": {
          const id = request.agent;
          if (!id || !this.isKnownAgent(id)) return unknownAgent(id);
          return { ok: true, data: await this.agentStatus(id) };
        }
        case "enable":
          return await this.withAgentLock(request.agent, () => this.doEnable(request.agent));
        case "disable":
          return await this.withAgentLock(request.agent, () => this.doDisable(request.agent));
        default:
          if (NOT_IMPLEMENTED_OPS.has(request.op)) {
            return { ok: false, error: "INTERNAL", message: "not implemented" };
          }
          return {
            ok: false,
            error: "INTERNAL",
            message: `未知 op: ${String((request as { op?: unknown }).op)}`,
          };
      }
    } catch (err) {
      return { ok: false, error: "INTERNAL", message: errorMessage(err) };
    }
  }

  private async doEnable(id: string | undefined): Promise<IpcResponse> {
    if (!id || !getAgent(id)) return unknownAgent(id);
    const auth = await this.authManager!.getStatus();
    if (!auth.loggedIn) {
      return { ok: false, error: "NOT_LOGGED_IN", message: "未登录：请先执行 chatgpt login" };
    }
    if (this.config.agents[id]?.enabled !== true) {
      this.config = withAgentEnabled(this.config, id, true);
      await writeConfig(this.paths.configPath, this.config);
    }
    const inst = this.instances.get(id);
    if (!inst || inst.status === "disabled") {
      await this.startInstance(id);
    } else if (inst.status === "failed") {
      if (inst.restartTimer) {
        clearTimeout(inst.restartTimer);
        inst.restartTimer = null;
      }
      await this.restartInstance(id);
    }
    return { ok: true, data: await this.agentStatus(id) };
  }

  private async doDisable(id: string | undefined): Promise<IpcResponse> {
    if (!id || !this.isKnownAgent(id)) return unknownAgent(id);
    if (this.config.agents[id]?.enabled === true) {
      this.config = withAgentEnabled(this.config, id, false);
      await writeConfig(this.paths.configPath, this.config);
    }
    const inst = this.instances.get(id);
    if (inst) {
      if (inst.restartTimer) {
        clearTimeout(inst.restartTimer);
        inst.restartTimer = null;
      }
      inst.status = "stopping";
      await this.disposeInstance(inst);
      this.instances.delete(id);
    }
    // 占位：清 pairing 状态（真正的吊销/清理在 S04）
    await rm(instancePaths(instanceDirFor(this.paths.root, id)).pairing, { force: true });
    return { ok: true, data: await this.agentStatus(id) };
  }

  /** 同 agent 的 enable/disable/重启串行化，避免半状态。 */
  private async withAgentLock(
    id: string | undefined,
    fn: () => Promise<IpcResponse>,
  ): Promise<IpcResponse> {
    if (!id) return unknownAgent(id);
    const prev = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(
      id,
      prev.then(() => next),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ------------------------------------------------------------------ status

  async statusPayload(): Promise<DaemonStatusPayload> {
    const auth = await this.authManager!.getStatus();
    const ids = new Set<string>([
      ...Object.keys(this.config.agents),
      ...listAgents().map((m) => m.id),
      ...this.instances.keys(),
    ]);
    const agents: Record<string, AgentRuntimeStatus> = {};
    for (const id of ids) {
      agents[id] = await this.agentStatus(id);
    }
    return {
      daemon: {
        pid: process.pid,
        home: this.paths.root,
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeMs: Date.now() - this.startedAt,
        running: this.running,
      },
      auth,
      agents,
    };
  }

  async agentStatus(id: string): Promise<AgentRuntimeStatus> {
    const cfg = this.config.agents[id];
    const inst = this.instances.get(id);
    const registered = !!getAgent(id);
    const dir = instanceDirFor(this.paths.root, id);
    const lifecycle = await readLifecycle(instancePaths(dir).lifecycle);
    const everEnrolled = lifecycle ? lifecycle.everEnrolled === true : null;
    if (!inst) {
      const enabled = cfg?.enabled === true;
      return {
        id,
        registered,
        enabled,
        status: enabled ? "failed" : "disabled",
        online: false,
        connected: false,
        serverId: null,
        environmentId: null,
        installationId: null,
        everEnrolled,
        identityWarnings: [],
        warnings: [],
        error: enabled && !registered ? `agent 模块未注册: ${id}` : null,
      };
    }
    const tunnel = inst.tunnel;
    const identity = tunnel?.identity() ?? null;
    return {
      id,
      registered,
      enabled: cfg?.enabled === true,
      status: inst.status,
      online: inst.status === "online" && !!tunnel?.connected,
      connected: tunnel?.connected ?? false,
      serverId: tunnel?.serverId ?? null,
      environmentId: identity?.environmentId ?? tunnel?.enrollmentSnapshot?.environment_id ?? null,
      installationId: identity?.installationId ?? null,
      everEnrolled,
      identityWarnings: tunnel?.identityWarnings ?? [],
      warnings: tunnel?.warnings ?? [],
      error: inst.error,
    };
  }

  // ---------------------------------------------------------------- 信号/日志

  private installSignals(): void {
    if (this.signalsInstalled || this.opts.installSignalHandlers === false) return;
    process.on("SIGTERM", this.signalHandler);
    process.on("SIGINT", this.signalHandler);
    this.signalsInstalled = true;
  }

  private removeSignals(): void {
    if (!this.signalsInstalled) return;
    process.off("SIGTERM", this.signalHandler);
    process.off("SIGINT", this.signalHandler);
    this.signalsInstalled = false;
  }

  private logLine(line: string): void {
    (this.opts.log ?? ((l) => console.error(`[cgrcb-daemon] ${l}`)))(line);
  }
}

function unknownAgent(id: string | undefined): IpcResponse {
  return { ok: false, error: "UNKNOWN_AGENT", message: `未知 agent: ${id ?? "(未指定)"}` };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
