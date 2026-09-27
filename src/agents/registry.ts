/**
 * 下游 Agent 注册表（S02）。
 *
 * 设计要点（对齐 PLAN S02 ①）：
 * - **延迟工厂**：本模块不静态 import 任何具体 agent 实现（sim/zcode 等），
 *   只暴露 `registerAgent` / `getAgent` / `listAgents`。具体 agent 模块由各自 owner
 *   节调用 `registerAgent` 自注册（sim 接线在 S03；本节测试经 registerAgent 注册 stub）。
 * - `AgentModule.createInstance(ctx)` 由 daemon 在实例启动时调用，因此实例创建是
 *   延迟的（注册 ≠ 实例化），并携带每实例上下文。
 * - `AgentInstanceContext.identity` 为**晚绑定**：daemon 先建 app、再建 tunnel，
 *   回调内部读 tunnel 身份快照，未 enroll 前返回 null（与 SimWhamServer 旧语义一致）。
 */
import type { BridgeAuthManager } from "../auth/manager.ts";
import type { AgentApp } from "./types.ts";

/** 实例身份快照（结构类型，避免 registry 反向依赖 src/wham）。 */
export interface AgentIdentity {
  serverName: string;
  installationId: string;
  environmentId: string;
}

/** 每实例创建上下文（daemon 注入）。 */
export interface AgentInstanceContext {
  /** 实例目录（installation_id / state.json / enrollment.json / pairing.json / lifecycle.json）。 */
  instanceDir: string;
  /** 共享登录态管理器（指向 <CGRCB_HOME>/home）。 */
  authManager: BridgeAuthManager;
  /** 附件上传落盘根目录（<CGRCB_HOME>/files）。 */
  filesDir: string;
  /** 实例身份（晚绑定到隧道；未 enroll 前 null）。 */
  identity: () => AgentIdentity | null;
  /** 实例日志（daemon 加实例前缀后输出）。 */
  log: (line: string) => void;
}

/** agent 模块契约：id + 实例工厂 + 可选生命周期钩子。 */
export interface AgentModule {
  readonly id: string;
  createInstance(ctx: AgentInstanceContext): AgentApp;
  /**
   * enable 钩子（S03）：daemon 写 config 后、启动实例前调用，用于幂等的自动初始化
   * （如 sim 的 store 播种）。实现必须幂等，重复 enable 不得破坏已有数据。
   */
  onEnable?(ctx: AgentInstanceContext): Promise<void> | void;
  /** IPC agent-init（S03）：app 为活实例实例（未运行时为 null），做幂等文件/运行态初始化。 */
  onInit?(ctx: AgentInstanceContext, app: AgentApp | null): Promise<void> | void;
  /** IPC agent-reset（S03）：清运行态并重置为播种态（app 未运行时为 null，走纯文件路径）。 */
  onReset?(ctx: AgentInstanceContext, app: AgentApp | null): Promise<void> | void;
}

const modules = new Map<string, AgentModule>();

/** 注册一个 agent 模块；重复 id 视为编程错误。 */
export function registerAgent(module: AgentModule): void {
  const id = module?.id?.trim();
  if (!id) {
    throw new Error("registerAgent: module.id 不能为空");
  }
  if (modules.has(id)) {
    throw new Error(`registerAgent: agent 已注册: ${id}`);
  }
  modules.set(id, module);
}

/** 按 id 取模块（未注册返回 undefined）。 */
export function getAgent(id: string): AgentModule | undefined {
  return modules.get(id);
}

/** 已注册模块清单（status/配置校验用）。 */
export function listAgents(): AgentModule[] {
  return [...modules.values()];
}

/** 测试辅助：清空注册表（生产路径不使用）。 */
export function resetAgents(): void {
  modules.clear();
}
