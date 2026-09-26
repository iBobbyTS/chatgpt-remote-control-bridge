/**
 * 模拟 app-server：对手机端（及 wham slingshot 后端）的 JSON-RPC 请求
 * 返回固定/程序生成的模拟响应，不接 LLM。
 *
 * 方法与通知形状蓝本：2026-09-25 真实抓包（docs/research/06、
 * .agent-work/tmp/sim-layer/catalog*.json）。
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
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
  fixedThreads,
  makeAgentMessage,
  makeThread,
  makeTurn,
  makeUserMessage,
  readConfig,
  type ItemEntry,
  type SimItem,
  type TextContent,
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
  ended: boolean;
}

interface ThreadState {
  thread: ThreadRecord;
  items: ItemEntry[];
  queue: QueuedSubmission[];
  sim: SimTurnRuntime | null;
}

type AnyParams = Record<string, any>;

const ERR_NOT_INITIALIZED = { code: -32600, message: "Not initialized" };
const ERR_METHOD_NOT_FOUND = { code: -32601, message: "Method not found" };

export class SimApp extends EventEmitter implements AgentApp {
  private readonly clients = new Map<string, SimClientState>();
  private readonly threads = new Map<string, ThreadState>();
  /** 虚拟目录覆盖层：绝对路径 → 存在的目录（模拟 mkdir，不落盘）。 */
  private readonly overlayDirs = new Set<string>();
  private readonly overlayChildren = new Map<string, Set<string>>();
  private readonly opts: Required<Pick<SimAppOptions, "codexHome" | "stepDelayMs" | "deltaIntervalMs" | "deltaChars">> &
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
      this.threads.set(id, { thread: fixed.thread, items: fixed.items, queue: [], sim: null });
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
      const parsed = JSON.parse(raw) as Array<{ thread: ThreadRecord; items: ItemEntry[] }>;
      for (const entry of parsed) {
        if (entry?.thread?.id) {
          if ((entry.thread.turns ?? []).length === 0) {
            continue; // 零 turn 线程不跨重启存活（对齐 codex shutdown 清理）
          }
          this.threads.set(entry.thread.id, {
            thread: entry.thread,
            items: entry.items ?? [],
            queue: [],
            sim: null,
          });
        }
      }
    } catch (err) {
      this.opts.log?.(`状态文件解析失败（忽略）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** 落盘快照：非 ephemeral 线程（persistState 与 reset 显式写共用同一形状）。 */
  private snapshotEntries(): Array<{ thread: ThreadRecord; items: ItemEntry[] }> {
    return [...this.threads.values()]
      .filter((t) => !t.thread.ephemeral)
      .map((t) => ({
        thread: t.thread,
        items: t.items,
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
   * reset 路径的显式播种落盘（S03 BLOCKER2）：原子 tmp + rename，唯一临时名避免与
   * persistState 的固定 `.tmp` 冲突。与 persistState 不同，**错误向上抛**——reset 调用方
   * （daemon IPC agent-reset）必须据此报失败，否则"报成功而磁盘非播种态"。
   */
  private async persistSeedNow(): Promise<void> {
    const statePath = this.opts.statePath;
    if (!statePath) return;
    const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(this.snapshotEntries()), "utf8");
    await rename(tmp, statePath);
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
   * 与 saveQueue 的交错：先排空在途写，避免 reset 前排队中的旧快照在播种后落盘覆盖。
   * 落盘走 persistSeedNow（可失败变体）——失败向上抛，daemon IPC 据此报 {ok:false,INTERNAL}。
   *
   * 保留语义（NIT，明确声明）：
   * - `clients`：不动。在线手机连接须跨 reset 保持，否则 reset 会踢掉已配对会话。
   * - `overlayDirs` / `overlayChildren`：不动。虚拟 FS 覆盖层是进程级模拟状态，
   *   与"会话库播种态"无关，清理会让 reset 后线程引用的工作目录凭空消失。
   * 二者均为运行态连接/环境模拟，不属于 store 播种语义。
   */
  async resetToSeed(): Promise<void> {
    await this.saveQueue.catch(() => undefined);
    this.clearAllTimers();
    this.seedPresetThreads();
    await this.persistSeedNow();
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
      case "thread/goal/get":
        return { goal: null };
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
        return { deleted: true };
      case "thread/compact/start":
        return {};
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
    this.emitSoon("account/updated", {
      authMode: this.opts.accountInfo?.authMode ?? "chatgpt",
      planType: this.opts.accountInfo?.planType ?? null,
    });
    const info = this.opts.getServerInfo?.();
    if (info) {
      this.emitSoon("remoteControl/status/changed", {
        status: "connected",
        serverName: info.serverName,
        installationId: info.installationId,
        environmentId: info.environmentId,
      });
    }
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
    this.threads.set(thread.id, { thread, items: [], queue: [], sim: null });
    if (!thread.ephemeral) {
      this.persistState();
    }
    this.emitSoon("thread/started", { thread: this.serializeThread(thread, []) });
    return { thread: this.serializeThread(thread, []) };
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
    const thread = this.serializeThread(state.thread, []);
    return {
      thread,
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
      reasoningEffort: state.thread.reasoningEffort,
      collaborationMode: { mode: "default", settings: { model: thread.model, reasoning_effort: "medium" } },
      multiAgentMode: "explicitRequestOnly",
      initialTurnsPage: null,
      // 非空 cursor：手机据此调用 turns/items list 拉取历史；null 会让手机认为没有历史
      turnsBackwardsCursor: this.cursorFor(state.thread.id, state.thread.turns.length, "turns"),
      itemsBackwardsCursor: this.cursorFor(state.thread.id, state.items.length, "itemsByCreatedAtOrdinal"),
    };
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
        },
      },
      state.thread.id,
    );
    return {};
  }

  // ------------------------------------------------------------- turn 模拟

  private turnStart(p: AnyParams): unknown {
    const state = this.threadState(p);
    const input = normalizeInput(p.input);
    const clientUserMessageId = p.clientUserMessageId ?? null;
    if (state.sim && !state.sim.ended) {
      // 已有进行中的 turn：排队（真实 codex 会报错，手机端正常不会走到这里）
      state.queue.push({ id: uuidv7(), input, clientUserMessageId });
      this.emitSoon("thread/queue/changed", { threadId: state.thread.id }, state.thread.id);
    }
    const sim = this.beginSimTurn(state, input, clientUserMessageId);
    // 真实 turn/start 响应：items 空、itemsView notLoaded
    return { turn: { ...this.serializeTurn(sim.turn), items: [], itemsView: "notLoaded" as const } };
  }

  private turnSteer(p: AnyParams): unknown {
    const state = this.threadState(p);
    const input = normalizeInput(p.input);
    const clientUserMessageId = p.clientUserMessageId ?? null;
    if (state.sim && !state.sim.ended) {
      state.sim.steerInputs.push({ text: input.map((c) => c.text).join(""), clientUserMessageId });
      return { turnId: p.expectedTurnId ?? state.sim.turn.id };
    }
    const sim = this.beginSimTurn(state, input, clientUserMessageId);
    return { turnId: sim.turn.id };
  }

  private turnInterrupt(p: AnyParams): unknown {
    const state = this.threadState(p);
    if (state.sim && !state.sim.ended) {
      this.finishSimTurn(state, "interrupted");
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
    return { queuedSubmission: { id: queued.id, input, clientUserMessageId: queued.clientUserMessageId } };
  }

  private beginSimTurn(
    state: ThreadState,
    input: TextContent[],
    clientUserMessageId: string | null,
  ): SimTurnRuntime {
    const userText = input.map((c) => c.text).join("");
    const turn = makeTurn("inProgress");
    turn.items = [];
    const sim: SimTurnRuntime = { turn, timers: new Set(), steerInputs: [], ended: false };
    state.sim = sim;
    state.thread.turns.push(turn);
    state.thread.status = { type: "active", activeFlags: [] };
    state.thread.preview = userText.slice(0, 80) || state.thread.preview;

    const userItem = makeUserMessage(userText, clientUserMessageId);
    const startedAtMs = Date.now();
    this.emit("event", this.notification("thread/status/changed", {
      threadId: state.thread.id,
      status: { type: "active", activeFlags: [] },
    }, state.thread.id));
    this.emit("event", this.notification("turn/started", {
      threadId: state.thread.id,
      turn: this.serializeTurn(turn),
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
    state.items.push({ turnId: turn.id, item: userItem, startedAtMs, completedAtMs: startedAtMs });
    turn.items.push(userItem);

    // agentMessage：流式模拟回复
    this.schedule(sim, () => {
      const reply = this.buildReply(userText, state.thread);
      this.streamAgentMessage(state, sim, reply, () => {
        this.processSteers(state, sim, () => {
          this.finishSimTurn(state, "completed");
          this.consumeQueue(state);
        });
      });
    }, this.opts.stepDelayMs);
    return sim;
  }

  private processSteers(state: ThreadState, sim: SimTurnRuntime, done: () => void): void {
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
    this.emit("event", this.notification("thread/goal/cleared", { threadId: state.thread.id }, state.thread.id));
    this.emit("event", this.notification("thread/tokenUsage/updated", {
      threadId: state.thread.id,
      turnId: sim.turn.id,
      tokenUsage: {
        total: {
          totalTokens: 1234,
          inputTokens: 1180,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 54,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 1234,
          inputTokens: 1180,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 54,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: MODEL_CONTEXT_WINDOW,
      },
    }, state.thread.id));
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
    if (!next) return;
    this.emit("event", this.notification("thread/queue/changed", { threadId: state.thread.id }, state.thread.id));
    this.schedule(null, () => {
      if (this.closed) return;
      this.beginSimTurn(state, next.input, next.clientUserMessageId);
    }, this.opts.stepDelayMs);
  }

  private buildReply(userText: string, thread: ThreadRecord): string {
    if (thread.ephemeral) {
      // 手机起名线程：输入是"…User prompt:\n<用户首条消息>"，回复须是 ≤36 字符单行标题
      const m = userText.match(/User prompt:\s*([\s\S]+)$/);
      const prompt = (m ? m[1]! : userText).trim();
      const firstLine = prompt.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
      const title = firstLine.replace(/["`*#]/g, "").trim().slice(0, 36);
      return title.length > 0 ? title : "模拟任务";
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
        createdAtMs: s.birthtimeMs,
        modifiedAtMs: s.mtimeMs,
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
    const script = command.join(" ");
    const handle = p.processHandle ?? `sim-${uuidv7()}`;
    let stdout = "";
    const taskDir = this.emulateTaskDirMkdir(script);
    if (taskDir) {
      // 手机端新建任务：解析 stdout 拿任务目录路径（真实脚本 printf candidate）
      stdout = `${taskDir}\n`;
    } else if (/\bmkdir\b/.test(script)) {
      // 其他 mkdir：登记到覆盖层，不真正执行
      for (const m of script.matchAll(/\bmkdir\s+(?:-[a-zA-Z]+\s+)*(~[^\s'";|&]+|\/[^\s'";|&]+)/g)) {
        this.overlayMkdir(m[1]);
      }
    }
    this.emit("event", this.notification("process/exited", {
      processHandle: handle,
      exitCode: 0,
      stdout,
      stdoutCapReached: false,
      stderr: "",
      stderrCapReached: false,
    }));
    return {};
  }

  /**
   * 识别手机端「新建任务目录」脚本（root="${HOME}/Documents/Codex" + base="<name>"），
   * 在覆盖层创建 <home>/Documents/Codex/<今天>/<base>（重名加 -N 后缀）并返回完整路径。
   */
  private emulateTaskDirMkdir(script: string): string | null {
    if (!script.includes("Documents/Codex") || !/\bbase="([^"]+)"/.test(script)) {
      return null;
    }
    const base = script.match(/\bbase="([^"]+)"/)![1]!;
    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const dateDir = `${homedir()}/Documents/Codex/${yyyy}-${mm}-${dd}`;
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
