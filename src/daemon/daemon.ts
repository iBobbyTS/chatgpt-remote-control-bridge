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
 * - 配对生命周期（S04）、agent-init/agent-reset（S03）、auth-reset（S05，见 doAuthReset）：
 *   agent 模块以可选钩子 onInit/onReset 声明语义，daemon 只做通用分发（不硬编码 sim）；
 *   无钩子的模块保持 "not implemented" 占位语义。
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
import { join } from "node:path";
import type { AgentApp } from "../agents/types.ts";
import {
  getAgent,
  listAgents,
  type AgentInstanceContext,
  type AgentModule,
} from "../agents/registry.ts";
import { BridgeAuthManager } from "../auth/manager.ts";
import { WhamClient } from "../wham/client.ts";
import type { RemoteControlClient } from "../wham/protocol.ts";
import { WhamTunnel } from "../wham/tunnel.ts";
import { ensureInstanceDir, readLifecycle, readConfig, writeConfig, writeLifecycle, withAgentEnabled, type AgentConfig, type CgrcbConfig } from "./config.ts";
import {
  PairingManager,
  readEnrollmentFile,
  type PairingStatus,
} from "./pairing.ts";
import {
  cgrcbPaths,
  instanceDirFor,
  instancePaths,
  resolveCgrcbHome,
  type CgrcbPaths,
} from "./paths.ts";
import { stderrLogPath, stdoutLogPath } from "./launchd.ts";
import { truncateLogIfLarge } from "../wham/logfile.ts";
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
  /** S04：配对 claim 轮询周期（默认 2000ms；测试注入短周期）。 */
  pairingClaimPollIntervalMs?: number;
  /** S04：配对续码检查周期（默认 5000ms；测试注入短周期）。 */
  pairingRenewalCheckIntervalMs?: number;
  agentLabel?: string;
  /** 故障重启退避基数；默认 1000ms。 */
  restartBaseDelayMs?: number;
  /** 故障重启退避上限；默认 30000ms。 */
  restartMaxDelayMs?: number;
  /** 是否安装 SIGTERM/SIGINT 处理（默认 true）。 */
  installSignalHandlers?: boolean;
  /** 收到信号并在 shutdown 完成后是否 process.exit(0)（默认 false；S05 daemon 入口用）。 */
  exitOnSignal?: boolean;
  /**
   * S03 注入点：启动路径触发 agent 模块注册（registry 延迟工厂语义）。
   * daemon 绝不静态 import 具体 agent；由入口/测试传入（如 `() => import("../agents/sim/index.ts")`）。
   */
  registerAgents?: () => void | Promise<void>;
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
  /**
   * 二波2：无身份中止标记。置位后自动重启（监管者/排队重启）一律跳过启动，
   * 仅用户显式 IPC enable 可清除并放行（避免后台 fresh-enroll 铸新 environment）。
   */
  blockedNoIdentity: boolean;
}

/** status 出口：S04 在 AgentRuntimeStatus 上追加 pairing（pending 码/claim/已配对 clients）。 */
export type AgentRuntimeStatusWithPairing = AgentRuntimeStatus & { pairing: PairingStatus };

/** S04 吊销复核最大轮数（收敛上限）。 */
const REVOKE_RECHECK_ROUNDS = 3;

/** 启动/重启在 stopping 或实例代次失效时主动取消（BLOCKER 1）。 */
class InstanceCancelledError extends Error {
  constructor(reason: string) {
    super(`实例操作已取消：${reason}`);
    this.name = "InstanceCancelledError";
  }
}

const DAEMON_STOPPED_MESSAGE = "daemon 已停止，请创建新实例";

export class CgrcbDaemon {
  readonly paths: CgrcbPaths;
  private readonly opts: CgrcbDaemonOptions;
  private authManager: BridgeAuthManager | null = null;
  private config: CgrcbConfig = { version: 1, agents: {} };
  private ipcServer: IpcServer | null = null;
  private readonly instances = new Map<string, InstanceRuntime>();
  /** S04：per-instance PairingManager（enable 自动配对/续码/claim 轮询/status）。 */
  private readonly pairings = new Map<string, PairingManager>();
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
   * 本对象单次生命周期：已停止后再次 start 显式 reject（请创建新实例）。
   */
  start(): Promise<void> {
    if (this.startPromise) {
      if (this.stopRequested) {
        return Promise.reject(new Error(DAEMON_STOPPED_MESSAGE));
      }
      return this.startPromise;
    }
    this.startPromise = this.lifecycleChain.then(() => this.doStart());
    this.lifecycleChain = this.startPromise.then(
      () => undefined,
      () => undefined,
    );
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.stopRequested) {
      throw new Error(DAEMON_STOPPED_MESSAGE);
    }
    this.stopping = false;
    // S03：注册 agent 模块（入口/测试注入的延迟工厂接线；daemon 不静态 import 具体 agent）
    await this.opts.registerAgents?.();
    if (this.stopRequested) return this.abandonStart("stop requested");
    await mkdir(this.paths.root, { recursive: true });
    if (this.stopRequested) return this.abandonStart("stop requested");
    await mkdir(this.paths.instancesDir, { recursive: true });
    await mkdir(this.paths.logsDir, { recursive: true });
    // launchd 持有 stdout/stderr fd（O_APPEND），超限原地截断防无界增长（AUD-010）
    for (const logPath of [stdoutLogPath(this.paths.root), stderrLogPath(this.paths.root)]) {
      const outcome = await truncateLogIfLarge(logPath).catch(() => "absent" as const);
      if (outcome === "truncated") {
        this.logLine(`启动时日志超限已截断: ${logPath}`);
      }
    }
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
        void this.serialize(id, () => this.bootInstance(id)).catch((err) =>
          this.logLine(`[${id}] 启动失败: ${errorMessage(err)}`),
        );
      }
    }
  }

  /**
   * boot 自动启动（S03 BLOCKER1 闭合）：config enabled:true 的实例在无 IPC enable 的情况下
   * 也需跑模块 onEnable 做幂等播种，否则 boot 路径会绕过播种直接建实例（store 未初始化）。
   * onEnable 契约要求幂等，故每次 boot 调用安全；未声明钩子的模块保持原语义。
   */
  private async bootInstance(id: string): Promise<void> {
    const module = getAgent(id);
    if (module?.onEnable) {
      const ctx = this.instanceContext(id);
      await ensureInstanceDir(ctx.instanceDir); // 首建写 lifecycle.json（与 enable 一致）
      await module.onEnable(ctx);
    }
    await this.startInstance(id);
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
    // S04：释放全部 PairingManager（停定时器/退订），不再写盘
    for (const pairing of this.pairings.values()) {
      pairing.dispose();
    }
    this.pairings.clear();
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
      blockedNoIdentity: false,
    };
  }

  private async startInstance(id: string, allowBlocked = false): Promise<void> {
    if (this.stopping) return;
    const existing = this.instances.get(id);
    // 二波2：无身份中止标记态跳过自动/监督启动（防 fresh-enroll）；显式 enable 传 allowBlocked
    if (existing?.blockedNoIdentity && !allowBlocked) {
      this.logLine(`[${id}] 实例处于"无身份中止"标记态，跳过自动启动（等待用户显式 enable）`);
      return;
    }
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
      inst.blockedNoIdentity = false;
      this.logLine(`[${id}] 实例在线`);
      await this.notifyInstanceOnline(inst);
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

  /**
   * 实例上下文（S03 复用）：identity 晚绑定到当前实例隧道（未 enroll 前 null）。
   * 供 createInstance 与 enable/init/reset 钩子共用。
   */
  private instanceContext(id: string): AgentInstanceContext {
    return {
      instanceDir: instanceDirFor(this.paths.root, id),
      authManager: this.authManager!,
      filesDir: this.paths.filesDir,
      identity: () => this.instances.get(id)?.tunnel?.identity() ?? null,
      log: (line) => this.logLine(`[${id}] ${line}`),
    };
  }

  // -------------------------------------------------------------- S04 配对

  /** 取/建 per-instance PairingManager（authManager 已在 doStart 建立）。 */
  private pairingFor(id: string): PairingManager {
    let manager = this.pairings.get(id);
    if (!manager) {
      manager = new PairingManager({
        agentId: id,
        instanceDir: instanceDirFor(this.paths.root, id),
        authManager: this.authManager!,
        baseUrl: this.opts.baseUrl,
        log: (line) => this.logLine(`[${id}] ${line}`),
        isEnabled: () => this.config.agents[id]?.enabled === true,
        isOnline: () => {
          // 配对只需实例在线且 enrollment 就绪（tunnel.start 返回即具备），
          // 不要求 WSS 已 OPEN：connectWs 是 fire-and-forget，握手完成晚于 start()。
          const inst = this.instances.get(id);
          return !!inst && inst.status === "online" && !!inst.tunnel;
        },
        claimPollIntervalMs: this.opts.pairingClaimPollIntervalMs,
        renewalCheckIntervalMs: this.opts.pairingRenewalCheckIntervalMs,
      });
      this.pairings.set(id, manager);
    }
    return manager;
  }

  /**
   * 实例上线后自动配对（S04 交付物 1）。失败只记日志，绝不影响实例在线状态
   * （配对是 best-effort；调用方 await 但内部吞错）。
   */
  private async notifyInstanceOnline(inst: InstanceRuntime): Promise<void> {
    if (this.config.agents[inst.id]?.enabled !== true) return;
    const manager = this.pairings.get(inst.id);
    if (!manager) return;
    try {
      await manager.onInstanceOnline();
    } catch (err) {
      this.logLine(`[${inst.id}] 自动配对失败: ${errorMessage(err)}`);
    }
  }

  /** status / pair-status 的 pairing 数据源；refreshClients=true 时实时刷新 clients 缓存。 */
  private async pairingStatusFor(id: string, refreshClients: boolean): Promise<PairingStatus> {
    const manager = this.pairings.get(id);
    if (manager) {
      return manager.status({ refreshClients });
    }
    return {
      agentId: id,
      pending: null,
      claimed: false,
      clients: [],
      clientsRefreshedAt: null,
      environmentId: null,
      warnings: [],
    };
  }

  private knownAgentIds(): string[] {
    return [
      ...new Set<string>([
        ...Object.keys(this.config.agents),
        ...listAgents().map((m) => m.id),
        ...this.instances.keys(),
      ]),
    ];
  }

  /** 建 app（工厂）→ 建 tunnel → 订阅事件 → start。工厂同步抛错由调用方捕获。 */
  private async startInto(inst: InstanceRuntime, module: AgentModule | undefined): Promise<void> {
    // BLOCKER 5：缺模块必须 throw（走失败分支保留 failed），不得正常返回被覆盖成 online
    if (!module) {
      throw new Error(`agent 模块未注册: ${inst.id}`);
    }
    const dir = instanceDirFor(this.paths.root, inst.id);
    await ensureInstanceDir(dir); // 首次创建 → 写 lifecycle.json

    const ctx = this.instanceContext(inst.id);
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
      // 帧级日志：显式注入优先（测试/调试）；否则 config.json logFrames=true 才写实例目录
      // （AUD-002：帧日志含完整会话内容且增速快，默认关，真机排障时打开）
      jsonlPath:
        this.opts.jsonlPath ??
        (this.config.logFrames === true ? join(dir, "frames.jsonl") : undefined),
      log: (line) => this.logLine(`[${inst.id}] ${line}`),
      reconnectDelayMs: this.opts.reconnectDelayMs,
      pingIntervalMs: this.opts.pingIntervalMs,
      refreshThresholdMs: this.opts.refreshThresholdMs,
      agentLabel: this.opts.agentLabel ?? `bridge-${inst.id}`,
    });
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
    // S04：PairingManager 订阅 tunnel enrollment 事件（token 续期同步 pending）
    await this.pairingFor(inst.id).attach(tunnel);

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

  private async restartInstance(id: string, allowBlocked = false): Promise<void> {
    if (this.stopping) return;
    const inst = this.instances.get(id);
    if (!inst || this.config.agents[id]?.enabled !== true) return;
    // 二波2：无身份中止标记态跳过自动/排队重启（仅显式 enable 传 allowBlocked）
    if (inst.blockedNoIdentity && !allowBlocked) {
      this.logLine(`[${id}] 实例处于"无身份中止"标记态，跳过自动重启（等待用户显式 enable）`);
      return;
    }
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
      inst.blockedNoIdentity = false;
      this.logLine(`[${id}] 实例已恢复在线`);
      await this.notifyInstanceOnline(inst);
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

  /** 实例目录首次创建时写 lifecycle.json；已存在目录不补写（helper 见 config.ts）。 */

  // ---------------------------------------------------- S04 disable 吊销/恢复

  /** cursor 穷尽列出 environment 下全部已配对客户端（账号鉴权，limit=100）。 */
  private async listAllClients(
    client: WhamClient,
    environmentId: string,
  ): Promise<RemoteControlClient[]> {
    const all: RemoteControlClient[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await client.listClients({
        environmentId,
        limit: 100,
        order: "desc",
        ...(cursor ? { cursor } : {}),
      });
      all.push(...page.items);
      const next = page.cursor ?? undefined;
      if (!next) break;
      if (seenCursors.has(next)) break; // 防游标循环
      seenCursors.add(next);
      cursor = next;
    }
    return all;
  }

  /**
   * disable 第 (d)+(e) 步：初始穷尽吊销 + 停隧道后复核轮（每轮重新 listClients，
   * 吊销期间被 claim 的 client 继续吊销），收敛上限 REVOKE_RECHECK_ROUNDS 轮。
   * 返回 false = 3 轮复核后仍不收敛（调用方中止 disable）。
   * 收敛后再做一次残余窗口扫描：仍有 client → WARN（后端无 pending 失效 API，不阻塞）。
   */
  private async revokeEnvironmentClients(
    client: WhamClient,
    id: string,
    environmentId: string,
  ): Promise<boolean> {
    const initial = await this.listAllClients(client, environmentId);
    for (const item of initial) {
      await client.revokeClient({ environmentId, clientId: item.client_id });
    }
    this.logLine(`[${id}] 已吊销 ${initial.length} 个客户端（初始穷尽）`);

    let rechecks = 0;
    for (;;) {
      const remaining = await this.listAllClients(client, environmentId);
      if (remaining.length === 0) {
        const residual = await this.listAllClients(client, environmentId).catch(() => []);
        if (residual.length > 0) {
          this.logLine(
            `[${id}] WARN 残余窗口：吊销收敛后仍有 ${residual.length} 个客户端被 claim` +
              `（后端无 pending 码失效 API，留待下次 enable→disable 周期清理）`,
          );
        }
        return true;
      }
      if (rechecks >= REVOKE_RECHECK_ROUNDS) return false;
      rechecks += 1;
      this.logLine(
        `[${id}] 吊销复核第 ${rechecks}/${REVOKE_RECHECK_ROUNDS} 轮：仍有 ${remaining.length} 个客户端`,
      );
      for (const item of remaining) {
        await client.revokeClient({ environmentId, clientId: item.client_id });
      }
    }
  }

  /**
   * disable 中止后恢复实例。
   * - `restart=true`（有可用身份记录：内存快照或磁盘 enrollment.json）→ resume 配对并重建隧道，
   *   由 S02 监管者接管恢复在线；
   * - `restart=false`（无身份记录 = 历史不明/记录丢失）→ 保持停止态，**绝不 fresh-enroll**
   *   （B-1：否则可能铸新 environment，下次 disable 只吊销新环境、旧 client 遗留），
   *   清退避重启定时器避免后台补跑。
   */
  private async restoreAfterAbort(id: string, restart: boolean): Promise<void> {
    const pairing = this.pairings.get(id);
    const inst = this.instances.get(id);
    if (!inst || this.stopping) {
      pairing?.resume();
      return;
    }
    this.clearRestartTimer(inst);
    if (!restart) {
      inst.tunnel = null;
      inst.app = null;
      inst.status = "failed";
      inst.blockedNoIdentity = true;
      inst.error = "disable 已中止：缺少可用身份记录，实例保持停止（避免 fresh-enroll）";
      return;
    }
    pairing?.resume();
    inst.tunnel = null;
    inst.app = null;
    inst.status = "failed";
    inst.error = null;
    try {
      await this.startInstance(id);
    } catch (err) {
      this.logLine(`[${id}] disable 中止后恢复实例失败: ${errorMessage(err)}`);
    }
  }

  /**
   * disable 成功收尾（第 (e) 步收敛后）：enabled=false、停实例、清 pairing.json、
   * 释放 PairingManager。
   * - B-4：吊销已收敛、仅 config 写盘失败 → 恢复实例在线（config 语义仍 enabled=true）并报错供重试。
   * - B-3：清盘前先 suspend 排空在途写，避免在途 rename 在 rm 之后落盘复活。
   */
  private async finalizeDisable(
    id: string,
    inst: InstanceRuntime | undefined,
    wasEnabled: boolean,
    hasIdentity: boolean,
  ): Promise<void> {
    if (wasEnabled) {
      try {
        await this.commitConfig((cfg) => withAgentEnabled(cfg, id, false));
      } catch (err) {
        await this.restoreAfterAbort(id, hasIdentity);
        throw new Error(
          `[${id}] 禁用配置写盘失败，已恢复实例（保持 enabled），可重试：${errorMessage(err)}`,
        );
      }
    }
    const pairing = this.pairings.get(id);
    if (pairing) {
      await pairing.suspend(); // B-3：排空在途写后再清盘
      pairing.dispose();
      this.pairings.delete(id);
    }
    if (inst) {
      this.clearRestartTimer(inst);
      inst.status = "stopping";
      await this.disposeInstance(inst);
      if (this.instances.get(id) === inst) this.instances.delete(id);
    }
    await rm(instancePaths(instanceDirFor(this.paths.root, id)).pairing, { force: true });
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
        case "pair":
          return await this.withAgentLock(request.agent, () => this.doPair(request.agent));
        case "pair-status":
          return await this.doPairStatus(request.agent);
        case "agent-init":
          return await this.withAgentLock(request.agent, () =>
            this.doAgentInitReset(request.agent, "init"),
          );
        case "agent-reset":
          return await this.withAgentLock(request.agent, () =>
            this.doAgentInitReset(request.agent, "reset"),
          );
        case "auth-reset":
          return await this.doAuthReset();
        default:
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
    // S03（BLOCKER1 修复，语义 = 方案②）：**先建实例目录 + 跑 onEnable 幂等播种，成功后才
    // commitConfig(enabled:true) → startInstance**。若播种抛错，本次 enable 直接失败且 config
    // 保持原状（不会留下"config 已 enabled 但 store 未播种"），重启后既不会被误报为已启用成功，
    // 也不会出现"enable 报失败却已 enabled"的矛盾状态。boot 自动启动路径另行补跑 onEnable
    // （见 bootInstance），两者结合保证任何上线实例的 store 均已播种。
    // 未声明钩子的模块跳过（通用，不硬编码 sim）。
    const module = getAgent(id)!;
    const ctx = this.instanceContext(id);
    await ensureInstanceDir(ctx.instanceDir);
    await module.onEnable?.(ctx);
    // 二波2：用户显式 enable 允许清除"无身份中止"标记并重新 enroll（合规、可能铸新身份），
    // 记 identityWarnings WARN 供 status 可见。
    const blocked = this.instances.get(id)?.blockedNoIdentity === true;
    if (blocked) {
      const inst = this.instances.get(id)!;
      inst.blockedNoIdentity = false;
      const warn =
        "用户显式 enable：清除\"无身份中止\"标记并重新 enroll（可能铸新 environment）";
      inst.identityWarnings.push(warn);
      this.logLine(`[${id}] WARN ${warn}`);
    }
    if (this.config.agents[id]?.enabled !== true) {
      // 写盘失败会 throw → 上层 INTERNAL，内存/实例均不动
      await this.commitConfig((cfg) => withAgentEnabled(cfg, id, true));
    }
    const inst = this.instances.get(id);
    if (!inst || inst.status === "disabled") {
      await this.startInstance(id, true);
    } else if (inst.status === "failed") {
      this.clearRestartTimer(inst);
      await this.restartInstance(id, true);
    }
    return { ok: true, data: await this.agentStatus(id) };
  }

  /**
   * S04 disable 五步（顺序强制，封闭并发 claim 窗口）：
   * (a) 停该实例续码/claim 定时器、停发新码；(b) 停 WSS 隧道（此后新 claim 得不到服务）；
   * (c) 定位 environment_id：内存 enrollment → 磁盘 enrollment.json（不看 token 过期）→
   *     皆无时按 lifecycle.json 判定（everEnrolled=false → 无可吊销对象直接完成；
   *     缺失=历史不明 / everEnrolled=true 但记录丢 → 报错中止，不得 fresh-enroll 兜底）；
   * (d) listClients cursor 穷尽逐个 revokeClient（账号鉴权）；(e) 停隧道后复核轮（上限 3 轮）
   *     → 收敛后 enabled=false、清 pairing.json。任一轮失败/不收敛 → 报错中止（保持 enabled，
   *     实例由监管者重新拉起隧道恢复在线服务）。
   *
   * 从未启用且无实例：幂等快路径（清 pairing.json 直接返回，不做吊销判定）。
   */
  private async doDisable(id: string | undefined): Promise<IpcResponse> {
    if (!id || !this.isKnownAgent(id)) return unknownAgent(id);
    if (this.stopping) return { ok: false, error: "DAEMON_BUSY", message: "daemon 正在停止" };
    const wasEnabled = this.config.agents[id]?.enabled === true;
    const inst = this.instances.get(id);
    const dir = instanceDirFor(this.paths.root, id);
    const paths = instancePaths(dir);

    // 幂等快路径：从未启用且无实例 → 无可吊销对象
    if (!wasEnabled && !inst) {
      await rm(paths.pairing, { force: true });
      return { ok: true, data: await this.agentStatus(id) };
    }

    // (a) 停发新码 / 作废在途配对操作（B-3：排空在途写后才继续）
    const pairing = this.pairings.get(id);
    if (pairing) {
      await pairing.suspend();
    }

    // 内存 enrollment 快照（停隧道前捕获；tunnel.stop 不清空 enrollment）
    const memoryEnrollment = inst?.tunnel?.enrollmentSnapshot ?? null;
    // 磁盘 enrollment.json（吊销只需 environment_id+账号鉴权，不看 token 过期）
    const diskEnrollment = await readEnrollmentFile(dir);
    const hasIdentity = !!(
      memoryEnrollment?.environment_id || diskEnrollment?.environment_id
    );

    // (b) 停 WSS 隧道；无法确认停妥（stop 抛错，如 app.close 抛错 → WS 可能仍在线）→
    // 中止 disable，避免在服务仍在线时误报"吊销成功"（B-2）。
    if (inst?.tunnel) {
      let stopError: unknown = null;
      try {
        await inst.tunnel.stop();
      } catch (err) {
        stopError = err;
        this.logLine(`[${id}] 停隧道失败: ${errorMessage(err)}`);
      }
      inst.status = "stopping";
      if (stopError) {
        await this.restoreAfterAbort(id, hasIdentity);
        throw new Error(
          `[${id}] 无法确认隧道已停妥，已中止 disable（保持 enabled）：${errorMessage(stopError)}`,
        );
      }
    }

    // (c) 定位 environment_id
    const environmentId = memoryEnrollment?.environment_id ?? diskEnrollment?.environment_id ?? null;

    if (!environmentId) {
      const lifecycle = await readLifecycle(paths.lifecycle);
      if (lifecycle && lifecycle.everEnrolled === false) {
        // 该实例从未成功 enroll（跨 daemon 重启成立）→ 无可吊销对象
        await this.finalizeDisable(id, inst, wasEnabled, false);
        return { ok: true, data: await this.agentStatus(id) };
      }
      // B-1：无可用身份记录 → 保持停止态，绝不 fresh-enroll 兜底
      await this.restoreAfterAbort(id, false);
      const reason =
        lifecycle === null
          ? "lifecycle.json 缺失/损坏（历史不明）"
          : `everEnrolled=${lifecycle.everEnrolled} 但 enrollment.json 丢失`;
      throw new Error(
        `[${id}] 无法定位 environment_id（${reason}），已中止 disable（保持 enabled，实例保持停止）。` +
          `恢复路径：先登录使 enroll 成功后再 disable，或恢复 enrollment.json 后重试。`,
      );
    }

    // (d)+(e) 账号鉴权吊销 + 复核轮
    if (!this.authManager) {
      await this.restoreAfterAbort(id, hasIdentity);
      throw new Error(`[${id}] daemon 未就绪，已中止 disable（保持 enabled）`);
    }
    const client = new WhamClient({
      authManager: this.authManager,
      baseUrl: this.opts.baseUrl,
      installationDir: dir,
    });
    let converged: boolean;
    try {
      converged = await this.revokeEnvironmentClients(client, id, environmentId);
    } catch (err) {
      await this.restoreAfterAbort(id, hasIdentity);
      throw new Error(
        `[${id}] 吊销失败，已中止 disable（保持 enabled）：${errorMessage(err)}`,
      );
    }
    if (!converged) {
      await this.restoreAfterAbort(id, hasIdentity);
      throw new Error(
        `[${id}] 吊销未收敛（environment=${environmentId} 仍有已配对客户端），` +
          `已中止 disable（保持 enabled，可重试）`,
      );
    }

    await this.finalizeDisable(id, inst, wasEnabled, hasIdentity);
    return { ok: true, data: await this.agentStatus(id) };
  }

  /** IPC pair：enabled 实例追加配对码（覆盖旧 pending；多设备并存无上限）。 */
  private async doPair(id: string | undefined): Promise<IpcResponse> {
    if (!id || !this.isKnownAgent(id)) return unknownAgent(id);
    if (this.stopping) return { ok: false, error: "DAEMON_BUSY", message: "daemon 正在停止" };
    if (this.config.agents[id]?.enabled !== true) {
      return { ok: false, error: "INTERNAL", message: `agent 未启用：请先 enable ${id}` };
    }
    if (!this.authManager) {
      return { ok: false, error: "INTERNAL", message: "daemon 未就绪" };
    }
    const pending = await this.pairingFor(id).requestNewCode();
    if (!pending) {
      return {
        ok: false,
        error: "INTERNAL",
        message: `无法生成配对码：实例 ${id} 尚未 enroll 或正在停止`,
      };
    }
    return { ok: true, data: { agent: id, pending } };
  }

  /** IPC pair-status：各实例 pending 码/到期/claim 状态 + 已配对 clients（实时刷新）。 */
  private async doPairStatus(id: string | undefined): Promise<IpcResponse> {
    if (id !== undefined && !this.isKnownAgent(id)) return unknownAgent(id);
    const ids = id !== undefined ? [id] : this.knownAgentIds();
    const agents: Record<string, PairingStatus> = {};
    for (const agentId of ids) {
      agents[agentId] = await this.pairingStatusFor(agentId, true);
    }
    return { ok: true, data: { agents } };
  }

  /**
   * IPC agent-init / agent-reset（S03）：通用分发到 agent 模块可选钩子。
   * - 活实例：app 一并传入（如 sim reset 清理运行态定时器并内存播种）；
   * - 未运行实例：app=null，模块走纯文件路径（调纯函数）；
   * - 未声明钩子的模块保持 S02 占位语义（INTERNAL "not implemented"）。
   */
  private async doAgentInitReset(
    id: string | undefined,
    mode: "init" | "reset",
  ): Promise<IpcResponse> {
    if (!id || !this.isKnownAgent(id)) return unknownAgent(id);
    if (this.stopping) {
      return { ok: false, error: "DAEMON_BUSY", message: "daemon 正在停止" };
    }
    const module = getAgent(id);
    const hasHook = mode === "init" ? module?.onInit : module?.onReset;
    if (!module || !hasHook) {
      return { ok: false, error: "INTERNAL", message: "not implemented" };
    }
    const ctx = this.instanceContext(id);
    await ensureInstanceDir(ctx.instanceDir); // 首建写 lifecycle.json（与 enable 一致）
    const app = this.instances.get(id)?.app ?? null;
    if (mode === "init") {
      await module.onInit!(ctx, app);
    } else {
      await module.onReset!(ctx, app);
    }
    return { ok: true, data: await this.agentStatus(id) };
  }

  /**
   * IPC auth-reset（S05 ④）：chatgpt reset/logout 的在线路径。
   * 停 autoRefresh → 等待在途刷新收敛（refreshInFlight flush）→ 持锁删除凭证
   * （store.deleteAuthStoreLocked；刷新提交段的重读校验保证在途刷新不复活凭证）。
   * 删除后若 daemon 仍在运行则恢复巡检；下游实例/身份/配对一律不动。
   */
  private async doAuthReset(): Promise<IpcResponse> {
    const auth = this.authManager;
    if (!auth) {
      return { ok: false, error: "INTERNAL", message: "daemon 未就绪" };
    }
    auth.stopAutoRefresh();
    // B-4：无论 flush/logout 是否抛错，只要 daemon 仍在运行就恢复巡检（finally）
    try {
      await auth.waitForInflightRefresh();
      const removed = await auth.logout();
      this.logLine(`auth-reset：凭证${removed ? "已删除" : "本就未登录"}（下游实例不受影响）`);
      return { ok: true, data: { removed, auth: await auth.getStatus() } };
    } finally {
      if (this.running && !this.stopping) {
        auth.startAutoRefresh();
      }
    }
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
    const agents: Record<string, AgentRuntimeStatusWithPairing> = {};
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

  async agentStatus(id: string): Promise<AgentRuntimeStatusWithPairing> {
    const cfg = this.config.agents[id];
    const inst = this.instances.get(id);
    const registered = !!getAgent(id);
    const dir = instanceDirFor(this.paths.root, id);
    const lifecycle = await readLifecycle(instancePaths(dir).lifecycle);
    const everEnrolled = lifecycle ? lifecycle.everEnrolled : null;
    // S04：pairing（不实时刷新 clients，避免 status 反复网请求；pair-status 走实时）
    const pairing = await this.pairingStatusFor(id, false);
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
        pairing,
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
      identityWarnings: [...(tunnel?.identityWarnings ?? []), ...inst.identityWarnings],
      warnings: tunnel?.warnings ?? [],
      error: inst.error,
      pairing,
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
