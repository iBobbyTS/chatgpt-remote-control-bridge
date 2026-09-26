/**
 * config.json 读写（PLAN S02 ②）与实例生命周期标记（S02 ③）。
 *
 * - **原子写**：写临时文件（同目录）+ rename，避免读方看到半写文件。
 * - **缺省生成**：文件不存在时生成 `{version:1, agents:{}}` 并落盘。
 * - **坏 JSON 明确报错**：抛带路径的 Error（不静默吞成缺省）。
 * - **宽松向前兼容**：多余字段（顶层/agent 级）原样保留，不报错；非法 agent 条目忽略。
 * - **未知 agent 首次 enable 时补条目**：`withAgentEnabled` 负责补齐。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { instancePaths } from "./paths.ts";

export const CONFIG_VERSION = 1;

/**
 * 唯一临时路径（BLOCKER 2）：pid + 单调计数 + 随机后缀，避免同毫秒同进程
 * 两次写共用同一 tmp 名互相覆盖。
 */
let tempCounter = 0;
function tempPath(target: string): string {
  tempCounter += 1;
  return `${target}.tmp-${process.pid}-${tempCounter}-${randomBytes(4).toString("hex")}`;
}

export interface AgentConfig {
  enabled: boolean;
  name?: string;
  /** 宽松向前兼容：未知字段原样保留。 */
  [key: string]: unknown;
}

export interface CgrcbConfig {
  version: number;
  agents: Record<string, AgentConfig>;
  /** 宽松向前兼容：未知顶层字段原样保留。 */
  [key: string]: unknown;
}

export function defaultConfig(): CgrcbConfig {
  return { version: CONFIG_VERSION, agents: {} };
}

/** 校验 + 归一化（保留未知字段；非法 agent 条目忽略）。 */
export function normalizeConfig(raw: unknown): CgrcbConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config 必须是 JSON 对象");
  }
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : CONFIG_VERSION;
  const agents: Record<string, AgentConfig> = {};
  if (obj.agents !== undefined) {
    if (obj.agents === null || typeof obj.agents !== "object" || Array.isArray(obj.agents)) {
      throw new Error("config.agents 必须是 JSON 对象");
    }
    for (const [id, value] of Object.entries(obj.agents as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        continue; // 宽松：坏条目忽略，不影响其余配置
      }
      const entry = value as Record<string, unknown>;
      agents[id] = { ...entry, enabled: entry.enabled === true };
    }
  }
  return { ...obj, version, agents };
}

/** 读配置；文件缺失则生成缺省并落盘。坏 JSON 抛明确错误。 */
export async function readConfig(configPath: string): Promise<CgrcbConfig> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const config = defaultConfig();
      await writeConfig(configPath, config);
      return config;
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `config JSON 解析失败（${configPath}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return normalizeConfig(parsed);
}

/** 原子写配置（tmp + rename，mode 600）。 */
export async function writeConfig(configPath: string, config: CgrcbConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = tempPath(configPath);
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, configPath);
}

/** 设置某 agent 的 enabled（未知 agent 首次即补条目，保留其已有字段）。 */
export function withAgentEnabled(
  config: CgrcbConfig,
  agentId: string,
  enabled: boolean,
): CgrcbConfig {
  const existing = config.agents[agentId] ?? { enabled: false };
  return {
    ...config,
    agents: { ...config.agents, [agentId]: { ...existing, enabled } },
  };
}

// ------------------------------------------------------------------ lifecycle

/**
 * 实例生命周期标记（S02 ③）：
 * - 实例目录**首次创建时**（daemon 亲历 mkdir）写 `{everEnrolled:false}`；
 * - 首个 enrollment 事件置 true；此后不重置、不删除；
 * - enable 时**不补写**——已有目录缺失该文件 = 历史不明（S04 (c) 分支②）。
 */
export interface LifecycleState {
  everEnrolled: boolean;
  [key: string]: unknown;
}

/** 读 lifecycle.json；缺失/损坏/**everEnrolled 非显式布尔**返回 null（= 历史不明，绝不臆造 false）。 */
export async function readLifecycle(lifecyclePath: string): Promise<LifecycleState | null> {
  let text: string;
  try {
    text = await readFile(lifecyclePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    // BLOCKER 3：只接受显式布尔。`{}` / `"yes"` / `1` / null 等一律历史不明，
    // 否则会把"从未成功 enroll"错判给 S04（据此跳过吊销）。
    if (typeof obj.everEnrolled !== "boolean") {
      return null;
    }
    return { ...obj, everEnrolled: obj.everEnrolled };
  } catch {
    return null;
  }
}

/** 原子写 lifecycle.json（tmp + rename）。 */
export async function writeLifecycle(
  lifecyclePath: string,
  state: LifecycleState,
): Promise<void> {
  await mkdir(dirname(lifecyclePath), { recursive: true });
  const tmp = tempPath(lifecyclePath);
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, lifecyclePath);
}

/**
 * 实例目录首次创建时写 lifecycle.json（`{everEnrolled:false}`）；已存在目录不补写。
 * daemon 启动路径与 CLI 离线 init/reset 共用同一语义（NIT ②，勿复制逻辑）。
 * 返回是否本次创建了目录。
 */
export async function ensureInstanceDir(instanceDir: string): Promise<boolean> {
  await mkdir(dirname(instanceDir), { recursive: true }); // 离线 CLI 无父目录（daemon 已建）
  try {
    await mkdir(instanceDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  await writeLifecycle(instancePaths(instanceDir).lifecycle, { everEnrolled: false });
  return true;
}
