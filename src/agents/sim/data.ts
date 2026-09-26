/**
 * 模拟层固定数据：全部蓝本取自 2026-09-25 真实手机端抓包
 * （.agent-work/tmp/sim-layer/catalog*.json，docs/research/06）。
 * 形状对齐 codex app-server；值替换为桥的模拟数据。
 */
import { homedir } from "node:os";
import { simMsgId, uuidv7 } from "./ids.ts";
import blueprintConfigRead from "./blueprint-config-read.json" with { type: "json" };

// ------------------------------------------------------------------ 类型

export interface TextContent {
  type: "text";
  text: string;
  text_elements: unknown[];
}

export interface UserMessageItem {
  type: "userMessage";
  id: string;
  clientId: string | null;
  content: TextContent[];
}

export interface AgentMessageItem {
  type: "agentMessage";
  id: string;
  text: string;
  phase: "final_answer";
  memoryCitation: null;
  delivery: null;
  questions: null;
}

export interface CommandExecutionAction {
  type: "unknown";
  command: string;
}

export interface CommandExecutionItem {
  type: "commandExecution";
  id: string;
  pluginId: null;
  scriptPath: null;
  command: string;
  cwd: string;
  processId: string;
  source: string;
  status: "inProgress" | "completed" | "failed";
  commandActions: CommandExecutionAction[];
  aggregatedOutput: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

/**
 * contextCompaction 条目：compact 期间下发的上下文压缩项。
 * 蓝本 v2/item.rs:425-427（{"type":"contextCompaction","id": uuidv7}）。
 */
export interface ContextCompactionItem {
  type: "contextCompaction";
  id: string;
}

export type SimItem =
  | UserMessageItem
  | AgentMessageItem
  | CommandExecutionItem
  | ContextCompactionItem;

/**
 * 协作模式：wire 字段名 **snake_case**（config_types.rs:708-783；:780 的 Settings
 * 无 camelCase 重命名）。settings.developer_instructions 为 null = 使用所选模式的
 * 内置指令（config_types.rs 注释）。
 */
export interface CollaborationModeSettings {
  model: string;
  reasoning_effort: string | null;
  developer_instructions: string | null;
}

export interface CollaborationMode {
  mode: "plan" | "default";
  settings: CollaborationModeSettings;
}

/** 线程 Git 元数据（v2/thread_data.rs:171-176，字段 camelCase 由 serde 统一转换）。 */
export interface ThreadGitInfo {
  sha: string | null;
  branch: string | null;
  originUrl: string | null;
}

export type SimGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

/**
 * 线程目标（v2/thread.rs:800-840）：ThreadGoalStatus 枚举 + ThreadGoal。
 * tokenBudget number|null；tokensUsed/timeUsedSeconds/createdAt/updatedAt 为
 * Unix 秒（v2/thread.rs:813-840）。
 */
export interface SimGoal {
  threadId: string;
  objective: string;
  status: SimGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface TurnRecord {
  id: string;
  items: SimItem[];
  itemsView: "notLoaded" | "summary";
  status: "inProgress" | "completed" | "failed" | "interrupted";
  error: unknown;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface ThreadRecord {
  id: string;
  environments: Array<{ environmentId: string; cwd: string; runtimeWorkspaceRoots: string[] }>;
  extra: null;
  sessionId: string;
  forkedFromId: string | null;
  parentThreadId: null;
  preview: string;
  ephemeral: boolean;
  section: null;
  sectionEnteredAt: null;
  projectId: string | null;
  historyMode: "paginated";
  modelProvider: "openai";
  model: string;
  reasoningEffort: string;
  /** 生效协作模式（thread/settings/update 或 turn/start 写入；resume 返回实值）。 */
  collaborationMode: CollaborationMode;
  createdAt: number;
  updatedAt: number;
  recencyAt: number;
  status: { type: "idle" | "active" | "systemError"; activeFlags?: [] };
  path: null;
  cwd: string;
  cliVersion: string;
  originator: string;
  source: "vscode";
  canAcceptDirectInput: boolean;
  threadSource: string;
  agentNickname: null;
  agentRole: null;
  gitInfo: ThreadGitInfo | null;
  name: null;
  daybreakEnabled: boolean | null;
  turns: TurnRecord[];
}

export interface ItemEntry {
  turnId: string;
  item: SimItem;
  startedAtMs: number;
  completedAtMs: number;
}

export const CLI_VERSION = "0.157.0";
export const DEFAULT_MODEL = "gpt-6-luna";
export const MODEL_CONTEXT_WINDOW = 258_400;

/** 默认协作模式（mode default，settings.model 取线程模型，reasoning_effort medium）。 */
export function defaultCollaborationMode(model: string): CollaborationMode {
  return {
    mode: "default",
    settings: { model, reasoning_effort: "medium", developer_instructions: null },
  };
}

// ------------------------------------------------------------- 固定目录数据

/** model/list（真实样本的 4 个模型，去掉 upgrade 类字段噪音）。 */
export const MODELS = [
  {
    id: "gpt-6-luna",
    model: "gpt-6-luna",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "GPT-6-Luna",
    description: "Fast and affordable model for easier tasks.",
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((e) => ({
      reasoningEffort: e,
      description: "Simulated reasoning effort",
    })),
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    multiAgentVersion: "v2",
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    availableAccessPrograms: { cyber: ["standard"] },
    isDefault: true,
  },
] as const;

/** collaborationMode/list。 */
export const COLLABORATION_MODES = {
  data: [
    { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
    { name: "Default", mode: "default", model: null, reasoning_effort: null },
  ],
} as const;

/** skills/list（模拟技能）。 */
export const SKILLS = {
  data: [
    {
      cwd: homedir(),
      skills: [
        {
          name: "bridge-sim-demo",
          description:
            "Bridge 模拟层自带的演示技能：验证手机端 $ 技能枚举链路。没有实际功能。",
          path: "/dev/null/SKILL.md",
          scope: "user",
          enabled: true,
          pluginId: null,
        },
      ],
      errors: [],
    },
  ],
} as const;

/** plugin/installed。 */
export const PLUGINS = { marketplaces: [], marketplaceLoadErrors: [] } as const;

/** threadSection/list。 */
export const SECTIONS = {
  data: [{ id: uuidv7(), name: "Pinned", appearance: null }],
  nextCursor: null,
} as const;

/**
 * config/read：完整蓝本（真实抓包，config 104 键 + origins 顶层键）。
 * 手机端的设置页对 config/read 结果做严格解码——缺 origins 或缺键会导致
 * 「无法加载任务设置」。origins 中的 config.toml 路径为抓包机器原值，仅展示用。
 */
export function readConfig(): Record<string, unknown> {
  return structuredClone(blueprintConfigRead) as Record<string, unknown>;
}

// --------------------------------------------------------------- Thread 构造

export function makeThread(args: {
  cwd: string;
  preview?: string;
  threadSource?: string;
  createdAt?: number;
}): ThreadRecord {
  const id = uuidv7();
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    environments: [
      { environmentId: "local", cwd: args.cwd, runtimeWorkspaceRoots: [args.cwd] },
    ],
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: args.preview ?? "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    model: DEFAULT_MODEL,
    reasoningEffort: "medium",
    collaborationMode: defaultCollaborationMode(DEFAULT_MODEL),
    createdAt: args.createdAt ?? now,
    updatedAt: args.createdAt ?? now,
    recencyAt: args.createdAt ?? now,
    status: { type: "idle" },
    path: null,
    cwd: args.cwd,
    cliVersion: CLI_VERSION,
    originator: "codex_chatgpt_ios_remote",
    source: "vscode",
    canAcceptDirectInput: true,
    threadSource: args.threadSource ?? "user",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    turns: [],
  };
}

export function makeTurn(status: TurnRecord["status"] = "inProgress"): TurnRecord {
  return {
    id: uuidv7(),
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: null,
    durationMs: null,
  };
}

export function makeUserMessage(text: string, clientId: string | null): UserMessageItem {
  return {
    type: "userMessage",
    id: uuidv7(),
    clientId,
    content: [{ type: "text", text, text_elements: [] }],
  };
}

export function makeAgentMessage(text = ""): AgentMessageItem {
  return {
    type: "agentMessage",
    id: simMsgId(),
    text,
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
}

/** 模拟进程号：真实 codex 为 shell 进程 pid 字符串，手机端只作展示。 */
let simProcessSeq = 60_000;

/**
 * commandExecution 条目形状蓝本：抓包 2026-09-25T19:21:34Z（item/started 时
 * status:"inProgress"、exitCode/durationMs/aggregatedOutput 为 null）。特殊指令
 * "test steer"/"test queue" 的模拟命令 "wait 15 seconds" 以该形状下发，手机端按
 * 普通命令调用渲染。
 */
export function makeCommandExecution(command: string, cwd: string): CommandExecutionItem {
  return {
    type: "commandExecution",
    id: `exec-${uuidv7()}`,
    pluginId: null,
    scriptPath: null,
    command,
    cwd,
    processId: String(simProcessSeq++),
    source: "unifiedExecStartup",
    status: "inProgress",
    commandActions: [{ type: "unknown", command }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
}

// ------------------------------------------------------------- 固定初始线程

export interface FixedThread {
  thread: ThreadRecord;
  /** items 索引：turnId → 该 turn 的 item 条目（按时间序）。 */
  items: ItemEntry[];
}

/**
 * 固定消息列表：一个带完整历史的预置会话。
 * 注意：codex 中不存在"零 turn 却长期出现在列表里"的线程——
 * 空线程只在会话进行中存活（thread-store shutdown 时无 rollout 即丢弃
 * pending metadata，live_writer.rs:192），故此处不预置空白线程。
 */
export function fixedThreads(): Map<string, FixedThread> {
  const now = Date.now();
  const t1 = makeThread({
    cwd: "/Users/ibobby/Projects/chatgpt-remote-control-bridge",
    preview: "模拟会话：桥接链路验证",
    createdAt: Math.floor((now - 3600_000) / 1000),
  });
  const turn1 = makeTurn("completed");
  turn1.startedAt = Math.floor((now - 3600_000) / 1000);
  turn1.completedAt = turn1.startedAt + 4;
  turn1.durationMs = 4000;
  turn1.itemsView = "summary";
  const u1 = makeUserMessage("你好，桥接链路通了吗？", null);
  const a1 = makeAgentMessage(
    "你好！这是 bridge 模拟层的固定回复：手机 → wham 后端 → 桥的链路已经打通。此消息来自预置历史，用于验证历史列表渲染。",
  );
  turn1.items = [u1, a1];
  t1.turns = [turn1];
  t1.updatedAt = turn1.completedAt ?? t1.updatedAt;
  t1.recencyAt = t1.updatedAt;

  const map = new Map<string, FixedThread>();
  map.set(t1.id, {
    thread: t1,
    items: [u1, a1].map((item, i) => ({
      turnId: turn1.id,
      item,
      startedAtMs: (turn1.startedAt ?? 0) * 1000 + i,
      completedAtMs: (turn1.startedAt ?? 0) * 1000 + i + 500,
    })),
  });
  return map;
}
