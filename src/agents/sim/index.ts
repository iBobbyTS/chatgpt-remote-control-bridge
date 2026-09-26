/**
 * sim agent 模块入口（S03）：**自注册**到统一注册表（registry 延迟工厂）。
 *
 * 由 daemon 入口/测试经注入点（`CgrcbDaemonOptions.registerAgents`）import 本模块触发注册；
 * daemon 本身不静态 import 具体 agent（S02 约束）。
 *
 * - createInstance：statePath = 实例目录 state.json；getServerInfo 晚绑定 ctx.identity()（隧道身份）。
 * - onEnable/onInit：store 未初始化时播种 fixedThreads（幂等）。
 * - onReset：活实例走 SimApp.resetToSeed（清全部定时器含队列续跑计时器 + 内存播种 + 落盘）；
 *   未运行实例走纯函数 simReset（只动 state.json）。
 */
import { join } from "node:path";
import {
  registerAgent,
  type AgentInstanceContext,
  type AgentModule,
} from "../registry.ts";
import type { AgentApp } from "../types.ts";
import { SimApp } from "./appServer.ts";
import { SIM_STATE_FILENAME, simInit, simReset } from "./store.ts";

export { SimApp } from "./appServer.ts";
export { simInit, simReset, simStatePath, simStoreInitialized } from "./store.ts";

export const simAgentModule: AgentModule = {
  id: "sim",
  createInstance(ctx: AgentInstanceContext): AgentApp {
    return new SimApp({
      codexHome: ctx.authManager.codexHome,
      statePath: join(ctx.instanceDir, SIM_STATE_FILENAME),
      getServerInfo: () => ctx.identity(),
      log: ctx.log,
    });
  },
  /** enable 未初始化自动播种（幂等）。 */
  async onEnable(ctx: AgentInstanceContext): Promise<void> {
    await simInit(ctx.instanceDir);
  },
  async onInit(ctx: AgentInstanceContext): Promise<void> {
    await simInit(ctx.instanceDir);
  },
  async onReset(ctx: AgentInstanceContext, app: AgentApp | null): Promise<void> {
    if (app) {
      await (app as SimApp).resetToSeed();
      return;
    }
    await simReset(ctx.instanceDir);
  },
};

registerAgent(simAgentModule);
