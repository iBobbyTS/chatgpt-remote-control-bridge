/**
 * cgrcb 数据布局（PLAN S02 边界 4 定稿）。
 *
 * `<root>` 默认 `~/.cgrcb`，可由环境变量 `CGRCB_HOME` 覆盖（测试用）：
 *
 *   <root>/config.json         守护进程配置（{version, agents}）
 *   <root>/home/               共享 codex-home 形状目录（auth.json；BridgeAuthManager 指向它）
 *   <root>/instances/<agent>/  每实例目录：
 *       installation_id        上游身份（enroll body/refresh/REST/WSS 握手同源）
 *       state.json             agent 自有状态（sim 会话库，S03）
 *       enrollment.json        隧道唯一生产者写入（server_id/environment_id/token/expiry）
 *       pairing.json           配对 pending（S04）
 *       lifecycle.json         {everEnrolled} 实例目录首次创建时由 daemon 写入
 *   <root>/daemon.sock         本地 IPC unix socket
 *   <root>/logs/               日志目录
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
// 单一事实来源：与隧道持久化文件名保持一致（避免两处字符串漂移）。
import { ENROLLMENT_FILENAME } from "../wham/tunnel.ts";

export { ENROLLMENT_FILENAME };

export const DEFAULT_HOME_DIRNAME = ".cgrcb";
export const CONFIG_FILENAME = "config.json";
export const CODEX_HOME_DIRNAME = "home";
export const INSTANCES_DIRNAME = "instances";
export const SOCKET_FILENAME = "daemon.sock";
export const LOGS_DIRNAME = "logs";

export const INSTALLATION_ID_FILENAME = "installation_id";
export const STATE_FILENAME = "state.json";
export const PAIRING_FILENAME = "pairing.json";
export const LIFECYCLE_FILENAME = "lifecycle.json";

/** 解析数据根目录（CGRCB_HOME 优先，否则 ~/.cgrcb）。 */
export function resolveCgrcbHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CGRCB_HOME?.trim();
  return override ? resolve(override) : join(homedir(), DEFAULT_HOME_DIRNAME);
}

export interface CgrcbPaths {
  /** 数据根目录。 */
  root: string;
  configPath: string;
  /** 共享 codex-home（BridgeAuthManager.codexHome）。 */
  codexHome: string;
  instancesDir: string;
  socketPath: string;
  logsDir: string;
}

export function cgrcbPaths(root: string): CgrcbPaths {
  return {
    root,
    configPath: join(root, CONFIG_FILENAME),
    codexHome: join(root, CODEX_HOME_DIRNAME),
    instancesDir: join(root, INSTANCES_DIRNAME),
    socketPath: join(root, SOCKET_FILENAME),
    logsDir: join(root, LOGS_DIRNAME),
  };
}

export interface InstancePaths {
  dir: string;
  installationId: string;
  state: string;
  enrollment: string;
  pairing: string;
  lifecycle: string;
}

export function instancePaths(dir: string): InstancePaths {
  return {
    dir,
    installationId: join(dir, INSTALLATION_ID_FILENAME),
    state: join(dir, STATE_FILENAME),
    enrollment: join(dir, ENROLLMENT_FILENAME),
    pairing: join(dir, PAIRING_FILENAME),
    lifecycle: join(dir, LIFECYCLE_FILENAME),
  };
}

/** 实例目录路径。 */
export function instanceDirFor(root: string, agentId: string): string {
  return join(root, INSTANCES_DIRNAME, agentId);
}
