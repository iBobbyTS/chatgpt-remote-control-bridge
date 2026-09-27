/**
 * 模拟 app-server：对手机端（及 wham slingshot 后端）的 JSON-RPC 请求
 * 返回固定/程序生成的模拟响应，不接 LLM。
 *
 * 方法与通知形状蓝本：2026-09-25 真实抓包（docs/research/06、
 * .agent-work/tmp/sim-layer/catalog*.json）。
 */
import { EventEmitter } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  CLI_VERSION,
  COLLABORATION_MODES,
  DEFAULT_MODEL,
  MODELS,
  MODEL_CONTEXT_WINDOW,
  PLUGINS,
  SECTIONS,
  SKILLS,
  type CollaborationMode,
  type CommandExecutionItem,
  type ContextCompactionItem,
  defaultCollaborationMode,
  fixedThreads,
  makeAgentMessage,
  makeCommandExecution,
  makeThread,
  makeTurn,
  makeUserMessage,
  readConfig,
  type InjectedResponseItem,
  isAgentMessageItem,
  isUserMessageItem,
  type ItemEntry,
  type SimGoal,
  type SimGoalStatus,
  type SimItem,
  type TextContent,
  type ThreadGitInfo,
  type ThreadRecord,
  type TurnRecord,
} from "./data.ts";
import { uuidv7 } from "./ids.ts";
import type { AgentApp } from "../types.ts";

export interface SimClientKey {
  clientId: string;
  streamId: string;
}

export interface SimClientState {
  clientInfo: { name?: string; title?: string; version?: string } | null;
  optOut: Set<string>;
  unsubscribed: Set<string>;
  initialized: boolean;
}

export interface SimNotification {
  method: string;
  params: Record<string, unknown>;
  /** 存在时仅投递给订阅了该 thread 的客户端。 */
  threadId?: string;
  /** 存在时仅投递给该连接（连接级通知，如 command/exec/outputDelta）。 */
  target?: SimClientKey;
}

export interface JsonRpcSuccess {
  id: number | string;
  result: unknown;
}
export interface JsonRpcFailure {
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}
export type JsonRpcOutcome = JsonRpcSuccess | JsonRpcFailure;

export interface SimAppOptions {
  codexHome: string;
  userAgent?: string;
  /** turn 事件流各步骤间隔（测试可调小）。默认 250ms。 */
  stepDelayMs?: number;
  /** agentMessage 流式 delta 间隔。默认 90ms。 */
  deltaIntervalMs?: number;
  /** 每个 delta 的字符数。默认 8。 */
  deltaChars?: number;
  /** 特殊指令模拟命令 "wait 15 seconds" 的真实等待时长。默认 15000ms（测试可调小）。 */
  commandWaitMs?: number;
  /** compact 模拟耗时。默认 5000ms（测试可调小）。 */
  compactWaitMs?: number;
  /** thread/shellCommand 模拟耗时。默认 2000ms（测试可调小）。 */
  shellWaitMs?: number;
  /** 服务器信息（remoteControl/status/changed 通知用），由 server 注入。 */
  getServerInfo?: () => { serverName: string; installationId: string; environmentId: string } | null;
  accountInfo?: { authMode: string; planType: string | null };
  /**
   * 线程状态持久化路径。手机会缓存 thread id，进程重启后必须能 resume
   * 同一批线程，否则会话列表点击报错、历史丢失。不传则仅内存态（测试用）。
   */
  statePath?: string;
  log?: (line: string) => void;
}

interface QueuedSubmission {
  id: string;
  input: TextContent[];
  clientUserMessageId: string | null;
}

interface SimTurnRuntime {
  turn: TurnRecord;
  timers: Set<NodeJS.Timeout>;
  steerInputs: Array<{ text: string; clientUserMessageId: string | null }>;
  /**
   * steer 输入文本为「stop」时置位：当前工具或消息步骤一结束就终止 turn 剩余
   * 脚本（test steer 的后续消息与 15 秒等待不再执行），只回一条停止消息。
   */
  steerStopRequested: boolean;
  ended: boolean;
  /**
   * turn 种类（S03）：normal=普通/shell 轻量 turn；compact=thread/compact/start
   * 创建的压缩 turn；goal=goal 续跑 turn（thread/goal/set active 后自动开跑，
   * 输入为隐藏内部上下文，无 userMessage item，可 steer）。compact turn 不可
   * steer、不可被 turn/start 接管（对齐 codex TaskKind::Compact，
   * turn_input.rs:660-680）。
   */
  kind: "normal" | "compact" | "goal";
  /**
   * goal turn 结束时写入 goal 的模拟终态：null=保持 active（阶段内继续轮，空闲后
   * 自动续跑下一个 goal turn）；"blocked"=首轮阶段第 3 轮终态；"complete"=再启
   * 阶段终态。仅 kind==="goal" 使用。
   */
  goalEndStatus: "blocked" | "complete" | null;
}

/** thread/shellCommand 登记的后台终端条目（v2/thread.rs:1215-1224）。 */
interface BackgroundTerminalEntry {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
}

/**
 * thread/tokenUsage/updated 的 tokenUsage 载荷（v2/thread.rs:1895-1901
 * ThreadTokenUsage）：total=线程累计用量，last=最近一轮用量，modelContextWindow=
 * 模型上下文窗口上限（手机 status 页「上下文」行的 当前值/窗口上限 即来自这里）。
 */
interface SimTokenUsage {
  total: { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
  last: { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
  modelContextWindow: number;
}

interface ThreadState {
  thread: ThreadRecord;
  items: ItemEntry[];
  queue: QueuedSubmission[];
  sim: SimTurnRuntime | null;
  /** 线程目标（v2/thread.rs:813），持久化；旧快照缺字段按 null。 */
  goal: SimGoal | null;
  /**
   * goal 模拟轮种（内存态，不持久化）：true=从 blocked 再次激活的续跑轮
   * （1 条输出 → complete）；false=首轮（3 条输出 → blocked）。每次 goalSet
   * 结果为 active 时按先前状态重判，goal 持久化状态本身已足以在重启后恢复判定。
   */
  goalRunResume: boolean;
  /**
   * goal turn 轮次计数（内存态，不持久化）：每开跑一个 goal turn 递增；第 2 个
   * goal turn 的模拟 wait 为 30 秒，其余 10 秒。新 goal（无既有 goal 的 set）与
   * goal/clear 时归零。
   */
  goalTurnCount: number;
  /**
   * 当前激活阶段内已跑的 goal turn 数（内存态，不持久化）：首轮阶段共 3 轮
   * （前 2 轮结束保持 active 自动续跑，第 3 轮标 blocked），再启阶段 1 轮
   * （标 complete）。每次 goalSet 结果为 active 时归零（阶段重开）。
   */
  goalPhaseIndex: number;
  /**
   * 用户中止标记（内存态，不持久化）：turn/interrupt 后置位，下一个 turn 开跑时
   * 清除。对齐 codex AgentStatus::Interrupted——中止后 thread/queue/add 的
   * wake_if_loaded 跳过（排队消息不自动开跑，queue/service.rs:476-483），而
   * goal 续跑不看 cause 照常进行（goal/extension.rs on_thread_idle 无 cause 检查）。
   */
  interrupted: boolean;
  /** compact 刚完成标记（内存态，不持久化）；下一个普通 turn 回复首行提示后清除。 */
  justCompacted: boolean;
  /** 后台终端（不持久化）：thread/shellCommand 完成后登记。 */
  backgroundTerminals: BackgroundTerminalEntry[];
  /**
   * 最近一次 thread/tokenUsage/updated 快照（持久化）：turn 收尾时记录，resume
   * 时向重连客户端补发（token_usage_replay.rs:35-56 连接作用域重放；thread_
   * processor.rs:4172-4175「client needs restored usage before it starts another
   * turn ... filling the status line」——缺补发则 App 重连后上下文行显示不可用）。
   */
  tokenUsage: { turnId: string; usage: SimTokenUsage } | null;
  /**
   * 上下文占用（char 计，持久化）：已占用 = 会话内 userMessage/agentMessage 字符
   * 数，上限 257999（窗口 258000 减 1）。新会话基线 0；compact 后重置为 200 基线
   * （压缩摘要占位），此后按新消息字符继续累加。
   */
  contextUserChars: number;
  contextAgentChars: number;
  /** 上下文占用基线：新会话 0；compact 重置后 200。 */
  contextBaseline: number;
}

/** 新建 ThreadState 的统一入口（补齐 S03 新增字段，避免各处漏初始化）。 */
function makeThreadState(thread: ThreadRecord, items: ItemEntry[]): ThreadState {
  return { thread, items, queue: [], sim: null, goal: null, goalRunResume: false, goalTurnCount: 0, goalPhaseIndex: 0, interrupted: false, justCompacted: false, backgroundTerminals: [], tokenUsage: null, contextUserChars: 0, contextAgentChars: 0, contextBaseline: 0 };
}

/** 已占用 token 上限：窗口 258000 减 1。 */
const CONTEXT_CHARS_MAX = 257_999;
/** compact 后的上下文占用基线（压缩摘要占位）。 */
const CONTEXT_BASELINE_AFTER_COMPACT = 200;

type AnyParams = Record<string, any>;

const ERR_NOT_INITIALIZED = { code: -32600, message: "Not initialized" };
const ERR_METHOD_NOT_FOUND = { code: -32601, message: "Method not found" };

/** thread/goal/set 允许的 status 取值（v2/thread.rs ThreadGoalStatus 枚举）。 */
const GOAL_STATUSES: readonly SimGoalStatus[] = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
];

/** goal 计量每 turn 累加的模拟 token 数（与 tokenUsage 通知的 total 1234 一致）。 */
const GOAL_TURN_TOKENS = 1234;

/** 特殊指令帮助文本（手机端发送对应指令即得本条回复）。 */
const HELP_TEXT = [
  "特殊指令：",
  "help: 输出本条帮助信息",
  'test steer：服务器会返回3次消息，中间使用模拟命令"wait 15 seconds"（不依赖shell），可以测试steer强制插入消息的效果；期间steer发送stop会在当前步骤结束后停止脚本。',
  'test queue：服务器会返回3次消息，中间使用模拟命令"wait 15 seconds"（不依赖shell），可以测试queue排队消息的效果。',
  "",
  "模拟功能（对齐 codex）：",
  "goal 启用后自动续跑共4个goal turn（每个=1次模拟wait+1条输出；第2个turn的wait为30秒、其余10秒）：前3个后标记blocked，再次启动第4个后标记complete；turn运行中发消息会steer插入当前turn，停止/中止只结束当前turn、goal仍自动续跑，中止后排队消息不会自动开跑",
  "compact 约 5 秒完成且下一条回复标记",
  "Plan 模式回复带前缀",
  "shell 命令生成模拟命令条目",
  "branch 经 thread/metadata/update 设置、fork 复制历史",
  "消息含 $技能名 会确认加载",
].join("\n");

/** 特殊指令识别：trim + 大小写不敏感的完全匹配。 */
function specialCommandOf(userText: string): "help" | "test-steer" | "test-queue" | null {
  const t = userText.trim().toLowerCase();
  if (t === "help") return "help";
  if (t === "test steer") return "test-steer";
  if (t === "test queue") return "test-queue";
  return null;
}

/**
 * 识别手机的任务标题生成 turn（turnTrigger=remote_ios + outputSchema{title}）：
 * 手机用 LLM 为用户消息生成 ≤36 字符的 UI 标题，期待 agentMessage 文本为符合
 * schema 的 JSON（{"title":"…"}）。2026-09-26 真机复现：该 turn 被当普通消息
 * 回复长文本（非 JSON）→ 手机 outputSchema 解析失败 → UI 渲染冻结 + 30s 重连
 * 循环（docs/research/07-sim-layer.md）。返回 title.maxLength（无则 36）；非
 * 标题 turn 返回 null。
 */
function titleSchemaOf(p: AnyParams): number | null {
  const schema = p.outputSchema;
  if (typeof schema !== "object" || schema === null) return null;
  const props = (schema as { properties?: unknown }).properties;
  const title = typeof props === "object" && props !== null
    ? (props as Record<string, unknown>).title
    : undefined;
  if (typeof title !== "object" || title === null) return null;
  const max = (title as { maxLength?: unknown }).maxLength;
  if (typeof max === "number" && Number.isFinite(max) && max > 0) return max;
  return 36;
}

/** 从标题生成 prompt 尾部 "User prompt:\n<msg>" 提取标题：单行化、去引号、按 schema 截断。 */
function titleForPrompt(prompt: string, maxLength: number): string {
  const marker = "User prompt:";
  const idx = prompt.lastIndexOf(marker);
  const raw = idx >= 0 ? prompt.slice(idx + marker.length) : prompt;
  let title = raw.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "");
  if (!title) title = "Task";
  return title.length > maxLength ? title.slice(0, maxLength) : title;
}

export class SimApp extends EventEmitter implements AgentApp {
  private readonly clients = new Map<string, SimClientState>();
  private readonly threads = new Map<string, ThreadState>();
  /** 虚拟目录覆盖层：绝对路径 → 存在的目录（模拟 mkdir，不落盘）。 */
  private readonly overlayDirs = new Set<string>();
  private readonly overlayChildren = new Map<string, Set<string>>();
  private readonly opts: Required<
    Pick<
      SimAppOptions,
      "codexHome" | "stepDelayMs" | "deltaIntervalMs" | "deltaChars" | "commandWaitMs" | "compactWaitMs" | "shellWaitMs"
    >
  > &
    SimAppOptions;
  private closed = false;
  private saveQueue: Promise<void> = Promise.resolve();
  /**
   * 全部在途定时器（S03）：既含各 turn 的 sim.timers，也含 `schedule(null, …)` 的
   * 队列续跑计时器等无 turn 定时器。close()/reset 统一清理，避免 reset 后队列复活。
   */
  private readonly pendingTimers = new Set<NodeJS.Timeout>();

  constructor(opts: SimAppOptions) {
    super();
    this.opts = {
      stepDelayMs: 250,
      deltaIntervalMs: 90,
      deltaChars: 8,
      commandWaitMs: 15_000,
      compactWaitMs: 5_000,
      shellWaitMs: 2_000,
      ...opts,
    };
    if (this.opts.statePath) {
      this.loadStateSync(this.opts.statePath);
    }
    if (this.threads.size === 0) {
      this.seedPresetThreads();
    }
  }

  /** 内存恢复为预置线程（构造空库与 reset 共用）。 */
  private seedPresetThreads(): void {
    this.threads.clear();
    for (const [id, fixed] of fixedThreads()) {
      this.threads.set(id, makeThreadState(fixed.thread, fixed.items));
    }
  }

  // ------------------------------------------------------------------ 持久化

  /** 启动时恢复线程状态（含预置会话与动态创建的线程/历史）。 */
  private loadStateSync(statePath: string): void {
    let raw: string;
    try {
      raw = readFileSync(statePath, "utf8");
    } catch {
      return; // 无存档：首次启动
    }
    try {
      const parsed = JSON.parse(raw) as Array<{
        thread: ThreadRecord;
        items: ItemEntry[];
        goal?: SimGoal | null;
        tokenUsage?: { turnId: string; usage: SimTokenUsage } | null;
        contextUserChars?: number;
        contextAgentChars?: number;
        contextBaseline?: number;
      }>;
      for (const entry of parsed) {
        if (entry?.thread?.id) {
          if ((entry.thread.turns ?? []).length === 0) {
            continue; // 零 turn 线程不跨重启存活（对齐 codex shutdown 清理）
          }
          // 旧快照兼容：S03 之前的存档无 collaborationMode / gitInfo 等新字段
          if (!entry.thread.collaborationMode) {
            entry.thread.collaborationMode = defaultCollaborationMode(entry.thread.model ?? DEFAULT_MODEL);
          }
          entry.thread.forkedFromId ??= null;
          entry.thread.projectId ??= null;
          entry.thread.gitInfo ??= null;
          const state = makeThreadState(entry.thread, entry.items ?? []);
          state.goal = entry.goal ?? null;
          state.tokenUsage = entry.tokenUsage ?? null;
          state.contextUserChars = entry.contextUserChars ?? 0;
          state.contextAgentChars = entry.contextAgentChars ?? 0;
          state.contextBaseline = entry.contextBaseline ?? 0;
          this.threads.set(entry.thread.id, state);
        }
      }
    } catch (err) {
      this.opts.log?.(`状态文件解析失败（忽略）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** 落盘快照：非 ephemeral 线程（persistState 与 reset 显式写共用同一形状）。 */
  private snapshotEntries(): Array<{ thread: ThreadRecord; items: ItemEntry[]; goal: SimGoal | null; tokenUsage: { turnId: string; usage: SimTokenUsage } | null; contextUserChars: number; contextAgentChars: number; contextBaseline: number }> {
    return [...this.threads.values()]
      .filter((t) => !t.thread.ephemeral)
      .map((t) => ({
        thread: t.thread,
        items: t.items,
        goal: t.goal,
        tokenUsage: t.tokenUsage,
        contextUserChars: t.contextUserChars,
        contextAgentChars: t.contextAgentChars,
        contextBaseline: t.contextBaseline,
      }));
  }

  /** 原子落盘（tmp + rename），串行化避免并发写。运行期写失败**吞错**（仅日志）。 */
  private persistState(): void {
    const statePath = this.opts.statePath;
    if (!statePath) return;
    const snapshot = this.snapshotEntries();
    this.saveQueue = this.saveQueue
      .then(async () => {
        const tmp = `${statePath}.tmp`;
        await writeFile(tmp, JSON.stringify(snapshot), "utf8");
        await rename(tmp, statePath);
      })
      .catch((err) => {
        this.opts.log?.(`状态落盘失败: ${err instanceof Error ? err.message : err}`);
      });
  }

  /**
   * reset 路径的播种写（S03 B 槽新缺陷修复）：把播种写作为任务**入列 saveQueue 尾部**，
   * 与运行期 persistState 保持**同一串行顺序**，从而 reset 写必为串行序中的"最后一个写"——
   * 即便 reset 排空等待期间并发 persistState 追加了旧快照写，它也排在播种写之前，不会后落盘覆盖。
   *
   * 内容**入列时即冻结**：`JSON.stringify` 在入列处完成（不是队列任务执行时），否则浅拷贝的
   * thread/items 仍引用可变对象，任务执行前并发 turn/start 等改内存会被序列化进播种写。
   *
   * 错误传递：返回 one-shot promise，写失败时 reject 给 resetToSeed；但 saveQueue 链本身
   * 仍吞错（不 reject），运行期吞错语义不变。
   */
  private enqueueSeedWrite(): Promise<void> {
    const statePath = this.opts.statePath;
    if (!statePath) return Promise.resolve();
    const serialized = JSON.stringify(this.snapshotEntries()); // 入列即冻结，锁死播种态
    const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
    let resolveDone!: () => void;
    let rejectDone!: (err: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const task = this.saveQueue.then(async () => {
      await writeFile(tmp, serialized, "utf8");
      await rename(tmp, statePath);
    });
    // 链尾吞错（与 persistState 一致）：失败只 reject one-shot done，不让 saveQueue 断裂
    this.saveQueue = task.then(
      () => resolveDone(),
      (err) => {
        this.opts.log?.(`reset 播种落盘失败: ${err instanceof Error ? err.message : err}`);
        rejectDone(err);
      },
    );
    return done;
  }

  // ------------------------------------------------------------------ 客户端

  clientState(key: SimClientKey): SimClientState {
    const id = `${key.clientId}/${key.streamId}`;
    let state = this.clients.get(id);
    if (!state) {
      state = { clientInfo: null, optOut: new Set(), unsubscribed: new Set(), initialized: false };
      this.clients.set(id, state);
    }
    return state;
  }

  forgetClient(key: SimClientKey): void {
    this.clients.delete(`${key.clientId}/${key.streamId}`);
  }

  pongStatus(): "active" | "unknown" {
    for (const t of this.threads.values()) {
      if (t.sim && !t.sim.ended) return "active";
    }
    return "unknown";
  }

  close(): void {
    this.closed = true;
    this.clearAllTimers();
  }

  /**
   * S03：把运行态重置为播种态——清空线程/turn/items/queue/ephemeral 与**全部**在途定时器
   * （含队列续跑计时器），重新播种 fixedThreads 并落盘。
   *
   * 与 saveQueue 的交错（B 槽缺陷修复）：先排空在途写；随后**同步**内存播种 + 把播种写
   * 入列 saveQueue 尾部（同一串行顺序），保证 reset 写是"最后一个写"——排空等待期间并发
   * persistState 追加的旧快照写都排在播种写之前，不会后落盘覆盖。入列后再排空一次才返回。
   * 播种写失败经 one-shot promise 上抛，daemon IPC 据此报 {ok:false,INTERNAL}。
   *
   * 保留语义（NIT，明确声明）：
   * - `clients`：不动。在线手机连接须跨 reset 保持，否则 reset 会踢掉已配对会话。
   * - `overlayDirs` / `overlayChildren`：不动。虚拟 FS 覆盖层是进程级模拟状态，
   *   与"会话库播种态"无关，清理会让 reset 后线程引用的工作目录凭空消失。
   * 二者均为运行态连接/环境模拟，不属于 store 播种语义。
   */
  async resetToSeed(): Promise<void> {
    await this.saveQueue.catch(() => undefined); // 先排空在途旧写
    this.clearAllTimers();
    this.seedPresetThreads(); // 同步内存播种：此后并发 persistState 均看到播种态
    const seedDone = this.enqueueSeedWrite(); // 播种写入列队列尾部（最后写）
    await seedDone; // 播种写失败 → 上抛
    await this.saveQueue.catch(() => undefined); // 再排空，确保落盘完成才返回
  }

  // ------------------------------------------------------------------ 分发

  async handleRequest(
    key: SimClientKey,
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<JsonRpcOutcome> {
    const client = this.clientState(key);
    if (method !== "initialize" && !client.initialized) {
      return { id, error: ERR_NOT_INITIALIZED };
    }
    try {
      const result = await this.dispatch(key, client, method, (params ?? {}) as AnyParams);
      return { id, result };
    } catch (err) {
      if (err instanceof SimMethodError) {
        return { id, error: { code: err.code, message: err.message } };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { id, error: { code: -32000, message: `sim internal error: ${message}` } };
    }
  }

  private async dispatch(
    key: SimClientKey,
    client: SimClientState,
    method: string,
    p: AnyParams,
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(client, p);
      case "thread/list":
        return this.threadList(p);
      case "thread/start":
        return this.threadStart(p);
      case "thread/resume":
        // resume 即重新订阅：对齐 codex thread_processor.rs:1018-1043 的 resume
        // 语义（最终走 thread_state.rs:559-581 try_ensure_connection_subscribed），
        // 否则先 unsubscribe 再 resume 的连接会永久收不到该线程通知
        client.unsubscribed.delete(p.threadId ?? p.thread_id);
        return this.threadResume(p);
      case "thread/unsubscribe":
        client.unsubscribed.add(p.threadId ?? p.thread_id);
        return { status: "unsubscribed" };
      case "thread/turns/list":
        return this.turnsList(p);
      case "thread/items/list":
        return this.itemsList(p);
      case "threadSection/list":
        return SECTIONS;
      case "thread/goal/set":
        return this.goalSet(p);
      case "thread/goal/get":
        return this.goalGet(p);
      case "thread/goal/clear":
        return this.goalClear(p);
      case "turn/start":
        return this.turnStart(p);
      case "turn/steer":
        return this.turnSteer(p);
      case "turn/interrupt":
        return this.turnInterrupt(p);
      case "thread/queue/add":
        return this.queueAdd(p);
      case "thread/queue/list":
        return {
          data: (this.threadState(p).queue ?? []).map((q) => ({
            id: q.id,
            input: q.input,
            clientUserMessageId: q.clientUserMessageId,
          })),
          nextCursor: null,
        };
      case "thread/queue/delete":
        return this.queueDelete(p);
      case "thread/compact/start":
        return this.compactStart(p);
      case "thread/shellCommand":
        return this.shellCommand(p);
      // codex 权威方法名带 thread/ 前缀（common.rs:737-753）；裸名作兼容别名
      case "thread/backgroundTerminals/list":
      case "backgroundTerminals/list":
        return this.backgroundTerminalsList(p);
      case "thread/backgroundTerminals/terminate":
      case "backgroundTerminals/terminate":
        return this.backgroundTerminalsTerminate(p);
      case "thread/backgroundTerminals/clean":
      case "backgroundTerminals/clean":
        return this.backgroundTerminalsClean(p);
      case "thread/metadata/update":
        return this.metadataUpdate(p);
      case "thread/fork":
        return this.threadFork(p);
      case "thread/name/set":
        return this.threadNameSet(p);
      case "thread/inject_items":
        return this.threadInjectItems(p);
      case "server/diagnostics":
        return this.diagnostics();
      case "remoteControl/status/read":
        return this.remoteControlStatusRead();
      case "account/rateLimits/read":
        return this.accountRateLimitsRead();
      case "account/usage/read":
        return this.accountUsageRead();
      case "memory/status":
        // v2/memory.rs:20-23：{v2ConsolidatedThreads, v2Ready}
        return { v2ConsolidatedThreads: 0, v2Ready: false };
      case "skills/extraRoots/set":
        return {};
      case "skills/config/write":
        return this.skillsConfigWrite(p);
      case "plugin/skill/read":
        return this.pluginSkillRead(p);
      case "thread/settings/update":
        return this.settingsUpdate(p);
      case "fs/readDirectory":
        return this.fsReadDirectory(p);
      case "fs/getMetadata":
        return this.fsGetMetadata(p);
      case "fs/createDirectory":
        this.overlayMkdir(p.path);
        return {};
      case "process/spawn":
        return this.processSpawn(p);
      case "command/exec":
        return this.commandExec(key, p);
      case "command/exec/write":
        return this.commandExecWrite(p);
      case "command/exec/terminate":
        return this.commandExecTerminate(p);
      case "command/exec/resize":
        return this.commandExecResize(p);
      case "config/read":
        return readConfig();
      case "config/batchWrite":
        return {
          status: "ok",
          version: `sha256:${randomBytes(32).toString("hex")}`,
          filePath: join(this.opts.codexHome, "config.toml"),
          overriddenMetadata: null,
        };
      case "configRequirements/read":
        return { requirements: null };
      case "model/list":
        return { data: MODELS, nextCursor: null };
      case "collaborationMode/list":
        return COLLABORATION_MODES;
      case "skills/list":
        return SKILLS;
      case "plugin/installed":
        return PLUGINS;
      case "attestation/generate":
        return { token: "v1.cgc-bridge-sim" };
      default:
        throw new SimMethodError(ERR_METHOD_NOT_FOUND.code, ERR_METHOD_NOT_FOUND.message);
    }
  }

  // ------------------------------------------------------------------ 方法

  private initialize(client: SimClientState, p: AnyParams): unknown {
    client.initialized = true;
    client.clientInfo = p.clientInfo ?? null;
    client.optOut = new Set(p.capabilities?.optOutNotificationMethods ?? []);
    // codex 的 initialize 只随附 ConfigWarning 通知（initialize_processor.rs:232-249），
    // 不发 account/updated 也不发 remoteControl/status/changed——这两条只应在真实
    // 状态变化时发（auth 变更 / 隧道连接迁移）。此前每次 initialize 都推（planType
    // 还是 null），手机每 ~30s 重连即收到一次「账户信息变更」，status 页上下文显示
    // 被打回「不可用」直到 resume 补发恢复——实测来回跳的根因。按需读取走
    // account/rateLimits/read 与 remoteControl/status/read。tokenUsage 补发也严格
    // 绑定在 resume 上（曾试验 initialize 附带重放 + resume 后二次重申以缓解 App
    // 重建期闪动，按用户决定回退，保持与 codex 逐字对齐）。
    return {
      userAgent: this.opts.userAgent ?? `codex_cli_rs/${CLI_VERSION} (Mac OS ${release()}; ${process.arch}) bridge-sim`,
      codexHome: this.opts.codexHome,
      platformFamily: process.platform === "win32" ? "windows" : "unix",
      platformOs: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    };
  }

  private threadList(_p: AnyParams): unknown {
    // 对齐 codex：thread/list 只读磁盘 rollout——ephemeral 线程与从未跑过
    // turn 的线程都不会出现（live_writer.rs:192 无 rollout 即丢弃 pending metadata）
    const data = [...this.threads.values()]
      .filter((t) => !t.thread.ephemeral && t.thread.turns.length > 0)
      .map((t) => this.serializeThread(t.thread, []))
      .sort((a, b) => (b.recencyAt ?? 0) - (a.recencyAt ?? 0));
    return { data, nextCursor: null, backwardsCursor: null };
  }

  private threadStart(p: AnyParams): unknown {
    const cwd = p.cwd ?? homedir();
    const thread = makeThread({ cwd, threadSource: p.threadSource ?? "user" });
    // ephemeral:true = 手机端的「起名线程」：仅内存、不落盘、不进列表
    thread.ephemeral = p.ephemeral === true;
    if (p.model) thread.model = p.model;
    this.threads.set(thread.id, makeThreadState(thread, []));
    if (!thread.ephemeral) {
      this.persistState();
    }
    this.emitSoon("thread/started", { thread: this.serializeThread(thread, []) });
    return this.threadContext(thread);
  }

  /**
   * thread/start 与 thread/resume 共用的会话上下文响应形状
   * （真实抓包 2026-09-25T18:38:02Z：thread 外还有 13 个顶层键）。
   * thread/start 只回 {thread} 会让手机 Swift 必填字段解码失败
   * →「无法解码Codex响应」，发消息流程在 turn/start 之前中止。
   */
  private threadContext(thread: ThreadRecord): Record<string, unknown> {
    return {
      thread: this.serializeThread(thread, []),
      model: thread.model,
      modelProvider: "openai",
      serviceTier: null,
      disabledPluginIds: [],
      cwd: thread.cwd,
      runtimeWorkspaceRoots: [thread.cwd],
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      activePermissionProfile: null,
      reasoningEffort: thread.reasoningEffort,
      multiAgentMode: "explicitRequestOnly",
    };
  }

  private threadResume(p: AnyParams): unknown {
    const state = this.threadState(p);
    if (p.cwd) {
      state.thread.cwd = p.cwd;
      state.thread.environments = [
        { environmentId: "local", cwd: p.cwd, runtimeWorkspaceRoots: [p.cwd] },
      ];
    }
    if (p.model) state.thread.model = p.model;
    this.persistState();
    // MB5：resume 响应先行，随后用**宏任务**补发快照（对齐 thread_processor.rs:
    // 4166-4190 顺序：resume 响应 → tokenUsage 重放 → goal 快照 → idle lifecycle；
    // token_usage_replay.rs:35-56 连接作用域，「client needs restored usage before
    // it starts another turn ... filling the status line」——手机 status 页「上下文」
    // 行依赖这条补发，缺了则重连后显示不可用）。禁用 emitSoon 微任务：微任务可能
    // 仍先于 dispatchMessage 写响应（appServer.ts:674 注释记录的「响应先行陷阱」）。
    this.schedule(null, () => {
      if (this.closed) return;
      const current = this.threads.get(state.thread.id);
      if (!current) return;
      this.replayTokenUsage(current.thread.id);
      // 有 goal → thread/goal/updated；无 → thread/goal/cleared。
      if (current.goal) {
        this.emit("event", this.notification("thread/goal/updated", {
          threadId: current.thread.id,
          turnId: null,
          goal: current.goal,
        }, current.thread.id));
      } else {
        this.emit("event", this.notification("thread/goal/cleared", { threadId: current.thread.id }, current.thread.id));
      }
    }, 0);
    return {
      ...this.threadContext(state.thread),
      collaborationMode: state.thread.collaborationMode,
      initialTurnsPage: null,
      // 非空 cursor：手机据此调用 turns/items list 拉取历史；null 会让手机认为没有历史
      turnsBackwardsCursor: this.cursorFor(state.thread.id, state.thread.turns.length, "turns"),
      itemsBackwardsCursor: this.cursorFor(state.thread.id, state.items.length, "itemsByCreatedAtOrdinal"),
    };
  }

  /**
   * 向订阅连接重放线程最近一次 tokenUsage 快照（token_usage_replay.rs:35-56 的
   * 连接作用域重放；幂等——同负载客户端按最新值合并）。快照为空或线程已消失时
   * 静默跳过。
   */
  private replayTokenUsage(threadId: string): void {
    const current = this.threads.get(threadId);
    if (!current?.tokenUsage) return;
    this.emit("event", this.notification("thread/tokenUsage/updated", {
      threadId: current.thread.id,
      turnId: current.tokenUsage.turnId,
      tokenUsage: current.tokenUsage.usage,
    }, current.thread.id));
  }

  /** 与 codex 同形状的不透明 cursor 字符串。 */
  private cursorFor(threadId: string, ordinal: number, scopeKind: "turns" | "itemsByCreatedAtOrdinal"): string {
    return JSON.stringify({
      requestedThreadId: threadId,
      rolloutOrdinal: Math.max(1, ordinal),
      includeAnchor: true,
      scope: { kind: scopeKind },
    });
  }

  private turnsList(p: AnyParams): unknown {
    const state = this.threadState(p);
    const turns = [...state.thread.turns]
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .map((t) => ({ ...t, items: [], itemsView: "notLoaded" as const }));
    return {
      data: turns,
      nextCursor: null,
      backwardsCursor: this.cursorFor(state.thread.id, state.thread.turns.length, "turns"),
    };
  }

  private itemsList(p: AnyParams): unknown {
    const state = this.threadState(p);
    let entries = state.items;
    if (p.turnId) {
      entries = entries.filter((e) => e.turnId === p.turnId);
    }
    // 手机端传 sortDirection:"desc" 并按该契约渲染；返回正序会导致会话内消息颠倒
    const desc = (p.sortDirection ?? "desc") !== "asc";
    const data = [...entries].sort((a, b) =>
      desc ? b.startedAtMs - a.startedAtMs : a.startedAtMs - b.startedAtMs,
    );
    return {
      data,
      nextCursor: null,
      backwardsCursor: this.cursorFor(state.thread.id, state.items.length, "itemsByCreatedAtOrdinal"),
    };
  }

  private settingsUpdate(p: AnyParams): unknown {
    const state = this.threadState(p);
    if (p.model) state.thread.model = p.model;
    if (p.effort) state.thread.reasoningEffort = p.effort;
    if (p.cwd) state.thread.cwd = p.cwd;
    this.applyCollaborationMode(state, p);
    this.persistState();
    this.emitSoon(
      "thread/settings/updated",
      {
        threadId: state.thread.id,
        threadSettings: {
          disabledPluginIds: [],
          cwd: state.thread.cwd,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          activePermissionProfile: null,
          model: state.thread.model,
          // ThreadSettings.collaboration_mode 非 optional（v2/thread.rs:304-335）
          collaborationMode: state.thread.collaborationMode,
        },
      },
      state.thread.id,
    );
    return {};
  }

  /**
   * 解析并落线程 collaborationMode（turn/start 与 thread/settings/update 共用）。
   * 形状校验：mode 只取 plan/default，非法 -32600（v2/turn.rs:263-267、
   * v2/thread.rs:281-285；wire 字段为 snake_case，见 config_types.rs:780）。
   * 未提供（undefined/null）→ 不变。
   */
  private applyCollaborationMode(state: ThreadState, p: AnyParams): void {
    if (!("collaborationMode" in p) || p.collaborationMode === null || p.collaborationMode === undefined) {
      return;
    }
    const raw = p.collaborationMode as { mode?: unknown; settings?: Record<string, unknown> };
    const mode = raw.mode;
    if (mode !== "plan" && mode !== "default") {
      throw new SimMethodError(-32600, `invalid collaboration mode: ${String(mode)}`);
    }
    const settings = raw.settings ?? {};
    const current = state.thread.collaborationMode.settings;
    state.thread.collaborationMode = {
      mode,
      settings: {
        model: typeof settings.model === "string" ? settings.model : current.model,
        reasoning_effort:
          settings.reasoning_effort === null
            ? null
            : typeof settings.reasoning_effort === "string"
              ? settings.reasoning_effort
              : current.reasoning_effort,
        developer_instructions:
          settings.developer_instructions === null
            ? null
            : typeof settings.developer_instructions === "string"
              ? settings.developer_instructions
              : current.developer_instructions,
      },
    };
  }

  // ------------------------------------------------------------- turn 模拟

  private turnStart(p: AnyParams): unknown {
    const state = this.threadState(p);
    const input = normalizeInput(p.input);
    const clientUserMessageId = p.clientUserMessageId ?? null;
    // compact 进行中：turn/start 不可接管 compact turn。对齐 codex
    // start_or_steer_turn 遇 TaskKind::Compact → NotSubmittedReason::
    // ActiveTurnNotSteerable{turn_kind:Compact}（turn_input.rs:660-680），
    // turn_processor.rs:675-684 映射为 internal_error(format!("failed to submit
    // turn input: {reason:?}"))，此处按 Debug 形状取文案。
    if (state.sim && !state.sim.ended && state.sim.kind === "compact") {
      throw new SimMethodError(-32603, "failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }");
    }
    this.applyCollaborationMode(state, p);
    if (state.sim && !state.sim.ended) {
      // 活动期 turn/start 转 steer：对齐 codex start_or_steer_turn
      // （turn_processor.rs:651-684，TurnInputSubmission::Steered）——输入注入当前
      // turn，返回同一 turn。不新建 turn、不排队，避免旧 sim 定时器孤儿化。
      this.pushSteerInput(state.sim, input.map((c) => c.text).join(""), clientUserMessageId);
      return { turn: { ...this.serializeTurn(state.sim.turn), items: [], itemsView: "notLoaded" as const } };
    }
    const sim = this.beginSimTurn(state, input, clientUserMessageId, titleSchemaOf(p));
    // 真实 turn/start 响应：items 空、itemsView notLoaded
    return { turn: { ...this.serializeTurn(sim.turn), items: [], itemsView: "notLoaded" as const } };
  }

  private turnSteer(p: AnyParams): unknown {
    const state = this.threadState(p);
    const input = normalizeInput(p.input);
    const clientUserMessageId = p.clientUserMessageId ?? null;
    if (state.sim && !state.sim.ended) {
      // compact turn 不可 steer（turn_processor.rs:1101-1111：
      // NonSteerableTurnKind::Compact → -32600 "cannot steer a compact turn"）
      if (state.sim.kind === "compact") {
        throw new SimMethodError(-32600, "cannot steer a compact turn");
      }
      this.pushSteerInput(state.sim, input.map((c) => c.text).join(""), clientUserMessageId);
      return { turnId: p.expectedTurnId ?? state.sim.turn.id };
    }
    // 对齐真实 codex（app-server/src/request_processors/turn_processor.rs
    // turn_steer_inner：NoActiveTurn/NotIdle → invalid_request "no active
    // turn to steer"，code -32600）。turn 已结束后的 steer 不冷启动新 turn，
    // 由手机端自行决定后续（改走 turn/start）。
    throw new SimMethodError(-32600, "no active turn to steer");
  }

  private turnInterrupt(p: AnyParams): unknown {
    const state = this.threadState(p);
    if (state.sim && !state.sim.ended) {
      this.finishSimTurn(state, "interrupted");
      // 中止后线程空闲，on_thread_idle 以 Interrupted cause 触发（core/tasks/
      // lifecycle.rs:58-83）：queue 扩展跳过（排队消息不自动开跑，queue/service.rs
      // :551），goal 扩展不检查 cause 照常续跑（goal/extension.rs:180-193）。
      // 故此处只续跑 goal，不 consumeQueue。
      state.interrupted = true;
      this.continueGoalIfIdle(state);
    }
    return {};
  }

  private queueAdd(p: AnyParams): unknown {
    const state = this.threadState(p);
    const input = normalizeInput(p.input);
    const queued: QueuedSubmission = {
      id: uuidv7(),
      input,
      clientUserMessageId: p.clientUserMessageId ?? null,
    };
    state.queue.push(queued);
    this.persistState();
    this.emitSoon("thread/queue/changed", { threadId: state.thread.id }, state.thread.id);
    // 空闲线程入队即唤醒开跑（queue/service.rs enqueue → wake_if_loaded → idle
    // lifecycle → dispatch_if_idle，一次一条）：线程忙时由当前 turn 收尾链的
    // consumeQueue 消费；用户刚中止（Interrupted）时 wake 跳过，排队消息挂起
    // 等待下一次 turn（queue/service.rs:476-483）。
    if (!state.sim && !state.interrupted) {
      this.consumeQueue(state);
    }
    return { queuedSubmission: { id: queued.id, input, clientUserMessageId: queued.clientUserMessageId } };
  }

  /**
   * thread/queue/delete：按 queuedSubmissionId 删除队列条目（对齐 codex
   * thread_queue_processor.rs:161-172 + 协议 v2/thread.rs ThreadQueueDeleteParams，
   * camelCase 参数名 threadId + queuedSubmissionId）。找不到返回 {deleted:false}。
   */
  private queueDelete(p: AnyParams): unknown {
    const state = this.threadState(p);
    const index = state.queue.findIndex((q) => q.id === p.queuedSubmissionId);
    if (index < 0) {
      return { deleted: false };
    }
    state.queue.splice(index, 1);
    this.persistState();
    this.emitSoon("thread/queue/changed", { threadId: state.thread.id }, state.thread.id);
    return { deleted: true };
  }

  private beginSimTurn(
    state: ThreadState,
    input: TextContent[],
    clientUserMessageId: string | null,
    titleMaxLength: number | null = null,
  ): SimTurnRuntime {
    const userText = input.map((c) => c.text).join("");
    const turn = makeTurn("inProgress");
    turn.items = [];
    const sim: SimTurnRuntime = { turn, timers: new Set(), steerInputs: [], steerStopRequested: false, ended: false, kind: "normal", goalEndStatus: null };
    state.sim = sim;
    state.interrupted = false; // 新 turn 开跑即清除中止态（AgentStatus 离开 Interrupted）
    state.thread.turns.push(turn);
    state.thread.status = { type: "active", activeFlags: [] };
    // 标题生成 turn 的 preview 用提取的标题（手机以该 turn 的 JSON 输出更新任务标题）
    state.thread.preview =
      titleMaxLength != null
        ? titleForPrompt(userText, titleMaxLength)
        : userText.slice(0, 80) || state.thread.preview;

    // Plan 模式在 turn 开始时快照（对齐 codex turn_context 快照语义）
    const planMode = state.thread.collaborationMode.mode === "plan";
    const userItem = makeUserMessage(userText, clientUserMessageId);
    const startedAtMs = Date.now();
    state.items.push({ turnId: turn.id, item: userItem, startedAtMs, completedAtMs: startedAtMs });
    turn.items.push(userItem);

    // turn/start 的响应必须先于本 turn 的通知到达手机：
    // 真实 codex 的 userMessage item 事件比响应晚 ~600ms，手机依赖该次序把本地
    // 回显与服务器 item 对账；通知先于响应上线会让对账失败 → 用户消息双渲染
    // （2026-09-25 真机复现，docs/research/07）。通知推迟一个宏任务发射——
    // 微任务不可用：可能仍先于 dispatchMessage 写响应。
    this.schedule(sim, () => {
      this.emit("event", this.notification("thread/status/changed", {
        threadId: state.thread.id,
        status: { type: "active", activeFlags: [] },
      }, state.thread.id));
      this.emit("event", this.notification("turn/started", {
        threadId: state.thread.id,
        // 真实 turn/started 不带 items：userMessage 只经 item 事件下发
        turn: { ...this.serializeTurn(turn), items: [], itemsView: "notLoaded" as const },
      }, state.thread.id));
      this.emit("event", this.notification("item/started", {
        item: userItem,
        threadId: state.thread.id,
        turnId: turn.id,
        startedAtMs,
      }, state.thread.id));
      this.emit("event", this.notification("item/completed", {
        item: userItem,
        threadId: state.thread.id,
        turnId: turn.id,
        completedAtMs: startedAtMs,
      }, state.thread.id));

      // agentMessage：流式模拟回复；特殊指令 test steer / test queue 走
      // 「3 条消息 + 2 次模拟等待」脚本，help 在 buildReply 内返回帮助文本；
      // 标题生成 turn（outputSchema{title}）按契约回 JSON
      this.schedule(sim, () => {
        const finishTurn = () => {
          this.processSteers(state, sim, () => {
            if (planMode) this.emitPlanNotifications(state, sim);
            this.finishSimTurn(state, "completed");
            this.consumeQueue(state);
          });
        };
        if (titleMaxLength != null) {
          // 手机按 outputSchema 解析 agentMessage 文本；非 JSON 会让其 UI 流程挂起
          const reply = JSON.stringify({ title: titleForPrompt(userText, titleMaxLength) });
          this.streamAgentMessage(state, sim, reply, finishTurn);
          return;
        }
        const special = specialCommandOf(userText);
        if (special === "test-steer" || special === "test-queue") {
          this.runScriptedTurn(state, sim, special, finishTurn);
          return;
        }
        const reply = this.composeReply(state, userText);
        this.streamAgentMessage(state, sim, reply, finishTurn);
      }, this.opts.stepDelayMs);
    }, 0);
    return sim;
  }

  /** steer 输入入队；文本为「stop」（trim + 大小写不敏感）时置停止请求。 */
  private pushSteerInput(sim: SimTurnRuntime, text: string, clientUserMessageId: string | null): void {
    sim.steerInputs.push({ text, clientUserMessageId });
    if (text.trim().toLowerCase() === "stop") {
      sim.steerStopRequested = true;
    }
  }

  private processSteers(state: ThreadState, sim: SimTurnRuntime, done: () => void): void {
    // stop steer 优先于逐条回复：终止剩余脚本并直接收尾，done 链到此为止
    if (!sim.ended && sim.steerStopRequested) {
      this.handleSteerStop(state, sim);
      return;
    }
    const next = sim.steerInputs.shift();
    if (!next || sim.ended) {
      done();
      return;
    }
    const steerItem = makeUserMessage(next.text, next.clientUserMessageId);
    const at = Date.now();
    this.emit("event", this.notification("item/started", {
      item: steerItem,
      threadId: state.thread.id,
      turnId: sim.turn.id,
      startedAtMs: at,
    }, state.thread.id));
    this.emit("event", this.notification("item/completed", {
      item: steerItem,
      threadId: state.thread.id,
      turnId: sim.turn.id,
      completedAtMs: at,
    }, state.thread.id));
    state.items.push({ turnId: sim.turn.id, item: steerItem, startedAtMs: at, completedAtMs: at });
    sim.turn.items.push(steerItem);
    this.schedule(sim, () => {
      const reply = `（steer 注入）已收到插入指令：「${next.text}」。模拟层已按 steer 语义在当前 turn 内追加处理。`;
      this.streamAgentMessage(state, sim, reply, () => this.processSteers(state, sim, done));
    }, this.opts.stepDelayMs);
  }

  /**
   * steer 停止规则（test steer）：steer 输入「stop」在当前工具或消息步骤结束后
   * 生效——turn 剩余脚本（后续消息与 2 次 15 秒等待）不再执行。全部待处理 steer
   * 输入仍落为 userMessage item（保持手机端对账），但只回一条停止确认消息，随后
   * turn 以 completed 收尾并照常消费 thread 队列（排队消息不受影响）。
   */
  private handleSteerStop(state: ThreadState, sim: SimTurnRuntime): void {
    const pending = sim.steerInputs.splice(0);
    sim.steerStopRequested = false;
    for (const entry of pending) {
      const steerItem = makeUserMessage(entry.text, entry.clientUserMessageId);
      const at = Date.now();
      this.emit("event", this.notification("item/started", {
        item: steerItem,
        threadId: state.thread.id,
        turnId: sim.turn.id,
        startedAtMs: at,
      }, state.thread.id));
      this.emit("event", this.notification("item/completed", {
        item: steerItem,
        threadId: state.thread.id,
        turnId: sim.turn.id,
        completedAtMs: at,
      }, state.thread.id));
      state.items.push({ turnId: sim.turn.id, item: steerItem, startedAtMs: at, completedAtMs: at });
      sim.turn.items.push(steerItem);
    }
    this.schedule(sim, () => {
      if (sim.ended) return;
      const reply = "（steer注入）已按照steer规则停止原本的任务。";
      this.streamAgentMessage(state, sim, reply, () => {
        this.finishSimTurn(state, "completed");
        this.consumeQueue(state);
      });
    }, this.opts.stepDelayMs);
  }

  /**
   * test steer / test queue 特殊指令脚本：3 条 agentMessage，相邻两条之间各执行
   * 一次模拟命令 "wait 15 seconds"（真实等待 commandWaitMs，不经 shell）。每次
   * 等待结束后先处理等待期间到达的 steer（对齐真实 codex：steered userMessage
   * 在当前命令完成后出现在同一 turn 内），再发下一条脚本消息——保证测试窗口
   * 内发送的消息能观察到即时效果。steer「stop」例外：当前工具或消息步骤一结束
   * 就终止脚本（见 handleSteerStop），剩余等待与消息不再执行。
   */
  private runScriptedTurn(
    state: ThreadState,
    sim: SimTurnRuntime,
    kind: "test-steer" | "test-queue",
    done: () => void,
  ): void {
    const label = kind === "test-steer" ? "test steer" : "test queue";
    const hint =
      kind === "test-steer"
        ? "现在发送的消息会以 turn/steer 强制插入当前 turn，并在本次等待结束后立刻得到回复；发送 stop 会在当前步骤结束后停止本脚本。"
        : "现在发送的消息会经 thread/queue/add 排队，不打断当前 turn，turn 结束后自动开跑。";
    const messages = [
      `【${label} 1/3】turn 进行中，即将执行模拟命令 wait 15 seconds。${hint}`,
      `【${label} 2/3】第一次等待结束。${
        kind === "test-steer"
          ? "若刚才发送了消息，它应已作为 userMessage 插入上方并收到回复；可趁下一次等待再试。"
          : "排队中的消息将在 turn/completed 后自动启动为新 turn。"
      }`,
      `【${label} 3/3】脚本执行完毕，turn 即将结束，${kind === "test-steer" ? "steer 测试窗口关闭" : "若有排队消息它马上开跑"}。`,
    ];
    const step = (index: number): void => {
      if (sim.ended) return;
      this.streamAgentMessage(state, sim, messages[index]!, () => {
        if (index === messages.length - 1) {
          done();
          return;
        }
        if (sim.steerStopRequested) {
          // 消息流期间已收到 stop：本条消息结束即停止脚本，不进入下一次 15 秒等待
          this.processSteers(state, sim, () => step(index + 1));
          return;
        }
        this.simulateCommandWait(state, sim, () => {
          this.processSteers(state, sim, () => step(index + 1));
        });
      });
    };
    step(0);
  }

  /**
   * 模拟命令条目 "wait 15 seconds"：按真实 commandExecution 形状发 item 事件流
   * （started → outputDelta → completed，exitCode 0），等待 commandWaitMs，
   * 纯 setTimeout 不依赖 shell。条目同时入 turn.items 与 thread items 索引，
   * 手机端历史回看（items/list）同样可见。
   */
  private simulateCommandWait(
    state: ThreadState,
    sim: SimTurnRuntime,
    done: () => void,
    opts?: { command?: string; waitMs?: number },
  ): void {
    const command = opts?.command ?? "wait 15 seconds";
    const item = makeCommandExecution(command, state.thread.cwd);
    const startedAtMs = Date.now();
    this.emit("event", this.notification("item/started", {
      item,
      threadId: state.thread.id,
      turnId: sim.turn.id,
      startedAtMs,
    }, state.thread.id));
    this.schedule(sim, () => {
      if (sim.ended) return;
      const output = `（模拟命令 ${command} 完成，未调用 shell）`;
      const at = Date.now();
      this.emit("event", this.notification("item/commandExecution/outputDelta", {
        threadId: state.thread.id,
        turnId: sim.turn.id,
        itemId: item.id,
        delta: output,
      }, state.thread.id));
      const completed: CommandExecutionItem = {
        ...item,
        status: "completed",
        aggregatedOutput: output,
        exitCode: 0,
        durationMs: Math.max(1, at - startedAtMs),
      };
      this.emit("event", this.notification("item/completed", {
        item: completed,
        threadId: state.thread.id,
        turnId: sim.turn.id,
        completedAtMs: at,
      }, state.thread.id));
      state.items.push({ turnId: sim.turn.id, item: completed, startedAtMs, completedAtMs: at });
      sim.turn.items.push(completed);
      done();
    }, opts?.waitMs ?? this.opts.commandWaitMs);
  }

  private streamAgentMessage(state: ThreadState, sim: SimTurnRuntime, fullText: string, done: () => void): void {
    const agentItem = makeAgentMessage("");
    const startedAtMs = Date.now();
    this.emit("event", this.notification("item/started", {
      item: agentItem,
      threadId: state.thread.id,
      turnId: sim.turn.id,
      startedAtMs,
    }, state.thread.id));
    const chunks: string[] = [];
    for (let i = 0; i < fullText.length; i += this.opts.deltaChars) {
      chunks.push(fullText.slice(i, i + this.opts.deltaChars));
    }
    const emitDelta = (index: number): void => {
      if (sim.ended) return;
      if (index >= chunks.length) {
        const completed = { ...agentItem, text: fullText };
        const at = Date.now();
        this.emit("event", this.notification("item/completed", {
          item: completed,
          threadId: state.thread.id,
          turnId: sim.turn.id,
          completedAtMs: at,
        }, state.thread.id));
        state.items.push({ turnId: sim.turn.id, item: completed, startedAtMs, completedAtMs: at });
        sim.turn.items.push(completed);
        done();
        return;
      }
      this.emit("event", this.notification("item/agentMessage/delta", {
        threadId: state.thread.id,
        turnId: sim.turn.id,
        itemId: agentItem.id,
        delta: chunks[index]!,
      }, state.thread.id));
      this.schedule(sim, () => emitDelta(index + 1), this.opts.deltaIntervalMs);
    };
    this.schedule(sim, () => emitDelta(0), this.opts.deltaIntervalMs);
  }

  /**
   * 上下文占用快照（v2/thread.rs:1895-1901 ThreadTokenUsage）：total=会话累计
   * 占用（基线 + 用户/agent 消息 char 数，上限 257999；input=基线+用户侧字符，
   * output=agent 侧字符，二者之和恒等于 totalTokens），last=本轮新增字符。
   * 窗口上限取 MODEL_CONTEXT_WINDOW（258000）。
   */
  private contextUsageSnapshot(state: ThreadState, turnUserChars: number, turnAgentChars: number): SimTokenUsage {
    const totalTokens = Math.min(state.contextBaseline + state.contextUserChars + state.contextAgentChars, CONTEXT_CHARS_MAX);
    const inputTokens = Math.min(state.contextBaseline + state.contextUserChars, totalTokens);
    return {
      total: { totalTokens, inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: totalTokens - inputTokens, reasoningOutputTokens: 0 },
      last: { totalTokens: turnUserChars + turnAgentChars, inputTokens: turnUserChars, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: turnAgentChars, reasoningOutputTokens: 0 },
      modelContextWindow: MODEL_CONTEXT_WINDOW,
    };
  }

  private finishSimTurn(state: ThreadState, status: "completed" | "interrupted" | "failed"): void {
    const sim = state.sim;
    if (!sim || sim.ended) return;
    this.clearTimers(sim);
    sim.ended = true;
    const completedAt = Math.floor(Date.now() / 1000);
    sim.turn.status = status;
    sim.turn.completedAt = completedAt;
    sim.turn.durationMs = (completedAt - (sim.turn.startedAt ?? completedAt)) * 1000;
    sim.turn.itemsView = "summary";
    state.thread.status = { type: "idle" };
    state.thread.updatedAt = completedAt;
    state.thread.recencyAt = completedAt;
    this.emit("event", this.notification("thread/status/changed", {
      threadId: state.thread.id,
      status: { type: "idle" },
    }, state.thread.id));
    // goal 计量（extension.rs on_turn_stop → account_active_goal_progress）：active
    // goal 随每个 turn 累加用量并广播 thread/goal/updated（带 turnId）。goal turn
    // 结束时按模拟脚本写终态：阶段内继续轮保持 active（空闲后自动续跑），首轮阶段
    // 第 3 轮 → blocked，再启阶段 → complete（代替 LLM 的 update_goal 调用）；
    // 非 active（paused/blocked/complete…）不计量不发。cleared 只来自
    // thread/goal/clear RPC（thread_goal_processor.rs:294-299），turn 结束不发。
    if (state.goal && state.goal.status === "active") {
      state.goal.tokensUsed += GOAL_TURN_TOKENS;
      state.goal.timeUsedSeconds += Math.max(0, completedAt - (sim.turn.startedAt ?? completedAt));
      if (sim.kind === "goal" && sim.goalEndStatus) {
        state.goal.status = sim.goalEndStatus;
      }
      state.goal.updatedAt = completedAt;
      this.emit("event", this.notification("thread/goal/updated", {
        threadId: state.thread.id,
        turnId: sim.turn.id,
        goal: state.goal,
      }, state.thread.id));
    }
    // 上下文占用：compact 重置为 200 基线（压缩摘要占位，本轮内容不再累加）；
    // 其余 turn 按本轮 userMessage/agentMessage 字符累加（新会话基线 0）。
    let turnUserChars = 0;
    let turnAgentChars = 0;
    if (sim.kind === "compact") {
      state.contextUserChars = 0;
      state.contextAgentChars = 0;
      state.contextBaseline = CONTEXT_BASELINE_AFTER_COMPACT;
    } else {
      for (const item of sim.turn.items) {
        if (isUserMessageItem(item)) {
          const chars = item.content.reduce((sum, c) => sum + c.text.length, 0);
          state.contextUserChars += chars;
          turnUserChars += chars;
        } else if (isAgentMessageItem(item)) {
          state.contextAgentChars += item.text.length;
          turnAgentChars += item.text.length;
        }
      }
    }
    // tokenUsage 快照：先记录到线程状态（resume 补发用，跨重启持久化），再广播。
    const usage = this.contextUsageSnapshot(state, turnUserChars, turnAgentChars);
    state.tokenUsage = { turnId: sim.turn.id, usage };
    this.emit("event", this.notification("thread/tokenUsage/updated", {
      threadId: state.thread.id,
      turnId: sim.turn.id,
      tokenUsage: usage,
    }, state.thread.id));
    // 紧随 tokenUsage 的账户级限额滚动更新（bespoke_event_handling.rs:1581-1599
    // handle_token_count_event：ThreadTokenUsageUpdated 之后 AccountRateLimitsUpdated）。
    // 账户作用域广播，不带 threadId 路由。
    this.emit("event", this.notification("account/rateLimits/updated", {
      rateLimits: this.rateLimitSnapshot(),
    }));
    this.emit("event", this.notification("turn/completed", {
      threadId: state.thread.id,
      // 真实 turn/completed 只带 agentMessage 摘要项；带 userMessage 会导致手机端重复渲染用户消息
      turn: {
        ...this.serializeTurn(sim.turn),
        items: sim.turn.items.filter((item) => item.type === "agentMessage"),
        itemsView: "summary",
      },
    }, state.thread.id));
    state.sim = null;
    this.persistState();
  }

  private consumeQueue(state: ThreadState): void {
    const next = state.queue.shift();
    if (!next) {
      // 队列耗尽线程空闲：goal 仍 active 则自动续跑（extension.rs on_thread_idle）
      this.continueGoalIfIdle(state);
      return;
    }
    this.emit("event", this.notification("thread/queue/changed", { threadId: state.thread.id }, state.thread.id));
    this.schedule(null, () => {
      if (this.closed) return;
      // MB3 回调竞态：若等待窗口内已有活动 turn（如 compact/start 接管），不得
      // 覆盖 state.sim——把消息放回队首，交由当前 turn 的收尾链再消费。
      if (state.sim && !state.sim.ended) {
        state.queue.unshift(next);
        return;
      }
      this.beginSimTurn(state, next.input, next.clientUserMessageId);
    }, this.opts.stepDelayMs);
  }

  private buildReply(userText: string, thread: ThreadRecord): string {
    if (specialCommandOf(userText) === "help") {
      return HELP_TEXT;
    }
    const namingTitle = this.namingTitleReplyOf(userText, thread);
    if (namingTitle !== null) {
      return namingTitle;
    }
    return [
      `已收到消息：「${userText}」。`,
      "",
      "这是 bridge 模拟层的固定回复（未接 LLM，程序侧生成）：",
      `- 线程：${thread.id}`,
      `- 工作目录：${thread.cwd}`,
      `- 模型：${thread.model}（模拟）`,
      "",
      "用于验证手机 → wham 后端 → 桥 → 手机的完整数据链路。",
    ].join("\n");
  }

  /**
   * 起名兜底：ephemeral 线程上带 "User prompt:\n<首条消息>" marker 的输入 →
   * ≤36 字符单行标题；其余（side conversation 等真实 ephemeral 对话）返回
   * null 走标准回复。真机帧证据：起名 turn 12/12 带 outputSchema{title}+
   * turnTrigger=remote_ios（走 titleSchemaOf 的 JSON 分支，到不了这里）；
   * ephemeral 且无 marker 的输入历史上只出现在 side chat（2026-09-27 帧证：
   * 回复被截成原文 36 字符即此兜底误伤）。旧「无 marker 时用整段文本当标题」
   * 的回退据此删除。
   */
  private namingTitleReplyOf(userText: string, thread: ThreadRecord): string | null {
    if (!thread.ephemeral) return null;
    const m = userText.match(/User prompt:\s*([\s\S]+)$/);
    if (!m) return null;
    const firstLine = m[1]!.trim().split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
    const title = firstLine.replace(/["`*#]/g, "").trim().slice(0, 36);
    return title.length > 0 ? title : "模拟任务";
  }

  /**
   * 组装普通 turn 的 agentMessage 文本：在 buildReply 正文前按序叠加模拟钩子行。
   * - justCompacted：compact 后**下一条**普通 turn 的首行「刚刚经历过compact」，用后即清；
   * - Plan 模式：线程 collaborationMode.mode==="plan" 时前缀「【Plan 模式（模拟）】」；
   * - 技能：输入含 `$名` 且名 ∈ SKILLS → 一行「已加载技能 $名（模拟）。」。
   * help 与起名兜底回复保持原样（不叠加钩子，既有断言不受影响）；side
   * conversation 等普通 ephemeral 对话照常叠加。
   */
  private composeReply(state: ThreadState, userText: string): string {
    const base = this.buildReply(userText, state.thread);
    if (specialCommandOf(userText) === "help" || this.namingTitleReplyOf(userText, state.thread) !== null) {
      return base;
    }
    const lines: string[] = [];
    if (state.justCompacted) {
      lines.push("刚刚经历过compact");
      state.justCompacted = false;
    }
    if (state.thread.collaborationMode.mode === "plan") {
      lines.push("【Plan 模式（模拟）】");
    }
    const skillLine = this.skillLineFor(userText);
    if (skillLine) lines.push(skillLine);
    return lines.length > 0 ? `${lines.join("\n")}\n${base}` : base;
  }

  /** $技能名 钩子：命中 data.ts 现有技能列表则确认加载。 */
  private skillLineFor(userText: string): string | null {
    for (const group of SKILLS.data) {
      for (const skill of group.skills) {
        if (userText.includes(`$${skill.name}`)) {
          return `已加载技能 $${skill.name}（模拟）。`;
        }
      }
    }
    return null;
  }

  /**
   * Plan 模式通知（流式完成后）：
   * - item/plan/delta：v2/item.rs:1444-1454 PlanDeltaNotification
   *   {threadId, turnId, itemId, delta}（experimental，注释明确「客户端不应假设
   *   拼接 delta 等于 completed plan item 内容」，故模拟发分片文本即可）；
   * - turn/plan/updated：v2/turn.rs:568-573 {threadId, turnId, explanation, plan}，
   *   plan 元素 {step, status}，status 取 TurnPlanStepStatus
   *   （v2/turn.rs:583-590：pending|inProgress|completed）。
   */
  private emitPlanNotifications(state: ThreadState, sim: SimTurnRuntime): void {
    const plan = [
      { step: "第一步：梳理任务", status: "completed" as const },
      { step: "第二步：等待用户确认", status: "pending" as const },
    ];
    const itemId = uuidv7();
    for (const step of plan) {
      this.emit("event", this.notification("item/plan/delta", {
        threadId: state.thread.id,
        turnId: sim.turn.id,
        itemId,
        delta: `${step.step}（${step.status}）\n`,
      }, state.thread.id));
    }
    this.emit("event", this.notification("turn/plan/updated", {
      threadId: state.thread.id,
      turnId: sim.turn.id,
      explanation: "模拟计划：展示 plan 通知形状",
      plan,
    }, state.thread.id));
  }

  // ---------------------------------------------------------------- goal 模拟

  /**
   * thread/goal/set（v2/thread.rs:847-871）：
   * - objective 单层 Option：缺省/null = 保留已有（无则空串）；
   * - status 缺省 = 已有或 "active"；
   * - tokenBudget 双层 Option：省略 = 不变，null = 清除，数字 = 设置；
   * upsert 后持久化并 emit thread/goal/updated {threadId, turnId:null, goal}
   * （v2/thread.rs:2008 ThreadGoalUpdatedNotification）。
   */
  private goalSet(p: AnyParams): { goal: SimGoal } {
    const state = this.threadState(p);
    const now = Math.floor(Date.now() / 1000);
    const existing = state.goal;
    if (!existing) {
      // 新 goal：轮种/轮次/阶段索引归零（goal/clear 亦归零）
      state.goalRunResume = false;
      state.goalTurnCount = 0;
      state.goalPhaseIndex = 0;
    }
    // codex 对 objective 做 trim（api.rs set_thread_goal：GoalObjectiveUpdate::Set → trim）
    const objective =
      p.objective === undefined || p.objective === null ? (existing?.objective ?? "") : String(p.objective).trim();
    // status 形状校验：codex 在 serde 反序列化层拒绝非法枚举值，sim 在此近似
    // （v2/thread.rs ThreadGoalStatus）。
    if (p.status !== undefined && p.status !== null && !(GOAL_STATUSES as readonly unknown[]).includes(p.status)) {
      throw new SimMethodError(-32600, `invalid goal status: ${String(p.status)}`);
    }
    const status: SimGoalStatus =
      p.status === undefined || p.status === null ? (existing?.status ?? "active") : (p.status as SimGoalStatus);
    let tokenBudget = existing?.tokenBudget ?? null;
    if ("tokenBudget" in p) {
      if (p.tokenBudget === null || p.tokenBudget === undefined) {
        tokenBudget = null;
      } else {
        // codex 在 serde 反序列化层要求数字，sim 近似：非有限数字一律 -32600。
        if (typeof p.tokenBudget !== "number" || !Number.isFinite(p.tokenBudget)) {
          throw new SimMethodError(-32600, "invalid tokenBudget");
        }
        tokenBudget = p.tokenBudget;
      }
    }
    const goal: SimGoal = {
      threadId: state.thread.id,
      objective,
      status,
      tokenBudget,
      tokensUsed: existing?.tokensUsed ?? 0,
      timeUsedSeconds: existing?.timeUsedSeconds ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    state.goal = goal;
    // 请求携带 objective 且线程 preview 为空时用 objective 填充
    // （api.rs set_thread_goal → fill_empty_thread_preview_if_possible，
    // tool.rs:473 set_thread_preview_if_empty）。
    if (p.objective !== undefined && p.objective !== null && state.thread.preview === "") {
      state.thread.preview = objective;
    }
    this.persistState();
    // 响应先行：goal 通知用**宏任务**补发（与 resume goal 快照同模式，见 threadResume
    // 注释）。禁用 emitSoon 微任务：微任务可能仍先于 dispatchMessage 写响应，违反
    // codex thread_goal_processor.rs:235-242（set）/ :294-299（clear）的响应先行。
    this.schedule(null, () => {
      if (this.closed) return;
      this.emit("event", this.notification("thread/goal/updated", { threadId: state.thread.id, turnId: null, goal }, state.thread.id));
    }, 0);
    // active goal 且线程空闲 → 立即自动续跑（runtime.rs apply_external_goal_set →
    // continue_if_idle → start_turn_if_idle，turn_trigger "goal"；忙时由当前 turn
    // 收尾链的 consumeQueue 触发，对齐 on_thread_idle）。轮种：从 blocked 再次
    // 激活 = 再启阶段（1 轮 → complete），其余（新目标 / paused / complete /
    // active 重设）= 首轮阶段（3 轮链式 → 第 3 轮 blocked）。每次激活阶段索引
    // 归零（阶段重开）。
    if (goal.status === "active") {
      state.goalRunResume = existing?.status === "blocked";
      state.goalPhaseIndex = 0;
      this.continueGoalIfIdle(state);
    }
    return { goal };
  }

  private goalGet(p: AnyParams): { goal: SimGoal | null } {
    return { goal: this.threadState(p).goal };
  }

  /** thread/goal/clear（v2/thread.rs:887）：无 goal {cleared:false}；有则清除并 emit。 */
  private goalClear(p: AnyParams): { cleared: boolean } {
    const state = this.threadState(p);
    if (!state.goal) return { cleared: false };
    state.goal = null;
    state.goalRunResume = false;
    state.goalTurnCount = 0;
    state.goalPhaseIndex = 0;
    this.persistState();
    // 响应先行（同 goalSet）：goal/cleared 用宏任务补发，避免微任务抢在响应之前。
    this.schedule(null, () => {
      if (this.closed) return;
      this.emit("event", this.notification("thread/goal/cleared", { threadId: state.thread.id }, state.thread.id));
    }, 0);
    return { cleared: true };
  }

  /**
   * goal 续跑检查（runtime.rs continue_if_idle / extension.rs on_thread_idle）：
   * 线程空闲且 goal 仍为 active 时自动开跑一轮 goal turn。codex 的 continue_if_idle
   * 不检查 app-server 消息队列、也不区分 idle cause（用户中止后照跑）——队列优先
   * 由 hook 注册顺序保证（extensions.rs queue 先注册，Completed 空闲时队列先抢到
   * idle；sim 中对应 consumeQueue 先 shift 队列，队列空才走到这里）。等待窗口的
   * 回调重查仍保留队列检查：窗口内若队列非空（如 queue/add 唤醒在途），让位给
   * 队列开跑，本轮 goal 续跑由队列消息的收尾链再触发。sim 无模型，goal turn 按
   * 模拟脚本写终态（blocked/complete），循环有界。
   */
  private continueGoalIfIdle(state: ThreadState): void {
    if (this.closed || state.sim) return;
    if (!state.goal || state.goal.status !== "active") return;
    this.schedule(null, () => {
      // 回调内重查：等待窗口内可能出现新 turn / 排队消息 / goal 被清除或暂停。
      // 队列让位仅限非中止态：用户中止后 queue 扩展本身被跳过（Interrupted
      // cause），goal 续跑不因队列非空而搁置，否则线程将无推进者。
      if (this.closed || state.sim) return;
      if (!state.interrupted && state.queue.length > 0) return;
      if (!state.goal || state.goal.status !== "active") return;
      this.beginGoalTurn(state);
    }, this.opts.stepDelayMs);
  }

  /**
   * goal 续跑 turn（runtime.rs continue_if_idle → start_turn_if_idle，
   * turn_trigger "goal"）：输入是隐藏内部上下文（steering.rs
   * continuation_steering_item → ContextualUserFragment，不下发客户端），故本
   * turn 无 userMessage item。每个 goal turn = 一个模拟 wait + 一条 agentMessage；
   * 首轮阶段共 3 个 goal turn（前 2 个结束保持 active，经 on_thread_idle 链式
   * 自动续跑，第 3 个标记 blocked），再启阶段 1 个（标记 complete）——整个目标
   * 生命周期共 4 个 goal turn。wait 时长按 goal turn 总轮次：第 2 个（blocked
   * 前）30 秒，其余 10 秒。可被 steer（含 stop 规则；停止只终止当前 turn，
   * goal 仍 active 时按 codex 语义继续续跑）。
   */
  private beginGoalTurn(state: ThreadState): SimTurnRuntime {
    const turn = makeTurn("inProgress");
    turn.items = [];
    const resume = state.goalRunResume;
    const phaseIndex = state.goalPhaseIndex;
    state.goalPhaseIndex += 1;
    const objective = state.goal?.objective ?? "";
    let message: string;
    let goalEndStatus: "blocked" | "complete" | null;
    if (resume) {
      message = `（goal）已重新启动目标：「${objective}」，sim 层续跑本轮；结束后将标记为 complete。`;
      goalEndStatus = "complete";
    } else if (phaseIndex === 0) {
      message = `（goal 1/3）已接收目标：「${objective}」，开始执行。`;
      goalEndStatus = null; // 保持 active，空闲后自动续跑第 2 个 goal turn
    } else if (phaseIndex === 1) {
      message = "（goal 2/3）执行中……";
      goalEndStatus = null; // 保持 active，空闲后自动续跑第 3 个 goal turn
    } else {
      message = "（goal 3/3）本轮结束，目标标记为 blocked；再次启动目标将继续（1 条输出后完成）。";
      goalEndStatus = "blocked";
    }
    const sim: SimTurnRuntime = { turn, timers: new Set(), steerInputs: [], steerStopRequested: false, ended: false, kind: "goal", goalEndStatus };
    // 轮次计数：第 2 个 goal turn（blocked 前）的模拟 wait 为 30 秒，其余 10 秒
    const round = (state.goalTurnCount += 1);
    const waitSeconds = round === 2 ? 30 : 10;
    state.sim = sim;
    state.interrupted = false; // 新 turn 开跑即清除中止态（AgentStatus 离开 Interrupted）
    state.thread.turns.push(turn);
    state.thread.status = { type: "active", activeFlags: [] };
    this.schedule(sim, () => {
      this.emit("event", this.notification("thread/status/changed", {
        threadId: state.thread.id,
        status: { type: "active", activeFlags: [] },
      }, state.thread.id));
      this.emit("event", this.notification("turn/started", {
        threadId: state.thread.id,
        turn: { ...this.serializeTurn(turn), items: [], itemsView: "notLoaded" as const },
      }, state.thread.id));
      this.schedule(sim, () => {
        // 每个 goal turn 先执行模拟 wait，等待结束排水 steer（stop 在此生效）
        this.simulateCommandWait(state, sim, () => {
          this.processSteers(state, sim, () => {
            this.streamAgentMessage(state, sim, message, () => {
              this.processSteers(state, sim, () => {
                this.finishSimTurn(state, "completed");
                this.consumeQueue(state);
              });
            });
          });
        }, {
          command: `wait ${waitSeconds} seconds`,
          waitMs: Math.max(1, Math.round((waitSeconds * this.opts.commandWaitMs) / 15)),
        });
      }, this.opts.stepDelayMs);
    }, 0);
    return sim;
  }

  // -------------------------------------------------------------- compact 模拟

  /**
   * thread/compact/start（v2/thread.rs:1148-1156 → {}）：对齐 codex
   * session/handlers.rs:244-251——先 abort_all_tasks(Replaced) 打断活动 turn
   * （无 busy 报错），再 spawn CompactTask。
   *
   * 打断**不得**走 beginSimTurn 的收尾链、不触发 consumeQueue（S01 同类孤儿定时器
   * 缺陷不复燃）：直接 finishSimTurn(state, "interrupted")；随后 compact turn 完成时
   * 由自身收尾链 consumeQueue 恢复队列消费。
   *
   * compact turn：新 sim(kind compact)+turn 记录，emit thread/status/changed(active)
   * + turn/started（items 空，同 beginSimTurn 发射模式）→ item/started
   * {item:{type:"contextCompaction",id}} → schedule(compactWaitMs) → item/completed
   * → finishSimTurn(completed) → state.justCompacted=true → consumeQueue。
   */
  private compactStart(p: AnyParams): unknown {
    const state = this.threadState(p);
    if (state.sim && !state.sim.ended) {
      this.finishSimTurn(state, "interrupted");
    }
    const turn = makeTurn("inProgress");
    turn.items = [];
    const sim: SimTurnRuntime = { turn, timers: new Set(), steerInputs: [], steerStopRequested: false, ended: false, kind: "compact", goalEndStatus: null };
    state.sim = sim;
    state.interrupted = false; // 新 turn 开跑即清除中止态（AgentStatus 离开 Interrupted）
    state.thread.turns.push(turn);
    state.thread.status = { type: "active", activeFlags: [] };

    this.schedule(sim, () => {
      this.emit("event", this.notification("thread/status/changed", {
        threadId: state.thread.id,
        status: { type: "active", activeFlags: [] },
      }, state.thread.id));
      this.emit("event", this.notification("turn/started", {
        threadId: state.thread.id,
        turn: { ...this.serializeTurn(turn), items: [], itemsView: "notLoaded" as const },
      }, state.thread.id));
      const item: ContextCompactionItem = { type: "contextCompaction", id: uuidv7() };
      const startedAtMs = Date.now();
      this.emit("event", this.notification("item/started", {
        item,
        threadId: state.thread.id,
        turnId: turn.id,
        startedAtMs,
      }, state.thread.id));
      this.schedule(sim, () => {
        if (sim.ended) return;
        const completedAtMs = Date.now();
        this.emit("event", this.notification("item/completed", {
          item,
          threadId: state.thread.id,
          turnId: turn.id,
          completedAtMs,
        }, state.thread.id));
        state.items.push({ turnId: turn.id, item, startedAtMs, completedAtMs });
        turn.items.push(item);
        this.finishSimTurn(state, "completed");
        state.justCompacted = true;
        this.consumeQueue(state);
      }, this.opts.compactWaitMs);
    }, 0);
    return {};
  }

  // ----------------------------------------------------------- shell / 后台终端

  /**
   * thread/shellCommand（v2/thread.rs:1160-1178）：空 command → -32600
   * "command must not be empty"；有效命令立即回 {}，随后异步下发 commandExecution
   * item 事件流（item/started → outputDelta → item/completed，exitCode 0）。
   * 归属：无活动 turn 时创建轻量 shell turn（同 compact 机制，kind normal，含
   * status active/turn/started…turn/completed 全序）；有活动 turn 时条目直接挂当前
   * turn（不发 turn/started）。
   */
  private shellCommand(p: AnyParams): unknown {
    const state = this.threadState(p);
    const command = typeof p.command === "string" ? p.command : "";
    if (command.length === 0) {
      throw new SimMethodError(-32600, "command must not be empty");
    }
    const item = makeCommandExecution(command, state.thread.cwd);
    const attached = state.sim && !state.sim.ended ? state.sim : null;
    const sim = attached ?? this.beginShellTurn(state);
    const turnId = sim.turn.id;
    const startedAtMs = Date.now();
    this.schedule(sim, () => {
      // NIT 守卫：同一 tick 内 interrupt/compact 已结束本 turn 时不得让已完成 turn
      // 复活（正常情况下 finishSimTurn 会清掉本定时器，此处为双保险）。
      if (sim.ended) return;
      if (!attached) {
        this.emit("event", this.notification("thread/status/changed", {
          threadId: state.thread.id,
          status: { type: "active", activeFlags: [] },
        }, state.thread.id));
        this.emit("event", this.notification("turn/started", {
          threadId: state.thread.id,
          turn: { ...this.serializeTurn(sim.turn), items: [], itemsView: "notLoaded" as const },
        }, state.thread.id));
      }
      this.emit("event", this.notification("item/started", {
        item,
        threadId: state.thread.id,
        turnId,
        startedAtMs,
      }, state.thread.id));
      // attached 时完成定时器**不挂父 turn**：finishSimTurn 会清理 sim.timers，父 turn 在
      // shellWaitMs 内自然结束（非打断）会把本定时器一并清掉 → item/started 永不终结、
      // backgroundTerminals 漏登记（评审 F2）。改挂无 turn 定时器后回调仍会触发，由
      // sim.ended 分支补发终态。独立 shell turn 仍挂自身 sim（turn 结束即取消补发）。
      this.schedule(attached ? null : sim, () => {
        if (sim.ended) {
          if (!attached) return; // 独立 shell turn 已收尾：条目随 turn 结束，不补发
          // F2：attached 且父 turn 先于 shellWaitMs 结束（自然完成/打断）。命令未跑完 →
          // 条目以 failed 终态补发，对齐 codex 取消路径 core/src/tasks/user_shell.rs:247-274：
          // status CommandExecutionStatus::Failed + exit_code -1 + aggregated_output
          // "command aborted by user"（wire 枚举 app-server-protocol/.../v2/item.rs:1074-1082
          // 只有 InProgress|Completed|Failed|Declined，无 Interrupted，故不得下发 interrupted），
          // durationMs 实测；并登记为后台终端——条目在 turn 结束后仍存活，正是「后台终端」语义
          // （v2/thread.rs:1215-1224），list/terminate/clean 因此可用。条目仍计入 items
          // 索引，turnId 用父 turn id。
          const abortedAtMs = Date.now();
          const aborted: CommandExecutionItem = {
            ...item,
            status: "failed",
            aggregatedOutput: "command aborted by user（模拟：父 turn 已结束）",
            exitCode: -1,
            durationMs: Math.max(1, abortedAtMs - startedAtMs),
          };
          this.emit("event", this.notification("item/completed", {
            item: aborted,
            threadId: state.thread.id,
            turnId,
            completedAtMs: abortedAtMs,
          }, state.thread.id));
          state.items.push({ turnId, item: aborted, startedAtMs, completedAtMs: abortedAtMs });
          state.backgroundTerminals.push({
            itemId: item.id,
            processId: item.processId,
            command,
            cwd: state.thread.cwd,
          });
          return;
        }
        const output = `（模拟 shell）$ ${command}\n（未调用真实 shell）`;
        const completedAtMs = Date.now();
        this.emit("event", this.notification("item/commandExecution/outputDelta", {
          threadId: state.thread.id,
          turnId,
          itemId: item.id,
          delta: output,
        }, state.thread.id));
        const completed: CommandExecutionItem = {
          ...item,
          status: "completed",
          aggregatedOutput: output,
          exitCode: 0,
          durationMs: Math.max(1, completedAtMs - startedAtMs),
        };
        this.emit("event", this.notification("item/completed", {
          item: completed,
          threadId: state.thread.id,
          turnId,
          completedAtMs,
        }, state.thread.id));
        state.items.push({ turnId, item: completed, startedAtMs, completedAtMs });
        sim.turn.items.push(completed);
        state.backgroundTerminals.push({
          itemId: item.id,
          processId: item.processId,
          command,
          cwd: state.thread.cwd,
        });
        if (!attached) {
          // 独立 shell turn 收尾走普通 turn 收尾链（评审 F1）：先排水 steer
          // （对齐 codex core/src/tasks/user_shell.rs TaskKind::Regular 可 steer——steer
          // 输入在 shell 命令完成后作为 userMessage 注入同一 turn），再 finish + queue。
          // 此前直接 finish 会吞掉 turnStart/turnSteer 注入的 sim.steerInputs。
          this.processSteers(state, sim, () => {
            this.finishSimTurn(state, "completed");
            this.consumeQueue(state);
          });
        }
      }, this.opts.shellWaitMs);
    }, 0);
    return {};
  }

  /** 无活动 turn 时的轻量 shell turn：不造 userMessage，仅承载 commandExecution 条目。 */
  private beginShellTurn(state: ThreadState): SimTurnRuntime {
    const turn = makeTurn("inProgress");
    turn.items = [];
    const sim: SimTurnRuntime = { turn, timers: new Set(), steerInputs: [], steerStopRequested: false, ended: false, kind: "normal", goalEndStatus: null };
    state.sim = sim;
    state.interrupted = false; // 新 turn 开跑即清除中止态（AgentStatus 离开 Interrupted）
    state.thread.turns.push(turn);
    state.thread.status = { type: "active", activeFlags: [] };
    return sim;
  }

  /** thread/backgroundTerminals/list（v2/thread.rs:1209-1243）。 */
  private backgroundTerminalsList(p: AnyParams): unknown {
    const state = this.threadState(p);
    return {
      data: state.backgroundTerminals.map((t) => ({
        itemId: t.itemId,
        processId: t.processId,
        command: t.command,
        cwd: t.cwd,
        osPid: null,
        cpuPercent: null,
        rssKb: null,
      })),
      nextCursor: null,
    };
  }

  /** thread/backgroundTerminals/terminate（v2/thread.rs:1245-1253）：processId 必须为整数串。 */
  private backgroundTerminalsTerminate(p: AnyParams): { terminated: boolean } {
    const state = this.threadState(p);
    const pid = p.processId;
    if (typeof pid !== "string" || !/^-?\d+$/.test(pid)) {
      throw new SimMethodError(-32600, `invalid process id: ${String(pid)}`);
    }
    const index = state.backgroundTerminals.findIndex((t) => t.processId === pid);
    if (index < 0) return { terminated: false };
    state.backgroundTerminals.splice(index, 1);
    return { terminated: true };
  }

  /** thread/backgroundTerminals/clean（v2/thread.rs:1197）。 */
  private backgroundTerminalsClean(p: AnyParams): unknown {
    this.threadState(p).backgroundTerminals.length = 0;
    return {};
  }

  // --------------------------------------------------------------- 分支 / 元数据

  /**
   * thread/metadata/update（v2/thread.rs:1008-1067）：三字段全缺 → -32600；
   * gitInfo 存在但三字段全缺 → -32600；projectId 非空字符串 → -32600
   * "project not found: {id}"（sim 无 projects）；sha/branch/originUrl 双层
   * （缺省=不变、null=清除、非空字符串=设置；空串报错，sim 近似）。
   * originUrl 不做远端消毒（记录偏差）。
   */
  private metadataUpdate(p: AnyParams): { thread: ThreadRecord } {
    const state = this.threadState(p);
    const hasProject = "projectId" in p;
    const hasGit = "gitInfo" in p;
    const hasDaybreak = "daybreakEnabled" in p;
    if (!hasProject && !hasGit && !hasDaybreak) {
      throw new SimMethodError(-32600, "thread metadata update must include at least one field");
    }

    const previousProjectId = state.thread.projectId;
    if (hasGit) {
      const raw = p.gitInfo as Record<string, unknown> | null;
      if (raw === null || raw === undefined) {
        state.thread.gitInfo = null;
      } else {
        const keys = ["sha", "branch", "originUrl"] as const;
        if (!keys.some((k) => k in raw)) {
          throw new SimMethodError(-32600, "gitInfo must include at least one field");
        }
        const next: ThreadGitInfo = {
          sha: state.thread.gitInfo?.sha ?? null,
          branch: state.thread.gitInfo?.branch ?? null,
          originUrl: state.thread.gitInfo?.originUrl ?? null,
        };
        for (const key of keys) {
          if (!(key in raw)) continue;
          const value = raw[key];
          if (value === null) {
            next[key] = null;
          } else if (typeof value === "string") {
            if (value.length === 0) {
              throw new SimMethodError(-32600, `gitInfo.${key} must not be empty`);
            }
            next[key] = value;
          } else {
            throw new SimMethodError(-32600, `gitInfo.${key} must be a string or null`);
          }
        }
        state.thread.gitInfo = next;
      }
    }
    if (hasProject) {
      const value = p.projectId;
      if (value === null || value === undefined || value === "") {
        state.thread.projectId = null;
      } else {
        throw new SimMethodError(-32600, `project not found: ${String(value)}`);
      }
    }
    if (hasDaybreak) {
      state.thread.daybreakEnabled = p.daybreakEnabled === null || p.daybreakEnabled === undefined
        ? state.thread.daybreakEnabled
        : Boolean(p.daybreakEnabled);
    }
    this.persistState();
    if (state.thread.projectId !== previousProjectId) {
      this.emitSoon(
        "thread/project/updated",
        { threadId: state.thread.id, projectId: state.thread.projectId },
        state.thread.id,
      );
    }
    return { thread: this.serializeThread(state.thread, []) };
  }

  /**
   * thread/fork（v2/thread.rs:544-678）：新线程继承 name/cwd/model/reasoningEffort/
   * gitInfo/collaborationMode/projectId，forkedFromId=源 id；历史按 lastTurnId 截断
   * （含该 turn），不给则全量；队列不复制。ephemeral=true 仅内存、不进列表。
   * ForkResponse 无 collaborationMode 字段（v2/thread.rs:632-678），此处直接复用
   * threadContext 形状。
   */
  private threadFork(p: AnyParams): unknown {
    const source = this.threadState(p);
    const fork = makeThread({ cwd: p.cwd ?? source.thread.cwd });
    fork.name = source.thread.name;
    fork.model = p.model ?? source.thread.model;
    fork.reasoningEffort = source.thread.reasoningEffort;
    fork.gitInfo = source.thread.gitInfo ? { ...source.thread.gitInfo } : null;
    fork.collaborationMode = {
      mode: source.thread.collaborationMode.mode,
      settings: { ...source.thread.collaborationMode.settings },
    };
    fork.projectId = source.thread.projectId;
    fork.forkedFromId = source.thread.id;
    fork.ephemeral = p.ephemeral === true;

    let sourceTurns = source.thread.turns;
    if (p.lastTurnId !== undefined && p.lastTurnId !== null) {
      const index = sourceTurns.findIndex((t) => t.id === p.lastTurnId);
      if (index < 0) {
        // 近似：真实 codex 报 invalid_request；模拟层同码同文案
        throw new SimMethodError(-32600, `unknown turn id: ${String(p.lastTurnId)}`);
      }
      sourceTurns = sourceTurns.slice(0, index + 1);
    }
    const turnIds = new Set(sourceTurns.map((t) => t.id));
    fork.turns = sourceTurns.map((t) => ({ ...t, items: [...t.items] }));
    // turnId 为 null 的条目（零 turn 线程上注入的项）不属于任何被复制的 turn，
    // 近似地从 fork 中省略（真实 codex 按 rollout 原样重放全史）。
    const items = source.items
      .filter((e) => e.turnId !== null && turnIds.has(e.turnId))
      .map((e) => ({ ...e, item: e.item }));

    const forkState = makeThreadState(fork, items);
    // 历史整体继承 → 上下文计数与最近 tokenUsage 快照随 rollout 复制（真实
    // codex 的 fork 重放源 rollout，TokenCount 记录随之带入；lastTurnId 截断
    // 场景为近似）。resume 补发据此还原 side chat 继承的父线程占用。
    forkState.contextUserChars = source.contextUserChars;
    forkState.contextAgentChars = source.contextAgentChars;
    forkState.contextBaseline = source.contextBaseline;
    forkState.tokenUsage = source.tokenUsage
      ? { turnId: source.tokenUsage.turnId, usage: source.tokenUsage.usage }
      : null;
    this.threads.set(fork.id, forkState);
    if (!fork.ephemeral) {
      this.persistState();
    }
    this.emitSoon("thread/started", { thread: this.serializeThread(fork, []) });
    // threadContext 固定以 turns:[] 序列化（thread/start 用）；fork 需带回截断历史，
    // 故覆盖 thread 为实值，保持 ForkResponse 其余 13 键形状不变。excludeTurns=true
    // 时只回元数据不填充 turns（v2/thread.rs:608-612，客户端随即用 turns/items
    // list 分页拉取）——App 的 side conversation 即走此路径。
    const context = this.threadContext(fork);
    context.thread = this.serializeThread(fork, p.excludeTurns === true ? [] : fork.turns);
    return context;
  }

  /**
   * thread/name/set（v2/thread.rs:782-797；thread_processor.rs:1836-1864）：
   * 名字 trim 归一化（core/src/util.rs:90-97），空名 -32600；写元数据后响应 {}，
   * 随后广播 thread/name/updated{threadId, threadName}（common.rs:1927）——
   * 响应先于通知（thread_set_name 先 send_response 再发通知）。
   */
  private threadNameSet(p: AnyParams): unknown {
    const state = this.threadState(p);
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) {
      throw new SimMethodError(-32600, "thread name must not be empty");
    }
    state.thread.name = name;
    this.persistState();
    this.emitSoon(
      "thread/name/updated",
      { threadId: state.thread.id, threadName: name },
      state.thread.id,
    );
    return {};
  }

  /**
   * thread/inject_items（v2/thread.rs:1691-1700；turn_processor.rs:974-1003 +
   * core/src/codex_thread.rs:738-784）：把原始 Responses API items 追加进线程
   * 模型可见历史——不起 turn、无任何通知，响应 {}。App 的 side conversation
   * 在 fork(excludeTurns) 后、首个 turn/start 前用它注入边界指令；缺这条 RPC
   * 会让 side chat 启动直接报「Codex 服务器返回了错误」（2026-09-26 真机）。
   * message/role=user → userMessage、role=assistant → agentMessage，其余变体
   * 原样保存；注入的 user/assistant 字符即时计入上下文占用（真实 codex 的
   * 下一轮 TokenCount 会带上这段历史）。turnId 归属最近一个 turn（无 turn 时
   * null：items/list 全量查询仍可见，按 turn 过滤的查询不包含）。
   */
  private threadInjectItems(p: AnyParams): unknown {
    const state = this.threadState(p);
    if (!Array.isArray(p.items) || p.items.length === 0) {
      throw new SimMethodError(-32600, "items must not be empty");
    }
    const turnId = state.thread.turns.length
      ? state.thread.turns[state.thread.turns.length - 1]!.id
      : null;
    const at = Date.now();
    for (const [index, raw] of (p.items as unknown[]).entries()) {
      const item = this.injectedItem(raw, index);
      state.items.push({ turnId, item, startedAtMs: at, completedAtMs: at });
      if (isUserMessageItem(item)) {
        state.contextUserChars += item.content.reduce((sum, c) => sum + c.text.length, 0);
      } else if (isAgentMessageItem(item)) {
        state.contextAgentChars += item.text.length;
      }
    }
    this.persistState();
    return {};
  }

  /** 单个注入项 → SimItem；非对象 / 缺字符串 type / message 形状不全 → -32600（对齐 ResponseItem 反序列化失败）。 */
  private injectedItem(raw: unknown, index: number): SimItem {
    const invalid = (detail: string) =>
      new SimMethodError(-32600, `items[${index}] is not a valid response item: ${detail}`);
    if (typeof raw !== "object" || raw === null) {
      throw invalid("expected an object");
    }
    const value = raw as { type?: unknown; role?: unknown; content?: unknown };
    if (typeof value.type !== "string") {
      throw invalid("expected a string type");
    }
    if (value.type !== "message") {
      return { ...(raw as InjectedResponseItem) };
    }
    if ((value.role !== "user" && value.role !== "assistant") || !Array.isArray(value.content)) {
      throw invalid("message items need role user|assistant and a content array");
    }
    const text = (value.content as Array<{ text?: unknown }>)
      .map((c) => String(c.text ?? ""))
      .join("");
    return value.role === "user" ? makeUserMessage(text, null) : makeAgentMessage(text);
  }

  // ---------------------------------------------------------------- 状态 / 技能

  /** server/diagnostics（v2/diagnostics.rs:14-38）。 */
  private diagnostics(): unknown {
    return {
      process: {
        id: process.pid,
        residentMemoryBytes: process.memoryUsage().rss,
        physicalFootprintBytes: null,
      },
      gauges: [],
    };
  }

  /** remoteControl/status/read（v2/remote_control.rs:60-66）：复用 initialize 注入的服务器信息。 */
  private remoteControlStatusRead(): unknown {
    const info = this.opts.getServerInfo?.();
    if (info) {
      return {
        status: "connected",
        serverName: info.serverName,
        installationId: info.installationId,
        environmentId: info.environmentId,
      };
    }
    return { status: "disabled", serverName: "", installationId: "", environmentId: null };
  }

  /**
   * 速率限额快照（v2/account.rs:664-677 RateLimitSnapshot）：primary=5 小时滚动
   * 窗（windowDurationMins:300），secondary=7 天周窗（10080）——App 按窗口时长
   * 区分 5h/7d 两行。usedPercent 为 0-100 百分比；RateLimitWindow 无绝对 token
   * 数（protocol.rs:2390-2399）。静态合理值，供 RPC 读取与 turn 后滚动更新共用。
   */
  private rateLimitSnapshot(): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      limitId: "codex",
      limitName: "Codex",
      normalModelSlug: null,
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: now + 3600 },
      secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: now + 2 * 86400 },
      credits: { hasCredits: false, unlimited: false, balance: null },
      individualLimit: null,
      spendControlReached: null,
      planType: this.opts.accountInfo?.planType ?? null,
      rateLimitReachedType: null,
    };
  }

  /**
   * account/rateLimits/read（common.rs:1309-1313 → v2/account.rs:331-345）：手机
   * status 页「剩余速率限额」数据源；此前未实现返回 -32601，App 显示「速率限制：
   * 不可用」并弹「Codex 服务器返回了错误」横幅。
   */
  private accountRateLimitsRead(): unknown {
    return {
      ordinaryUsageAllowed: true,
      rateLimits: this.rateLimitSnapshot(),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
      accountId: null,
      rateLimitUpsell: null,
    };
  }

  /**
   * account/usage/read（common.rs:1321-1324 → v2/account.rs:448-455）：账户用量
   * 摘要。lifetimeTokens 汇总各线程已记录的累计用量，其余为静态合理值；
   * threadUsage 仅在按 threadId 请求且计费路由可用时返回（v2/account.rs:452-454），
   * sim 无计费路由恒为 null。
   */
  private accountUsageRead(): unknown {
    const lifetimeTokens = [...this.threads.values()].reduce(
      (sum, t) => sum + (t.tokenUsage?.usage.total.totalTokens ?? 0),
      0,
    );
    return {
      summary: {
        lifetimeTokens,
        peakDailyTokens: 45678,
        longestRunningTurnSec: 900,
        currentStreakDays: 3,
        longestStreakDays: 12,
      },
      dailyUsageBuckets: null,
      threadUsage: null,
    };
  }

  /** skills/config/write（v2/plugin.rs:933-950；catalog_processor.rs:699-700）。 */
  private skillsConfigWrite(p: AnyParams): { effectiveEnabled: boolean } {
    const hasPath = typeof p.path === "string" && p.path.length > 0;
    const hasName = typeof p.name === "string" && p.name.length > 0;
    if (hasPath === hasName) {
      throw new SimMethodError(-32602, "skills/config/write requires exactly one of path or name");
    }
    return { effectiveEnabled: p.enabled === true };
  }

  /** plugin/skill/read（v2/plugin.rs:268-281）。 */
  private pluginSkillRead(p: AnyParams): { contents: string } {
    const skillName = typeof p.skillName === "string" ? p.skillName : "";
    if (skillName.length === 0) {
      throw new SimMethodError(-32600, "skillName must not be empty");
    }
    return {
      contents: `# ${skillName}\n\n（模拟 SKILL.md：来自 ${p.remotePluginId}@${p.remoteMarketplaceName}）`,
    };
  }

  // ------------------------------------------------------------------ 虚拟 FS

  private fsReadDirectory(p: AnyParams): Promise<unknown> {
    return this.listDirectory(p.path);
  }

  private async listDirectory(path: string): Promise<unknown> {
    if (!path) throw new SimMethodError(-32602, "missing path");
    const names = new Map<string, boolean>(); // name → isDirectory
    let exists = this.overlayDirs.has(path);
    try {
      const entries = await readdir(path, { withFileTypes: true });
      exists = true;
      for (const e of entries) {
        names.set(e.name, e.isDirectory());
      }
    } catch {
      // 真实目录不存在：仅用覆盖层
    }
    for (const child of this.overlayChildren.get(path) ?? []) {
      names.set(child, this.overlayDirs.has(join(path, child)));
    }
    if (!exists) {
      throw new SimMethodError(-32000, `readDirectory: ${path}: no such file or directory`);
    }
    return {
      entries: [...names.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([fileName, isDirectory]) => ({ fileName, isDirectory, isFile: !isDirectory })),
    };
  }

  private async fsGetMetadata(p: AnyParams): Promise<unknown> {
    const path = p.path;
    try {
      const s = await stat(path);
      return {
        isDirectory: s.isDirectory(),
        isFile: s.isFile(),
        isSymlink: s.isSymbolicLink(),
        // 真实 codex（Rust）返回整毫秒；Node stat 的纳秒精度带小数，
        // 手机 Swift 解码器按整数解码小数毫秒即「无法解码Codex响应」
        // （2026-09-25 真机复现：仅时间戳恰为整秒的目录能显示）
        createdAtMs: Math.round(s.birthtimeMs),
        modifiedAtMs: Math.round(s.mtimeMs),
      };
    } catch {
      if (this.overlayDirs.has(path)) {
        const now = Date.now();
        return { isDirectory: true, isFile: false, isSymlink: false, createdAtMs: now, modifiedAtMs: now };
      }
      throw new SimMethodError(-32000, `getMetadata: ${path}: no such file or directory`);
    }
  }

  /** 覆盖层 mkdir -p。 */
  private overlayMkdir(path: string | undefined): void {
    if (!path) return;
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    const segments = expanded.replace(/^\//, "").split("/").filter(Boolean);
    let prev = "";
    for (let i = 0; i < segments.length; i++) {
      const current = `/${segments.slice(0, i + 1).join("/")}`;
      this.overlayDirs.add(current);
      if (prev) {
        const children = this.overlayChildren.get(prev) ?? new Set<string>();
        children.add(segments[i]!);
        this.overlayChildren.set(prev, children);
      }
      prev = current;
    }
  }

  // -------------------------------------------------------------- 进程模拟

  private processSpawn(p: AnyParams): unknown {
    const command: string[] = Array.isArray(p.command) ? p.command : [];
    const handle = p.processHandle ?? `sim-${uuidv7()}`;
    const { stdout, stderr, exitCode } = this.emulateShellScript(
      command.join(" "),
      p.env !== null && typeof p.env === "object" ? (p.env as Record<string, unknown>) : undefined,
    );
    this.emit("event", this.notification("process/exited", {
      processHandle: handle,
      exitCode,
      stdout,
      stdoutCapReached: false,
      stderr,
      stderrCapReached: false,
    }));
    return {};
  }

  /**
   * process/spawn 与 command/exec 共用的脚本模式仿真（不真正执行）。
   * 已知模式按真机语义应答：任务目录 mkdir（覆盖层 + 路径应答）、HOME 探测、
   * draft git 探测（非 git 目录形状）、其他 mkdir 登记覆盖层、周期 workspace-diff
   * 静默空应答；未识别脚本留痕后空 stdout / exit 0 兜底。
   * env 为 command/exec 的环境覆盖（新版任务目录脚本经 CODEX_PROJECTLESS_ROOT
   * 注入根目录，脚本文本不再含 Documents/Codex 字样）。
   */
  private emulateShellScript(
    script: string,
    env?: Record<string, unknown>,
  ): { stdout: string; stderr: string; exitCode: number } {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    const taskDir = this.emulateTaskDirMkdir(script, env);
    if (taskDir) {
      // 手机端新建任务：解析 stdout 拿任务目录路径（真实脚本 printf candidate）
      stdout = `${taskDir}\n`;
    } else if (script.includes('cd "$HOME" && pwd -P')) {
      // 工作文件夹选择器入口：手机靠该脚本拿 HOME 物理路径，空 stdout 会让
      // 选择器直接判「远程文件夹加载失败」（2026-09-25 真机复现，docs/research/07）
      stdout = `${realpathSync(homedir())}\n`;
    } else if (script.includes("CODEX_DRAFT_OUTPUT_CURRENT")) {
      // 选中目录后的 git 分支探测（draft/分支选择）。手机可接受「非 git 目录」
      // 形状并继续 thread/start（真实抓包 2026-09-25T19:23:04Z）；CODEX_DRAFT_OUTPUT_*
      // 标记值由 codex 进程注入、抓包未能观测到，故 git 仓库目录也按此形状应答
      // （draft 分支列表不可用，不影响文件夹选择本身）。
      exitCode = 128;
      stderr = "fatal: not a git repository (or any of the parent directories): .git\n";
    } else if (/\bmkdir\b/.test(script)) {
      // 其他 mkdir：登记到覆盖层，不真正执行
      for (const m of script.matchAll(/\bmkdir\s+(?:-[a-zA-Z]+\s+)*(~[^\s'";|&]+|\/[^\s'";|&]+)/g)) {
        this.overlayMkdir(m[1]);
      }
    } else if (!script.includes("collecting a workspace diff")) {
      // 周期性 workspace-diff 快照不记日志（约 30s 一次会刷屏）；其余未识别脚本
      // 留痕，便于真机出现新脚本模式时定位（当前以空 stdout / exit 0 兜底应答）
      this.opts.log?.(`exec 未识别脚本（空 stdout 应答）: ${script.slice(0, 80)}`);
    }
    return { stdout, stderr, exitCode };
  }

  /**
   * command/exec：无线程/turn 的一次性命令（ChatGPT iOS 1.2026.258 起在发消息前
   * 用它经 codex-read-only 只读包装探测 $HOME；此前同类探测走 process/spawn）。
   * 契约（app-server-protocol v2/command_exec.rs + app-server command_exec.rs）：
   * 最终结果直接作为 RPC 响应 {exitCode, stdout, stderr}；streamStdoutStderr 时
   * 输出改经 command/exec/outputDelta 通知（base64、连接级定向）下发，最终响应
   * 的 stdout/stderr 为空且流式字节不重复携带。返回 -32601 会让手机报
   * 「Codex 服务器返回了错误」并进入 30 秒会话重建循环（2026-09-26 真机复现，
   * frames.jsonl 17:12-17:14）。仿真策略与 process/spawn 一致：按脚本模式应答。
   */
  private commandExec(key: SimClientKey, p: AnyParams): unknown {
    const command: string[] = Array.isArray(p.command) ? p.command : [];
    const streamStdoutStderr = p.streamStdoutStderr === true;
    const processId = typeof p.processId === "string" ? p.processId : null;
    // 校验顺序对齐 command_exec.rs start()：先流式前置（159 行），后空命令（254 行）
    if (!processId && (p.tty === true || p.streamStdin === true || streamStdoutStderr)) {
      throw new SimMethodError(-32600, "command/exec tty or streaming requires a client-supplied processId");
    }
    if (command.length === 0) {
      throw new SimMethodError(-32600, "command must not be empty");
    }
    // codex 沙箱包装（read-only / workspace-write 同形）：
    // ["/bin/sh","-c","printf '\0'; exec \"$@\"",<wrapper>,"/bin/sh","-lc",<内层脚本>]
    // ——外壳先输出 NUL 再 exec 内层，仿真保持同形状输出
    let script = command.join(" ");
    let nulPrefix = false;
    if (
      command.length === 7 && command[1] === "-c" && command[5] === "-lc" &&
      typeof command[2] === "string" && typeof command[6] === "string" &&
      command[2].includes("exec \"$@\"")
    ) {
      script = command[6];
      nulPrefix = command[2].includes("printf '\\0'");
    }
    const env = p.env !== null && typeof p.env === "object" ? (p.env as Record<string, unknown>) : undefined;
    const emulated = this.emulateShellScript(script, env);
    const stdout = nulPrefix ? `\0${emulated.stdout}` : emulated.stdout;
    const capBytes = typeof p.outputBytesCap === "number" && Number.isFinite(p.outputBytesCap) &&
      p.outputBytesCap >= 0
      ? p.outputBytesCap
      : null;
    // cap 按字节截断（真实实现按输出字节计；仿真输出为 ASCII 时与字符截断一致）
    const capText = (text: string): string =>
      capBytes === null ? text : Buffer.from(text, "utf8").subarray(0, capBytes).toString("utf8");
    const stdoutCapped = capText(stdout);
    const stderrCapped = capText(emulated.stderr);
    if (streamStdoutStderr && processId) {
      const emitDelta = (stream: "stdout" | "stderr", text: string): void => {
        if (!text) return;
        this.emit("event", {
          method: "command/exec/outputDelta",
          params: {
            processId,
            stream,
            deltaBase64: Buffer.from(text, "utf8").toString("base64"),
            capReached: false,
          },
          target: key,
        });
      };
      emitDelta("stdout", stdoutCapped);
      emitDelta("stderr", stderrCapped);
      return { exitCode: emulated.exitCode, stdout: "", stderr: "" };
    }
    return { exitCode: emulated.exitCode, stdout: stdoutCapped, stderr: stderrCapped };
  }

  /**
   * command/exec/write：sim 的 exec 为同步仿真完成、无常驻会话，参数校验对齐
   * command_exec.rs write（缺 deltaBase64 且未 closeStdin → -32602），随后按
   * send_control 语义报无活动进程（-32600）。
   */
  private commandExecWrite(p: AnyParams): unknown {
    if (typeof p.deltaBase64 !== "string" && p.closeStdin !== true) {
      throw new SimMethodError(-32602, "command/exec/write requires deltaBase64 or closeStdin");
    }
    throw noActiveCommandExec(p.processId);
  }

  private commandExecTerminate(p: AnyParams): unknown {
    throw noActiveCommandExec(p.processId);
  }

  private commandExecResize(p: AnyParams): unknown {
    const size = p.size;
    const rows = typeof size === "object" && size !== null ? (size as { rows?: unknown }).rows : undefined;
    const cols = typeof size === "object" && size !== null ? (size as { cols?: unknown }).cols : undefined;
    if (rows === 0 || cols === 0) {
      throw new SimMethodError(-32602, "command/exec size rows and cols must be greater than 0");
    }
    throw noActiveCommandExec(p.processId);
  }

  /**
   * 识别手机端「新建任务目录」脚本并返回应答路径，同时在覆盖层创建目录：
   * - 旧版（≤1.2026.251）：root="${HOME}/Documents/Codex" 硬编码在脚本文本里；
   * - 新版（1.2026.258）：root="$CODEX_PROJECTLESS_ROOT"（env 注入根目录），
   *   base 取消息文本（如 base="hi"），重名加 -N 后缀，应答 printf candidate。
   */
  private emulateTaskDirMkdir(script: string, env?: Record<string, unknown>): string | null {
    if (!/\bbase="([^"]+)"/.test(script)) {
      return null;
    }
    let root: string | null = null;
    if (script.includes('root="$CODEX_PROJECTLESS_ROOT"')) {
      const fromEnv = env?.CODEX_PROJECTLESS_ROOT;
      root = typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : `${homedir()}/Documents/Codex`;
    } else if (script.includes("Documents/Codex")) {
      root = `${homedir()}/Documents/Codex`;
    }
    if (!root) {
      return null;
    }
    const base = script.match(/\bbase="([^"]+)"/)![1]!;
    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const dateDir = `${root}/${yyyy}-${mm}-${dd}`;
    this.overlayMkdir(dateDir);
    let candidate = `${dateDir}/${base}`;
    let index = 1;
    while (this.overlayDirs.has(candidate)) {
      index += 1;
      candidate = `${dateDir}/${base}-${index}`;
    }
    this.overlayMkdir(candidate);
    return candidate;
  }

  // ------------------------------------------------------------------ 工具

  private threadState(p: AnyParams): ThreadState {
    const id = p.threadId ?? p.thread_id;
    const state = id ? this.threads.get(id) : undefined;
    if (!state) {
      throw new SimMethodError(-32000, `thread not found: ${id ?? "(none)"}`);
    }
    return state;
  }

  private serializeThread(thread: ThreadRecord, turns: TurnRecord[]): ThreadRecord {
    return { ...thread, turns };
  }

  private serializeTurn(turn: TurnRecord): TurnRecord {
    return { ...turn, items: [...turn.items] };
  }

  private notification(method: string, params: Record<string, unknown>, threadId?: string): SimNotification {
    return { method, params, threadId };
  }

  /** 立即（微任务后）广播一条通知。 */
  private emitSoon(method: string, params: Record<string, unknown>, threadId?: string): void {
    queueMicrotask(() => {
      if (!this.closed) {
        this.emit("event", this.notification(method, params, threadId));
      }
    });
  }

  private schedule(sim: SimTurnRuntime | null, fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (sim) sim.timers.delete(timer);
      fn();
    }, ms);
    this.pendingTimers.add(timer);
    if (sim) sim.timers.add(timer);
  }

  private clearTimers(sim: SimTurnRuntime | null): void {
    if (!sim) return;
    for (const timer of sim.timers) {
      clearTimeout(timer);
      this.pendingTimers.delete(timer);
    }
    sim.timers.clear();
  }

  /** 清理全部在途定时器（turn 计时器 + 队列续跑等无 turn 计时器）。 */
  private clearAllTimers(): void {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    for (const t of this.threads.values()) {
      t.sim?.timers.clear();
    }
  }
}

class SimMethodError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "SimMethodError";
  }
}

/** 无活动 command/exec 会话的错误（文案对齐 command_exec.rs send_control，
 * error_repr 为 serde JSON 字符串，即带引号的 processId）。 */
function noActiveCommandExec(processId: unknown): SimMethodError {
  const repr = typeof processId === "string" ? JSON.stringify(processId) : String(processId);
  return new SimMethodError(-32600, `no active command/exec for process id ${repr}`);
}

/** input 数组归一化：[{type:"text", text, text_elements?}] → TextContent[]。 */
function normalizeInput(input: unknown): TextContent[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((e): e is { type: string; text?: string } => typeof e === "object" && e !== null)
    .filter((e) => e.type === "text")
    .map((e) => ({ type: "text" as const, text: e.text ?? "", text_elements: [] as unknown[] }));
}

export { DEFAULT_MODEL };
