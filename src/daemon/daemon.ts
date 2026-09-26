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
 *
 * 并发/竞态（评审修复）：
 * - **per-agent 操作队列**：启动/重启/disable 全部经同一 `serialize(id, …)` 串行化，
 *   shutdown 等待全部在途操作收敛（BLOCKER 1：启动窗口不得留孤儿隧道）。
 * - **实例代次**：tunnel 赋值前后复查 `stopping`/`instances.get(id) !== inst`，失效即停隧道。
 * - **配置提交串行化**：跨 agent 共写 config.json 经 `commitConfig` 队列，写盘成功后才发布内存。
 * - **fault 分级**（MATERIAL 6）：`handleRequest*` 的 per-request fault 由 tunnel 自行恢复，
 *   不拆整实例；仅结构性 fault（连接/协议/未知）触发退避重启。
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
  warnings: string[];
  identityWarnings: string[];
}

/** 启动/重启在 stopping 或实例代次失效时主动取消（BLOCKER 1）。 */
class InstanceCancelledError extends Error {
  constructor(reason: string) {
    super(`实例操作已取消：${reason}`);
    this.name = "InstanceCancelledError";
  }
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
  /** per-agent 操作队列（串行化）：启动/重启/disable 同一 key 排队。 */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** 在途操作（shutdown 等待其收敛，防孤儿隧道）。 */
  private readonly pendingOps = new Set<Promise<unknown>>();
  /** config.json 提交串行化（BLOCKER 2）。 */
  private configChain: Promise<unknown> = Promise.resolve();
  private stopping = false;
  /** shutdown() 同步置位（在 start 队列执行前即可见），用于 start 中途放弃（B-1）。 */
  private stopRequested = false;
  private running = false;
  private startedAt = 0;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  /** start/shutdown 生命周期串行化队列（B-1）。 */
  private lifecycleChain: Promise<unknown> = Promise.resolve();
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

  /**
   * 加载配置 → 起 IPC → 逐 enabled agent 建实例（经 per-agent 队列）。
   * 与 shutdown() 同一 lifecycle 队列串行（B-1）；start 每个 await 后复查 stopRequested。
   */
  start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.lifecycleChain.then(() => this.doStart());
      this.lifecycleChain = this.startPromise.then(
        () => undefined,
        () => undefined,
      );
    }
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.stopRequested) {
      throw new Error("daemon 已请求停止，start 被取消");
    }
    this.stopping = false;
    await mkdir(this.paths.root, { recursive: true });
    if (this.stopRequested) return this.abandonStart("stop requested");
    await mkdir(this.paths.instancesDir, { recursive: true });
    await mkdir(this.paths.logsDir, { recursive: true });
    if (this.stopRequested) return this.abandonStart("stop requested");
    this.config = await readConfig(this.paths.configPath);
    if (this.stopRequested) return this.abandonStart("stop requested");
    this.authManager =
      this.opts.authManager ??
      new BridgeAuthManager({ codexHome: this.paths.codexHome });

    this.ipcServer = new IpcServer({
      socketPath: this.paths.socketPath,
      handler: (request) => this.handleIpc(request),
      log: (line) => this.logLine(line),
    });
    await this.ipcServer.start(); // stale socket 在此清理；占用则抛 DaemonAlreadyRunningError
    if (this.stopRequested) return this.abandonStart("stop requested");

    this.authManager.startAutoRefresh();
    this.installSignals();
    this.running = true;
    this.startedAt = Date.now();
    this.logLine(`daemon 已启动 home=${this.paths.root} pid=${process.pid}`);
    if (this.stopRequested) return this.abandonStart("stop requested");

    // BLOCKER 1：初始自动启动也进入 per-agent 队列，disable/shutdown 可与之串行并等待
    for (const [id, cfg] of Object.entries(this.config.agents)) {
      if (cfg.enabled) {
        void this.serialize(id, () => this.startInstance(id)).catch((err) =>
          this.logLine(`[${id}] 启动失败: ${errorMessage(err)}`),
        );
      }
    }
  }

  /** start 中途收到 stop 请求：放弃并清理已建资源（IPC/socket/信号/自动刷新）。 */
  private async abandonStart(reason: string): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.removeSignals();
    this.authManager?.stopAutoRefresh();
    if (this.ipcServer) {
      await this.ipcServer.close();
      this.ipcServer = null;
    }
    this.logLine(`启动已中止：${reason}`);
  }

  /** 幂等优雅停：等待在途实例操作 → 停全部隧道（内部关 app）→ 关 IPC + 清 socket。 */
  shutdown(reason = "manual"): Promise<void> {
    // 同步置位：让 IPC handler/doStart 立即看到停止请求（B-1 与 DAEMON_BUSY 语义）
    this.stopRequested = true;
    this.stopping = true;
    if (!this.stopPromise) {
      this.stopPromise = this.lifecycleChain.then(() => this.doShutdown(reason));
      this.lifecycleChain = this.stopPromise.then(
        () => undefined,
        () => undefined,
      );
    }
    return this.stopPromise;
  }

  private async doShutdown(reason: string): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.removeSignals();
    for (const inst of this.instances.values()) {
      this.clearRestartTimer(inst);
      if (inst.status !== "stopping") inst.status = "stopping";
    }
    // BLOCKER 1：等待启动/重启/disable 等在途操作收敛，避免其继续建隧道留下孤儿
    while (this.pendingOps.size > 0) {
      await Promise.allSettled([...this.pendingOps]);
    }
    // 先停全部隧道（tunnel.stop 内部调 app.close）
    await Promise.all([...this.instances.values()].map((inst) => this.disposeInstance(inst)));
    this.instances.clear();
    await this.configChain.catch(() => undefined);
    if (this.ipcServer) {
      await this.ipcServer.close();
      this.ipcServer = null;
    }
    this.authManager?.stopAutoRefresh();
    this.logLine(`daemon 已停止（${reason}）`);
  }

  // ------------------------------------------------------------- 并发原语

  /** 同 key 操作串行化（per-agent 队列）；前序失败不阻塞后续。 */
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const task = prev.then(fn);
    const guarded = task.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, guarded);
    this.pendingOps.add(guarded);
    void guarded.then(() => {
      this.pendingOps.delete(guarded);
    });
    return task;
  }

  /** 仅在写盘成功后发布内存配置（BLOCKER 2：失败不改内存；跨 agent 串行不丢更新）。 */
  private commitConfig(mutate: (config: CgrcbConfig) => CgrcbConfig): Promise<void> {
    const task = this.configChain.then(async () => {
      const next = mutate(this.config);
      await writeConfig(this.paths.configPath, next);
      this.config = next;
    });
    this.configChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private isStale(inst: InstanceRuntime): boolean {
    return this.stopping || this.instances.get(inst.id) !== inst;
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
      if (this.isStale(inst)) {
        await this.disposeInstance(inst);
        return;
      }
      // A-NIT2：启动期 fault 排下的 pending restart 在成功后清除，避免多余健康重建
      this.clearRestartTimer(inst);
      inst.status = "online";
      inst.error = null;
      inst.attempts = 0;
      this.logLine(`[${id}] 实例在线`);
    } catch (err) {
      await this.disposeInstance(inst);
      if (err instanceof InstanceCancelledError) {
        this.logLine(`[${inst.id}] ${err.message}`);
        if (this.instances.get(inst.id) === inst) inst.status = "stopping";
        return;
      }
      inst.status = "failed";
      inst.error = errorMessage(err);
      this.logLine(`[${id}] 实例启动失败: ${inst.error}`);
      // 未注册模块不可恢复，不调度重启
      if (module) this.scheduleRestart(inst);
    }
  }

  /** 建 app（工厂）→ 建 tunnel → 订阅事件 → start。工厂同步抛错由调用方捕获。 */
  private async startInto(inst: InstanceRuntime, module: AgentModule | undefined): Promise<void> {
    // BLOCKER 5：缺模块必须 throw（走失败分支保留 failed），不得正常返回被覆盖成 online
    if (!module) {
      throw new Error(`agent 模块未注册: ${inst.id}`);
    }
    const dir = instanceDirFor(this.paths.root, inst.id);
    await this.ensureInstanceDir(dir); // 首次创建 → 写 lifecycle.json

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

    // BLOCKER 1：建隧道后、启动前/后复查代次；失效即停隧道并取消
    if (this.isStale(inst)) {
      await tunnel.stop();
      throw new InstanceCancelledError("daemon 停止/实例失效");
    }
    await tunnel.start();
    if (this.isStale(inst)) {
      await tunnel.stop();
      throw new InstanceCancelledError("daemon 停止/实例失效（启动后）");
    }
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
      // 重启同样进入 per-agent 队列，与 disable/shutdown 串行
      void this.serialize(inst.id, () => this.restartInstance(inst.id)).catch((err) =>
        this.logLine(`[${inst.id}] 重启失败: ${errorMessage(err)}`),
      );
    }, delay);
  }

  private clearRestartTimer(inst: InstanceRuntime): void {
    if (inst.restartTimer) {
      clearTimeout(inst.restartTimer);
      inst.restartTimer = null;
    }
  }

  private async restartInstance(id: string): Promise<void> {
    if (this.stopping) return;
    const inst = this.instances.get(id);
    if (!inst || this.config.agents[id]?.enabled !== true) return;
    await this.disposeInstance(inst);
    if (this.isStale(inst)) return;
    inst.status = "starting";
    try {
      await this.startInto(inst, getAgent(id));
      if (this.isStale(inst)) {
        await this.disposeInstance(inst);
        return;
      }
      // A-NIT2：恢复期 fault 的 pending restart 清除
      this.clearRestartTimer(inst);
      inst.status = "online";
      inst.error = null;
      inst.attempts = 0;
      this.logLine(`[${id}] 实例已恢复在线`);
    } catch (err) {
      await this.disposeInstance(inst);
      if (err instanceof InstanceCancelledError) {
        this.logLine(`[${inst.id}] ${err.message}`);
        if (this.instances.get(inst.id) === inst) inst.status = "stopping";
        return;
      }
      inst.status = "failed";
      inst.error = errorMessage(err);
      this.logLine(`[${id}] 实例恢复失败: ${inst.error}`);
      this.scheduleRestart(inst);
    }
  }

  private onInstanceFault(id: string, err: unknown, context: string): void {
    if (this.stopping) return;
    const inst = this.instances.get(id);
    if (!inst) return;
    // MATERIAL 6：per-request fault（handleRequest rejection）tunnel 已尽力回 JSON-RPC error
    // 并自行恢复；不拆整实例，否则远端可周期触发无限拆建、掉线已配对手机。
    if (context.startsWith("handleRequest")) {
      this.logLine(
        `[${id}] 忽略 per-request fault（tunnel 已恢复）：${context}: ${errorMessage(err)}`,
      );
      return;
    }
    inst.error = `${context}: ${errorMessage(err)}`;
    if (inst.status === "online") inst.status = "failed";
    this.scheduleRestart(inst);
  }

  /**
   * enrollment 事件 → lifecycle.everEnrolled 置 true。
   * 文件缺失/损坏（历史不明）时**不补写**（S04 (c) 分支②依赖此语义）。
   */
  private async onEnrollment(inst: InstanceRuntime): Promise<void> {
    const dir = instanceDirFor(this.paths.root, inst.id);
    const paths = instancePaths(dir);
    const current = await readLifecycle(paths.lifecycle);
    if (!current) {
      this.logLine(`[${inst.id}] lifecycle.json 缺失/损坏，不补写（历史不明）`);
      return;
    }
    if (current.everEnrolled) return;
    await writeLifecycle(paths.lifecycle, { ...current, everEnrolled: true });
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
      if (this.stopping && (request.op === "enable" || request.op === "disable")) {
        return { ok: false, error: "DAEMON_BUSY", message: "daemon 正在停止" };
      }
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
    if (this.stopping) return { ok: false, error: "DAEMON_BUSY", message: "daemon 正在停止" };
    const auth = await this.authManager!.getStatus();
    if (!auth.loggedIn) {
      return { ok: false, error: "NOT_LOGGED_IN", message: "未登录：请先执行 chatgpt login" };
    }
    if (this.config.agents[id]?.enabled !== true) {
      // 写盘失败会 throw → 上层 INTERNAL，内存/实例均不动
      await this.commitConfig((cfg) => withAgentEnabled(cfg, id, true));
    }
    const inst = this.instances.get(id);
    if (!inst || inst.status === "disabled") {
      await this.startInstance(id);
    } else if (inst.status === "failed") {
      this.clearRestartTimer(inst);
      await this.restartInstance(id);
    }
    return { ok: true, data: await this.agentStatus(id) };
  }

  private async doDisable(id: string | undefined): Promise<IpcResponse> {
    if (!id || !this.isKnownAgent(id)) return unknownAgent(id);
    if (this.stopping) return { ok: false, error: "DAEMON_BUSY", message: "daemon 正在停止" };
    if (this.config.agents[id]?.enabled === true) {
      await this.commitConfig((cfg) => withAgentEnabled(cfg, id, false));
    }
    const inst = this.instances.get(id);
    if (inst) {
      this.clearRestartTimer(inst);
      inst.status = "stopping";
      await this.disposeInstance(inst);
      this.instances.delete(id);
    }
    // 占位：清 pairing 状态（真正的吊销/清理在 S04）
    await rm(instancePaths(instanceDirFor(this.paths.root, id)).pairing, { force: true });
    return { ok: true, data: await this.agentStatus(id) };
  }

  /** 同 agent 的 enable/disable 经 per-agent 队列串行化，避免半状态。 */
  private withAgentLock(
    id: string | undefined,
    fn: () => Promise<IpcResponse>,
  ): Promise<IpcResponse> {
    if (!id) return Promise.resolve(unknownAgent(id));
    return this.serialize(id, fn);
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
    const everEnrolled = lifecycle ? lifecycle.everEnrolled : null;
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
