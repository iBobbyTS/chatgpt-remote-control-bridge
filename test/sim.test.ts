/**
 * 模拟层回环测试：WhamTunnel（桥被控端，直连）↔ MockWhamServer（扮演 wham 后端 + 手机端）。
 *
 * 覆盖：enroll → WSS 握手 → initialize/thread/list/thread/start/turn/start
 * 的固定响应与通知事件流、seq 递增、interrupt、虚拟 FS、process/spawn。
 *
 * S03 迁移：SimWhamServer 适配层删除，harness 直接构造 SimApp + WhamTunnel
 * （与 daemon 经注册表创建实例的接线一致）；断言语义与原测试完全一致。
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { BridgeAuthManager } from "../src/auth/manager.ts";
import { makeTestJwt } from "../src/auth/jwt.ts";
import { writeAuthStore, type AuthDotJson } from "../src/auth/store.ts";
import { MockWhamServer } from "../src/wham/mockServer.ts";
import { WhamTunnel } from "../src/wham/tunnel.ts";
import { SimApp } from "../src/agents/sim/appServer.ts";
import { simInit, simReset, simStatePath, simStoreInitialized } from "../src/agents/sim/store.ts";

const cleanupDirs: string[] = [];
after(async () => {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(slug: string): Promise<string> {
  const base = join(process.cwd(), ".agent-work", "tmp", "sim-tests");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, `${slug}-`));
  cleanupDirs.push(dir);
  return dir;
}

/** 虚拟 FS 用例的固定数据源：.agent-work/tmp/wham-tests/ 下的小型目录，避免读真实 $HOME。 */
async function whamTempDir(slug: string): Promise<string> {
  const base = join(process.cwd(), ".agent-work", "tmp", "wham-tests");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, `${slug}-`));
  cleanupDirs.push(dir);
  return dir;
}

function fakeAuth(): AuthDotJson {
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const jwt = makeTestJwt({
    exp,
    email: "sim@test",
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "free",
      chatgpt_user_id: "u1",
      chatgpt_account_id: "acc-1",
    },
  });
  return {
    auth_mode: "chatgpt",
    openai_api_key: null,
    tokens: { id_token: jwt, access_token: jwt, refresh_token: "rt-1", account_id: "acc-1" },
    last_refresh: new Date().toISOString(),
  };
}

interface Loop {
  mock: MockWhamServer;
  tunnel: WhamTunnel;
  authHome: string;
}

async function startLoop(
  simExtra: {
    commandWaitMs?: number;
    stepDelayMs?: number;
    deltaIntervalMs?: number;
    deltaChars?: number;
    compactWaitMs?: number;
    shellWaitMs?: number;
    threadUnloadDelayMs?: number;
  } = {},
): Promise<Loop> {
  const authHome = await tempDir("home");
  await writeAuthStore(authHome, fakeAuth());
  const authManager = new BridgeAuthManager({ codexHome: authHome });

  const mock = new MockWhamServer({
    port: 0,
    autoScript: false,
    log: () => {},
  });
  await mock.start();

  const app = new SimApp({
    codexHome: authHome,
    stepDelayMs: 10,
    deltaIntervalMs: 2,
    deltaChars: 16,
    ...simExtra,
  });
  const tunnel = new WhamTunnel({
    authManager,
    app,
    baseUrl: `http://127.0.0.1:${mock.port}/backend-api`,
    reconnectDelayMs: 0,
    installationDir: authHome,
    log: () => {},
    agentLabel: "bridge-sim",
  });
  try {
    await tunnel.start();
  } catch (err) {
    await mock.stop();
    throw err;
  }
  // 等 WSS 建立
  await waitFor(() => tunnel.connected, 5000, "sim wss 未连接");
  return { mock, tunnel, authHome };
}

test("回环：initialize / thread/list（固定列表）/ thread/start / turn 事件流 / seq 递增", async () => {
  const loop = await startLoop();
  try {
    // initialize
    const init = (await loop.mock.rpc("initialize", {
      clientInfo: { name: "codex_chatgpt_ios_remote", title: "ChatGPT", version: "1.0" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    })) as { result: Record<string, unknown> };
    assert.match(String(init.result.userAgent), /bridge-sim|codex_cli_rs/);
    assert.equal(init.result.platformOs, process.platform === "darwin" ? "macos" : "linux");
    assert.equal(init.result.codexHome, loop.authHome);

    // thread/list：固定线程列表（1 个带历史的预置会话；零 turn 线程不列出）
    const list = (await loop.mock.rpc("thread/list", {})) as {
      result: { data: Array<{ id: string; preview: string }> };
    };
    assert.equal(list.result.data.length, 1);
    assert.ok(list.result.data.every((t) => typeof t.id === "string" && t.id.includes("-")));

    // thread/start
    const started = (await loop.mock.rpc("thread/start", {
      cwd: "/Users/ibobby/Documents/Codex/2026-09-25/sim-test",
      threadSource: "user",
    })) as {
      result: { thread: { id: string; cwd: string }; sandbox: { type: string }; approvalPolicy: string } &
        Record<string, unknown>;
    };
    const threadId = started.result.thread.id;
    assert.equal(started.result.thread.cwd, "/Users/ibobby/Documents/Codex/2026-09-25/sim-test");
    // 真实 thread/start 响应共 14 个顶层键（thread + 13 个会话上下文字段，抓包
    // 2026-09-25T18:38:02Z）。只回 {thread} 手机 Swift 必填字段解码失败 →
    // 「无法解码Codex响应」，发消息在 turn/start 之前中止（2026-09-25 真机复现）
    assert.deepEqual(
      Object.keys(started.result).sort(),
      [
        "activePermissionProfile",
        "approvalPolicy",
        "approvalsReviewer",
        "cwd",
        "disabledPluginIds",
        "instructionSources",
        "model",
        "modelProvider",
        "multiAgentMode",
        "reasoningEffort",
        "runtimeWorkspaceRoots",
        "sandbox",
        "serviceTier",
        "thread",
      ],
    );
    assert.equal(started.result.sandbox.type, "workspaceWrite");
    assert.equal(started.result.approvalPolicy, "on-request");

    // turn/start → 通知事件流
    const turn = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "S-sim: 你好", text_elements: [] }],
      clientUserMessageId: "client-msg-1",
    })) as { result: { turn: { id: string; status: string } } };
    assert.equal(turn.result.turn.status, "inProgress");

    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "turn/completed 未收到",
    );
    const methods = loop.mock.receivedNotifications.map((n) => n.method);
    const order = (m: string) => methods.indexOf(m);
    assert.ok(order("turn/started") >= 0, "turn/started");
    assert.ok(order("thread/status/changed") >= 0, "thread/status/changed");
    // userMessage → agentMessage → delta → completed → tokenUsage → turn/completed
    assert.ok(methods.includes("item/started"));
    assert.ok(methods.includes("item/completed"));
    assert.ok(methods.includes("item/agentMessage/delta"));
    assert.ok(methods.includes("thread/tokenUsage/updated"));
    assert.ok(order("turn/completed") > order("item/agentMessage/delta"), "completed 在 delta 之后");

    // delta 拼接 = agentMessage 完整文本
    const deltas = loop.mock.receivedNotifications
      .filter((n) => n.method === "item/agentMessage/delta")
      .map((n) => String((n.params as { delta: string }).delta))
      .join("");
    const completedAgent = loop.mock.receivedNotifications.find(
      (n) =>
        n.method === "item/completed" &&
        (n.params as { item: { type: string } }).item.type === "agentMessage",
    );
    assert.ok(deltas.length > 0);
    assert.equal(deltas, String((completedAgent!.params as { item: { text: string } }).item.text));
    assert.match(deltas, /已收到消息：「S-sim: 你好」/);

    // turn/completed 状态；items 只含 agentMessage（对齐真实，防手机端重复渲染用户消息）
    const completed = loop.mock.receivedNotifications.find((n) => n.method === "turn/completed")!;
    const completedTurn = (completed.params as { turn: { status: string; items: Array<{ type: string }> } }).turn;
    assert.equal(completedTurn.status, "completed");
    assert.ok(
      completedTurn.items.every((item) => item.type === "agentMessage"),
      `turn/completed items 只应含 agentMessage: ${JSON.stringify(completedTurn.items.map((i) => i.type))}`,
    );

    // 历史可回读
    const turns = (await loop.mock.rpc("thread/turns/list", { threadId })) as {
      result: { data: Array<{ id: string; status: string }>; backwardsCursor: string };
    };
    assert.ok(turns.result.data.some((t) => t.status === "completed"));
    assert.ok(turns.result.backwardsCursor, "turns/list 应带非空 backwardsCursor");
    const items = (await loop.mock.rpc("thread/items/list", { threadId })) as {
      result: { data: Array<{ item: { type: string }; startedAtMs: number }>; backwardsCursor: string };
    };
    const types = items.result.data.map((e) => e.item.type);
    assert.ok(types.includes("userMessage") && types.includes("agentMessage"));
    assert.ok(items.result.backwardsCursor, "items/list 应带非空 backwardsCursor");
    // 排序契约：手机传 sortDirection:"desc"，响应须按 startedAtMs 倒序（否则聊天渲染颠倒）
    const times = items.result.data.map((e) => e.startedAtMs);
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1]! >= times[i]!, `desc 排序失败: ${times.join(",")}`);
    }
    const ascItems = (await loop.mock.rpc("thread/items/list", { threadId, sortDirection: "asc" })) as {
      result: { data: Array<{ item: { type: string }; startedAtMs: number }> };
    };
    assert.equal(ascItems.result.data[0]!.item.type, "userMessage", "asc 时最早的 userMessage 在前");

    // thread/resume 返回非空 cursor（手机据此拉取历史；null 会被当成无历史）
    const resumed = (await loop.mock.rpc("thread/resume", { threadId, excludeTurns: true })) as {
      result: { turnsBackwardsCursor: string; itemsBackwardsCursor: string; initialTurnsPage: unknown };
    };
    assert.ok(resumed.result.turnsBackwardsCursor);
    assert.ok(resumed.result.itemsBackwardsCursor);
    assert.equal(resumed.result.initialTurnsPage, null);

    // config/read 完整蓝本：含 origins 顶层键（缺失会让手机设置页解码失败）
    const config = (await loop.mock.rpc("config/read", { includeLayers: false })) as {
      result: { config: Record<string, unknown>; origins: Record<string, unknown> };
    };
    assert.ok(Object.keys(config.result.config).length >= 100, "config 键数对齐真实（104）");
    assert.ok(config.result.origins && "model" in config.result.origins);

    // seq 严格递增（同一 stream）
    const seqs = loop.mock.receivedSeqIds;
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i]! > seqs[i - 1]!, `seq 递增失败: ${seqs[i - 1]} → ${seqs[i]}`);
    }
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("turn/start 派发期间不得发射 turn 通知（响应先行的应用层契约）", async () => {
  const dir = await tempDir("order-app");
  const app = new SimApp({ codexHome: dir, stepDelayMs: 10, deltaIntervalMs: 2, deltaChars: 64 });
  const events: Array<{ method: string; params: unknown }> = [];
  app.on("event", (n) => events.push({ method: n.method, params: n.params }));
  const key = { clientId: "c", streamId: "s" };
  await app.handleRequest(key, 0, "initialize", { clientInfo: { name: "t" } });
  const started = (await app.handleRequest(key, 1, "thread/start", { cwd: "/tmp-sim/order" })) as {
    result: { thread: { id: string } };
  };
  const threadId = started.result.thread.id;
  events.length = 0;

  // await 续体运行于微任务：若通知在 turn/start 派发内同步发射，此刻必已可见。
  // 手机依赖「响应先于 userMessage item 事件」完成本地回显对账，顺序颠倒会
  // 双渲染用户消息（2026-09-25 真机复现，docs/research/07）。
  await app.handleRequest(key, 2, "turn/start", {
    threadId,
    input: [{ type: "text", text: "order", text_elements: [] }],
    clientUserMessageId: "client-order-1",
  });
  assert.equal(events.length, 0, "turn/start 响应就绪时不得已有本 turn 的通知");

  await waitFor(() => events.some((n) => n.method === "turn/completed"), 5000, "turn/completed");
  const order = (m: string) => events.findIndex((n) => n.method === m);
  assert.ok(order("turn/started") >= 0, "turn/started");
  assert.ok(order("item/started") > order("turn/started"), "userMessage item 事件晚于 turn/started");
  const userStarted = events.find(
    (n) => n.method === "item/started" && (n.params as { item: { type: string } }).item.type === "userMessage",
  )!;
  assert.equal(
    (userStarted.params as { item: { clientId: string | null } }).item.clientId,
    "client-order-1",
    "userMessage item 应携带 clientUserMessageId（手机对账键）",
  );
  const turnStarted = events.find((n) => n.method === "turn/started")!;
  assert.deepEqual(
    (turnStarted.params as { turn: { items: unknown[] } }).turn.items,
    [],
    "turn/started 的 turn.items 必须为空（userMessage 只经 item 事件下发）",
  );
  app.close();
});

test("回环：turn/start 响应先于 turn 通知上线（手机端双渲染回归）", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", {
      clientInfo: { name: "t" },
      capabilities: { optOutNotificationMethods: [] },
    });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/order" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedEnvelopeLog.length = 0;

    const turn = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "order-probe", text_elements: [] }],
      clientUserMessageId: "client-order-2",
    })) as { id: number | string; result: { turn: { id: string; status: string } } };
    assert.equal(turn.result.turn.status, "inProgress");
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "turn/completed 未收到",
    );

    // 线上顺序（到达序）：turn/start 响应信封必须先于本 turn 的全部通知信封
    const log = loop.mock.receivedEnvelopeLog;
    const notificationEntries = log.filter((e) => e.kind === "notification");
    assert.ok(notificationEntries.length > 0, "应收到 turn 通知");
    const responseIndex = log.findIndex(
      (e) => e.kind === "response" && String(e.id) === String(turn.id),
    );
    assert.ok(responseIndex >= 0, "turn/start 响应应在时序日志中");
    for (const e of notificationEntries) {
      assert.ok(
        log.indexOf(e) > responseIndex,
        `通知 ${e.method} 必须晚于 turn/start 响应上线`,
      );
    }
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：interrupt → interrupted；steer 注入；queue 自动消费", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", {
      clientInfo: { name: "t" },
      capabilities: { optOutNotificationMethods: [] },
    });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;

    // interrupt
    const turn = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "长任务，稍后打断" }],
    })) as { result: { turn: { id: string } } };
    const interrupt = (await loop.mock.rpc("turn/interrupt", {
      threadId,
      turnId: turn.result.turn.id,
    })) as { result: unknown };
    assert.deepEqual(interrupt.result, {});
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "turn/completed" &&
            (n.params as { turn: { status: string } }).turn.status === "interrupted",
        ),
      5000,
      "interrupted turn/completed 未收到",
    );

    // queue：add → list；turn 完成后自动消费
    loop.mock.receivedNotifications.length = 0;
    const queued = (await loop.mock.rpc("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: "排队消息 A" }],
      clientUserMessageId: "q-1",
    })) as { result: { queuedSubmission: { id: string } } };
    assert.ok(queued.result.queuedSubmission.id);
    const qList = (await loop.mock.rpc("thread/queue/list", { threadId })) as {
      result: { data: Array<{ id: string }> };
    };
    assert.equal(qList.result.data.length, 1);

    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "主任务" }] });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.filter((n) => n.method === "turn/completed").length >= 2,
      10_000,
      "排队任务未被自动消费",
    );
    // 第一个 turn 完成后队列应触发 thread/queue/changed 且第二个 turn 的用户消息是排队内容
    assert.ok(loop.mock.receivedNotifications.some((n) => n.method === "thread/queue/changed"));
    const queuedUserMsg = loop.mock.receivedNotifications.find(
      (n) =>
        n.method === "item/completed" &&
        (n.params as { item: { type: string; content?: Array<{ text: string }> } }).item.type ===
          "userMessage" &&
        (n.params as { item: { content?: Array<{ text: string }> } }).item.content?.[0]?.text ===
          "排队消息 A",
    );
    assert.ok(queuedUserMsg, "排队消息应作为第二个 turn 的 userMessage 出现");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：特殊指令 help / test steer / test queue（3 消息 + 2 次模拟 wait 命令）", async () => {
  const loop = await startLoop({ commandWaitMs: 300 });
  try {
    await loop.mock.rpc("initialize", {
      clientInfo: { name: "t" },
      capabilities: { optOutNotificationMethods: [] },
    });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    const completedItems = () =>
      loop.mock.receivedNotifications
        .filter((n) => n.method === "item/completed")
        .map((n) => (n.params as { item: { type: string } & Record<string, unknown> }).item);

    // help：trim + 大小写不敏感完全匹配，回复帮助文本
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "  HELP " }] });
    await waitFor(
      () => completedItems().some((i) => i.type === "agentMessage"),
      5000,
      "help 回复未到达",
    );
    const helpText = (completedItems().find((i) => i.type === "agentMessage") as unknown as { text: string }).text;
    assert.ok(helpText.startsWith("特殊指令："), "help 回复应以「特殊指令：」开头");
    assert.ok(helpText.includes("test steer"));
    assert.ok(helpText.includes("test queue"));

    // test steer：3 条消息 + 2 次模拟 wait；等待期间 steer 注入并即时回复
    loop.mock.receivedNotifications.length = 0;
    const steerTurn = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "Test Steer" }],
    })) as { result: { turn: { id: string } } };
    // 响应先于通知返回：此刻 turn 尚在第一条消息/第一次等待内，
    // steer 必然在第一次等待结束时被处理（顺序确定，可做严格断言）
    await loop.mock.rpc("turn/steer", {
      threadId,
      expectedTurnId: steerTurn.result.turn.id,
      input: [{ type: "text", text: "插入一下" }],
      clientUserMessageId: "steer-1",
    });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "turn/completed" &&
            (n.params as { turn: { status: string } }).turn.status === "completed",
        ),
      15_000,
      "test steer turn 未完成",
    );
    const steerItems = completedItems();
    // 顺序：用户消息 → 消息1 → wait1 → steer 注入 → steer 回复 → 消息2 → wait2 → 消息3
    assert.deepEqual(
      steerItems.map((i) => i.type),
      [
        "userMessage",
        "agentMessage",
        "commandExecution",
        "userMessage",
        "agentMessage",
        "agentMessage",
        "commandExecution",
        "agentMessage",
      ],
    );
    const agents = steerItems.filter((i) => i.type === "agentMessage") as unknown as Array<{ text: string }>;
    assert.ok(agents[0]!.text.includes("test steer 1/3"));
    assert.ok(agents[1]!.text.includes("插入指令"), "steer 回复应含「插入指令」");
    assert.ok(agents[2]!.text.includes("test steer 2/3"));
    assert.ok(agents[3]!.text.includes("test steer 3/3"));
    assert.equal(
      (steerItems[3] as { content?: Array<{ text: string }> }).content?.[0]?.text,
      "插入一下",
      "steer 消息应作为 userMessage 插入第一次等待之后、消息2 之前",
    );
    const cmds = steerItems.filter((i) => i.type === "commandExecution") as unknown as Array<{
      command: string;
      status: string;
      exitCode: number | null;
      aggregatedOutput: string | null;
      durationMs: number | null;
    }>;
    assert.equal(cmds.length, 2);
    for (const c of cmds) {
      assert.equal(c.command, "wait 15 seconds");
      assert.equal(c.status, "completed");
      assert.equal(c.exitCode, 0);
      assert.ok(c.aggregatedOutput && c.aggregatedOutput.length > 0);
      assert.ok((c.durationMs ?? 0) >= 250, "真实等待时长应接近注入的 commandWaitMs=300");
    }
    // outputDelta 与真实命令条目流一致
    assert.ok(
      loop.mock.receivedNotifications.some(
        (n) => n.method === "item/commandExecution/outputDelta",
      ),
      "模拟命令应发 item/commandExecution/outputDelta",
    );

    // test queue：等待期间排队，turn 完成后自动开跑
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "TEST QUEUE" }] });
    await loop.mock.rpc("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: "排队消息 B" }],
      clientUserMessageId: "q-2",
    });
    const qList = (await loop.mock.rpc("thread/queue/list", { threadId })) as {
      result: { data: Array<{ id: string }> };
    };
    assert.equal(qList.result.data.length, 1);
    await waitFor(
      () => loop.mock.receivedNotifications.filter((n) => n.method === "turn/completed").length >= 2,
      15_000,
      "排队消息未被自动消费",
    );
    const queueItems = completedItems();
    assert.equal(
      queueItems.filter((i) => i.type === "commandExecution").length,
      2,
      "test queue turn 应含 2 条模拟 wait 命令",
    );
    assert.equal(
      (queueItems.filter((i) => i.type === "agentMessage") as unknown as Array<{ text: string }>).filter((a) =>
        a.text.includes("test queue"),
      ).length,
      3,
    );
    assert.ok(
      queueItems.some(
        (i) =>
          i.type === "userMessage" &&
          (i as { content?: Array<{ text: string }> }).content?.[0]?.text === "排队消息 B",
      ),
      "排队消息应作为第二个 turn 的 userMessage 出现",
    );
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：test steer 期间 steer「stop」→ 步骤边界终止脚本，只回一条停止消息", async () => {
  const loop = await startLoop({ commandWaitMs: 300 });
  try {
    await loop.mock.rpc("initialize", {
      clientInfo: { name: "t" },
      capabilities: { optOutNotificationMethods: [] },
    });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    const completedItems = () =>
      loop.mock.receivedNotifications
        .filter((n) => n.method === "item/completed")
        .map((n) => (n.params as { item: { type: string } & Record<string, unknown> }).item);

    const steerTurn = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "test steer" }],
    })) as { result: { turn: { id: string } } };
    // 等第一次 wait 命令开始后再 steer，确保 stop 落在等待窗口内（顺序确定）
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "item/started" &&
            (n.params as { item?: { type?: string } }).item?.type === "commandExecution",
        ),
      5000,
      "第一次模拟 wait 未开始",
    );
    await loop.mock.rpc("turn/steer", {
      threadId,
      expectedTurnId: steerTurn.result.turn.id,
      // trim + 大小写不敏感匹配「stop」；userMessage 保留原文
      input: [{ type: "text", text: " Stop " }],
      clientUserMessageId: "steer-stop-1",
    });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "turn/completed" &&
            (n.params as { turn: { status: string } }).turn.status === "completed",
        ),
      15_000,
      "stop steer 后 turn 未收尾",
    );
    const items = completedItems();
    // 顺序：用户消息 → 消息1 → wait1 → stop 注入 → 停止回复；消息2/3 与 wait2 被跳过
    assert.deepEqual(
      items.map((i) => i.type),
      ["userMessage", "agentMessage", "commandExecution", "userMessage", "agentMessage"],
    );
    const agents = items.filter((i) => i.type === "agentMessage") as unknown as Array<{ text: string }>;
    assert.ok(agents[0]!.text.includes("test steer 1/3"));
    assert.equal(agents[1]!.text, "（steer注入）已按照steer规则停止原本的任务。");
    assert.equal(
      (items[3] as { content?: Array<{ text: string }> }).content?.[0]?.text,
      " Stop ",
      "stop 消息应作为 userMessage 注入第一次等待之后",
    );
    assert.equal(items.filter((i) => i.type === "commandExecution").length, 1, "第二次 15 秒等待应被跳过");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：turn 结束后的 steer → -32600 no active turn to steer（对齐 codex turn_steer_inner）", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", {
      clientInfo: { name: "t" },
      capabilities: { optOutNotificationMethods: [] },
    });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "第一轮" }] });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      5000,
      "第一轮 turn 未完成",
    );
    loop.mock.receivedNotifications.length = 0;
    // turn 已结束：真实 codex 返回 invalid_request（-32600）而非开新 turn
    const steer = (await loop.mock.rpc("turn/steer", {
      threadId,
      expectedTurnId: "01a0dc13-0000-0000-0000-000000000000",
      input: [{ type: "text", text: "迟到的 steer" }],
    })) as { error?: { code: number; message: string } };
    assert.equal(steer.error?.code, -32600);
    assert.equal(steer.error?.message, "no active turn to steer");
    // 不冷启动新 turn：无 turn/started、turns 数不变
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(
      !loop.mock.receivedNotifications.some((n) => n.method === "turn/started"),
      "迟到的 steer 不得触发 turn/started",
    );
    const turns = (await loop.mock.rpc("thread/turns/list", { threadId })) as {
      result: { data: unknown[] };
    };
    assert.equal(turns.result.data.length, 1, "迟到的 steer 不得创建第二个 turn");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：fs 虚拟目录 + process/spawn mkdir 覆盖层", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    // 读真实 $HOME 在目录很大/机器负载下会拖慢甚至超时 fs/readDirectory（外部评审曾在此挂起）。
    // 改用 .agent-work/tmp/wham-tests/ 下预建的小型固定目录：仍验证 sim「真实 FS 只读合并」能力。
    const fixedDir = await whamTempDir("readdir");
    await mkdir(join(fixedDir, "subdir"), { recursive: true });
    await writeFile(join(fixedDir, "alpha.txt"), "alpha");
    await writeFile(join(fixedDir, "beta.txt"), "beta");
    const real = (await loop.mock.rpc("fs/readDirectory", { path: fixedDir }, 10_000)) as {
      result: { entries: Array<{ fileName: string; isDirectory: boolean }> };
    };
    assert.ok(Array.isArray(real.result.entries) && real.result.entries.length > 0);
    const names = real.result.entries.map((e) => e.fileName);
    for (const expected of ["alpha.txt", "beta.txt", "subdir"]) {
      assert.ok(names.includes(expected), `readDirectory 应包含 ${expected}: ${names.join(",")}`);
    }
    assert.ok(
      real.result.entries.some((e) => e.fileName === "subdir" && e.isDirectory),
      "subdir 应被识别为目录",
    );
    assert.ok(
      real.result.entries.some((e) => e.fileName === "alpha.txt" && !e.isDirectory),
      "alpha.txt 应被识别为文件",
    );

    // process/spawn 模拟手机「新建任务目录」脚本（真实形状）：stdout 返回创建的目录路径
    const realMkdirScript =
      'set -eu\nroot="${HOME}/Documents/Codex"\ndate_directory="$root/$(date +%Y-%m-%d)"\n' +
      'mkdir -p "$root"\nmkdir -p "$date_directory"\nbase="sim-new-task"\n' +
      'candidate="$date_directory/$base"\nprintf \'%s\\n\' "$candidate"';
    loop.mock.receivedNotifications.length = 0;
    const mkdirResult = (await loop.mock.rpc("process/spawn", {
      command: ["/bin/sh", "-lc", realMkdirScript],
      processHandle: "ios-standalone-mkdir",
    })) as { result: unknown };
    assert.deepEqual(mkdirResult.result, {});
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "process/exited" &&
            (n.params as { processHandle: string }).processHandle === "ios-standalone-mkdir",
        ),
      5000,
      "mkdir process/exited 未收到",
    );
    const mkdirExited = loop.mock.receivedNotifications.find(
      (n) =>
        n.method === "process/exited" &&
        (n.params as { processHandle: string }).processHandle === "ios-standalone-mkdir",
    )!;
    const taskDir = String((mkdirExited.params as { stdout: string }).stdout).trim();
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    assert.equal(taskDir, `${homedir()}/Documents/Codex/${dateStr}/sim-new-task`);
    const taskMeta = (await loop.mock.rpc("fs/getMetadata", { path: taskDir }, 10_000)) as {
      result: { isDirectory: boolean };
    };
    assert.equal(taskMeta.result.isDirectory, true);

    // process/spawn 模拟手机 mkdir 任务目录（不真正落盘）；父目录同样落在固定数据源下
    const overlayDir = join(fixedDir, "Documents", "Codex", "2026-09-25", "sim-overlay-task");
    loop.mock.receivedNotifications.length = 0;
    const spawnResult = (await loop.mock.rpc("process/spawn", {
      command: ["/bin/bash", "-lc", `mkdir -p ${overlayDir}`],
      processHandle: "ios-standalone-test",
    })) as { result: unknown };
    assert.deepEqual(spawnResult.result, {});
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "process/exited" &&
            (n.params as { processHandle: string }).processHandle === "ios-standalone-test",
        ),
      5000,
      "process/exited 未收到",
    );

    // 覆盖层目录可见
    const parent = (await loop.mock.rpc(
      "fs/readDirectory",
      { path: join(fixedDir, "Documents", "Codex", "2026-09-25") },
      10_000,
    )) as { result: { entries: Array<{ fileName: string; isDirectory: boolean }> } };
    assert.ok(
      parent.result.entries.some((e) => e.fileName === "sim-overlay-task" && e.isDirectory),
    );
    const meta = (await loop.mock.rpc("fs/getMetadata", { path: overlayDir }, 10_000)) as {
      result: { isDirectory: boolean };
    };
    assert.equal(meta.result.isDirectory, true);
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：工作文件夹选择器（pwd -P / git draft 探测 / getMetadata 整毫秒）", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });

    // picker 入口脚本（真实形状，2026-09-25T19:22:52Z 抓包）：stdout 必须是 HOME 物理路径。
    // 修复前这里回空 stdout，手机选择器直接判「远程文件夹加载失败」，连 fs/* 都不会发。
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("process/spawn", {
      command: ["/bin/sh", "-lc", 'cd "$HOME" && pwd -P'],
      processHandle: "picker-pwd",
    });
    const findExited = (handle: string) =>
      loop.mock.receivedNotifications.find(
        (n) =>
          n.method === "process/exited" &&
          (n.params as { processHandle: string }).processHandle === handle,
      );
    await waitFor(
      () => findExited("picker-pwd") !== undefined,
      5000,
      "pwd process/exited 未收到",
    );
    const pwdExited = findExited("picker-pwd")!;
    assert.equal((pwdExited.params as { exitCode: number }).exitCode, 0);
    assert.equal(
      (pwdExited.params as { stdout: string }).stdout,
      `${realpathSync(homedir())}\n`,
      "pwd -P 应回真实 HOME 物理路径",
    );

    // HOME 元数据形状对齐真实抓包（5 键）
    const homeMeta = (await loop.mock.rpc("fs/getMetadata", { path: homedir() }, 10_000)) as {
      result: Record<string, unknown>;
    };
    assert.deepEqual(
      Object.keys(homeMeta.result).sort(),
      ["createdAtMs", "isDirectory", "isFile", "isSymlink", "modifiedAtMs"],
    );
    assert.equal(homeMeta.result.isDirectory, true);
    // 真实 codex 返回整毫秒；小数毫秒（Node stat 纳秒精度）会被手机按整数解码
    // 失败 →「无法解码Codex响应」。$HOME 的 stat 在本机即为小数毫秒，可证伪。
    assert.ok(
      Number.isInteger(homeMeta.result.createdAtMs) &&
        Number.isInteger(homeMeta.result.modifiedAtMs),
      "createdAtMs/modifiedAtMs 必须是整毫秒",
    );

    // 选中目录后的 git 分支探测：按真实「非 git 目录」形状（exit 128 + fatal stderr，
    // 手机接受并继续 thread/start）
    const draftScript =
      'set -eu\ncurrent_branch="$(git branch --show-current)"\n' +
      'printf \'%s\\t%s\\n\' "$CODEX_DRAFT_OUTPUT_CURRENT" "$current_branch"\n' +
      'printf \'%s\\t%s\\n\' "$CODEX_DRAFT_OUTPUT_DEFAULT" ""';
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("process/spawn", {
      command: ["/bin/sh", "-lc", draftScript],
      cwd: homedir(),
      processHandle: "picker-draft",
    });
    await waitFor(
      () => findExited("picker-draft") !== undefined,
      5000,
      "draft process/exited 未收到",
    );
    const draftExited = findExited("picker-draft")!;
    assert.equal((draftExited.params as { exitCode: number }).exitCode, 128);
    assert.equal((draftExited.params as { stdout: string }).stdout, "");
    assert.equal(
      (draftExited.params as { stderr: string }).stderr,
      "fatal: not a git repository (or any of the parent directories): .git\n",
    );
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("持久化：重启后 thread id 与历史保持（手机缓存 thread id 的前提）", async () => {
  const statePath = join(await tempDir("state"), "sim-state.json");
  const make = () =>
    new SimApp({ codexHome: "/tmp-sim", statePath, stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 32 });
  const app1 = make();
  const key = { clientId: "c", streamId: "s" };
  await app1.handleRequest(key, 0, "initialize", { clientInfo: { name: "t" } });
  const started = (await app1.handleRequest(key, 1, "thread/start", { cwd: "/tmp-sim/x" })) as {
    result: { thread: { id: string } };
  };
  const threadId = started.result.thread.id;
  await app1.handleRequest(key, 2, "turn/start", {
    threadId,
    input: [{ type: "text", text: "persist-me" }],
  });
  // 再建一个零 turn 线程：codex 语义下不跨重启存活
  const emptyStarted = (await app1.handleRequest(key, 6, "thread/start", { cwd: "/tmp-sim/never-used" })) as {
    result: { thread: { id: string } };
  };
  // 等 turn 流结束落盘
  await new Promise((r) => setTimeout(r, 300));
  app1.close();

  const app2 = make();
  await app2.handleRequest(key, 0, "initialize", { clientInfo: { name: "t" } });
  const list = (await app2.handleRequest(key, 3, "thread/list", {})) as {
    result: { data: Array<{ id: string }> };
  };
  assert.ok(list.result.data.some((t) => t.id === threadId), "重启后同 thread id 仍存在");
  assert.ok(
    !list.result.data.some((t) => t.id === emptyStarted.result.thread.id),
    "零 turn 线程不应跨重启存活",
  );
  const resumed = (await app2.handleRequest(key, 4, "thread/resume", { threadId })) as {
    result: { turnsBackwardsCursor: string };
  };
  assert.ok(resumed.result.turnsBackwardsCursor);
  const items = (await app2.handleRequest(key, 5, "thread/items/list", { threadId })) as {
    result: { data: Array<{ item: { type: string; text?: string; content?: Array<{ text: string }> } }> };
  };
  const texts = items.result.data.map((e) =>
    e.item.type === "agentMessage" ? e.item.text : e.item.content?.[0]?.text,
  );
  assert.ok(texts.includes("persist-me"), "重启后历史 userMessage 仍在");
  app2.close();
});

test("回环：ephemeral 起名线程与零 turn 线程不进列表（对齐 codex thread-store 行为）", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });

    // 普通空线程（未发消息）：turn/start 前 thread/list 不应包含它
    const empty = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/empty" })) as {
      result: { thread: { id: string; ephemeral: boolean } };
    };
    assert.equal(empty.result.thread.ephemeral, false);
    let list = (await loop.mock.rpc("thread/list", {})) as {
      result: { data: Array<{ id: string }> };
    };
    assert.ok(!list.result.data.some((t) => t.id === empty.result.thread.id), "零 turn 线程不应出现在列表");

    // ephemeral 起名线程（手机 threadSource:"thread_title" + ephemeral:true）
    const titleThread = (await loop.mock.rpc("thread/start", {
      cwd: "/tmp-sim/title",
      ephemeral: true,
      threadSource: "thread_title",
    })) as { result: { thread: { id: string; ephemeral: boolean } } };
    assert.equal(titleThread.result.thread.ephemeral, true);

    // 起名 turn：输入含 "User prompt:\n<首条消息>"，回复应为 ≤36 字符短标题
    await loop.mock.rpc("turn/start", {
      threadId: titleThread.result.thread.id,
      input: [{
        type: "text",
        text: "You are a helpful assistant. Generate a concise UI title of at most 36 characters.\n\nUser prompt:\nS9-ephemeral 标题测试",
      }],
    });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "turn/completed" &&
            (n.params as { threadId: string }).threadId === titleThread.result.thread.id,
        ),
      8000,
      "起名线程 turn/completed 未收到",
    );
    const titleReply = loop.mock.receivedNotifications.find(
      (n) =>
        n.method === "item/completed" &&
        (n.params as { threadId: string; item: { type: string; text: string } }).threadId ===
          titleThread.result.thread.id &&
        (n.params as { item: { type: string } }).item.type === "agentMessage",
    );
    const titleText = String(
      ((titleReply!.params as { item: { text: string } }).item.text ?? "").trim(),
    );
    assert.equal(titleText, "S9-ephemeral 标题测试");
    assert.ok(titleText.length <= 36);

    // 起名线程即使跑过 turn 也不进列表
    list = (await loop.mock.rpc("thread/list", {})) as { result: { data: Array<{ id: string }> } };
    assert.ok(
      !list.result.data.some((t) => t.id === titleThread.result.thread.id),
      "ephemeral 线程不应出现在列表",
    );
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

// ------------------------------------------------------- S03：simInit / simReset

interface LooseStoreEntry {
  thread: { id: string; preview: string; turns: unknown[] };
  items: unknown[];
}

/** store 语义归一（忽略随机 id/时间戳）：预览/ turn 数 / item 数。 */
function normStore(entries: LooseStoreEntry[]): Array<{ preview: string; turns: number; items: number }> {
  return entries.map((e) => ({
    preview: e.thread.preview,
    turns: e.thread.turns.length,
    items: e.items.length,
  }));
}

const SEED_SEMANTICS = [{ preview: "模拟会话：桥接链路验证", turns: 1, items: 2 }];

test("S03② simInit：未初始化播种、连跑两次幂等、已有用户线程不覆盖", async () => {
  const dir = await tempDir("init");
  const path = simStatePath(dir);
  assert.equal(await simStoreInitialized(dir), false, "空目录应为未初始化");
  assert.equal(await simInit(dir), true, "首次应播种");
  const first = await readFile(path, "utf8");
  assert.deepEqual(normStore(JSON.parse(first) as LooseStoreEntry[]), SEED_SEMANTICS);
  assert.equal(await simStoreInitialized(dir), true);

  // 幂等：重复 init 不重新播种（文件字节不变）
  assert.equal(await simInit(dir), false, "已初始化应 no-op");
  assert.equal(await readFile(path, "utf8"), first, "重复 init 不得改写 store");

  // 已有用户线程：不播种、不覆盖
  const userDir = await tempDir("init-user");
  const userPath = simStatePath(userDir);
  const userStore: LooseStoreEntry[] = [
    { thread: { id: "user-thread-1", preview: "我的会话", turns: [] }, items: [] },
  ];
  await writeFile(userPath, JSON.stringify(userStore));
  const before = await readFile(userPath, "utf8");
  assert.equal(await simInit(userDir), false, "已有用户线程不播种");
  assert.equal(await readFile(userPath, "utf8"), before, "用户数据不得被覆盖");

  // 空数组 store 视为未初始化 → 播种
  const emptyDir = await tempDir("init-empty");
  await writeFile(simStatePath(emptyDir), "[]");
  assert.equal(await simInit(emptyDir), true);
  assert.deepEqual(
    normStore(JSON.parse(await readFile(simStatePath(emptyDir), "utf8")) as LooseStoreEntry[]),
    SEED_SEMANTICS,
  );
});

test("S03③ simReset：store == 播种态且与全新 init 语义等价；身份文件未动", async () => {
  const dir = await tempDir("reset");
  const identity = {
    installationId: join(dir, "installation_id"),
    enrollment: join(dir, "enrollment.json"),
    pairing: join(dir, "pairing.json"),
    lifecycle: join(dir, "lifecycle.json"),
  };
  await writeFile(identity.installationId, "install-abc\n");
  await writeFile(identity.enrollment, JSON.stringify({ server_id: "s1", environment_id: "e1" }));
  await writeFile(identity.pairing, JSON.stringify({ manual_pairing_code: "123456" }));
  await writeFile(identity.lifecycle, JSON.stringify({ everEnrolled: true }));
  await writeFile(
    simStatePath(dir),
    JSON.stringify([{ thread: { id: "user", preview: "旧会话", turns: [] }, items: [] }]),
  );

  await simReset(dir);

  const afterReset = JSON.parse(await readFile(simStatePath(dir), "utf8")) as LooseStoreEntry[];
  assert.deepEqual(normStore(afterReset), SEED_SEMANTICS, "reset 后 store 应为播种态");

  // 与全新 init 结果语义等价
  const freshDir = await tempDir("reset-fresh");
  await simInit(freshDir);
  const fresh = JSON.parse(await readFile(simStatePath(freshDir), "utf8")) as LooseStoreEntry[];
  assert.deepEqual(normStore(afterReset), normStore(fresh), "reset ≡ 全新 init（语义）");

  // 身份/配对/生命周期文件未被触碰
  assert.equal(await readFile(identity.installationId, "utf8"), "install-abc\n");
  assert.equal(
    await readFile(identity.enrollment, "utf8"),
    JSON.stringify({ server_id: "s1", environment_id: "e1" }),
  );
  assert.equal(
    await readFile(identity.pairing, "utf8"),
    JSON.stringify({ manual_pairing_code: "123456" }),
  );
  assert.equal(await readFile(identity.lifecycle, "utf8"), JSON.stringify({ everEnrolled: true }));
});

test("S03③ reset 活实例：清队列续跑计时器，无 turn 复活；内存/磁盘均为播种态", async () => {
  const dir = await tempDir("reset-live");
  const statePath = simStatePath(dir);
  const app = new SimApp({
    codexHome: dir,
    statePath,
    stepDelayMs: 40,
    deltaIntervalMs: 2,
    deltaChars: 64,
  });
  const notifications: Array<{ method: string }> = [];
  app.on("event", (n) => notifications.push({ method: n.method }));
  const key = { clientId: "c", streamId: "s" };
  await app.handleRequest(key, 0, "initialize", { clientInfo: { name: "t" } });
  const started = (await app.handleRequest(key, 1, "thread/start", { cwd: "/tmp-sim/reset" })) as {
    result: { thread: { id: string } };
  };
  const threadId = started.result.thread.id;
  await app.handleRequest(key, 2, "turn/start", {
    threadId,
    input: [{ type: "text", text: "主任务" }],
  });
  await app.handleRequest(key, 3, "thread/queue/add", {
    threadId,
    input: [{ type: "text", text: "排队消息" }],
    clientUserMessageId: "q1",
  });
  // 主 turn 完成 → consumeQueue 已排下队列续跑计时器（schedule(null,…)）
  await waitFor(
    () => notifications.some((n) => n.method === "turn/completed"),
    3000,
    "主 turn 完成",
  );
  const timers = (app as unknown as { pendingTimers: Set<NodeJS.Timeout> }).pendingTimers;
  assert.equal(timers.size, 1, "队列续跑计时器应在途（现 close() 不覆盖此计时器）");

  notifications.length = 0;
  await app.resetToSeed();
  assert.equal(timers.size, 0, "reset 必须清理队列续跑计时器");
  assert.equal(
    (app as unknown as { threads: Map<string, unknown> }).threads.size,
    1,
    "内存应仅剩播种线程",
  );
  const onDisk = JSON.parse(await readFile(statePath, "utf8")) as LooseStoreEntry[];
  assert.deepEqual(normStore(onDisk), SEED_SEMANTICS, "reset 后磁盘为播种态");

  // 超过 stepDelay 窗口：被清掉的排队 turn 不得复活
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(
    notifications.some((n) => n.method === "turn/started" || n.method === "turn/completed"),
    false,
    "reset 后不得有 turn 复活",
  );
  app.close();
});

test("S03 BLOCKER2 resetToSeed：落盘失败向上抛（不经 persistState 吞错 catch）", async () => {
  const dir = await tempDir("reset-fail");
  const statePath = simStatePath(dir);
  // 注入落盘失败：state.json 占用为目录 → persistSeedNow 的 rename(tmp, state.json) 报 EISDIR
  await mkdir(statePath, { recursive: true });
  const app = new SimApp({ codexHome: dir, statePath });
  await assert.rejects(() => app.resetToSeed(), /EISDIR/, "reset 落盘失败必须抛出");
  // 常规运行期 persistState 仍吞错：触发一次写不 reject（仅日志）
  await assert.doesNotReject(async () => {
    (app as unknown as { persistState: () => void }).persistState();
    await new Promise((r) => setTimeout(r, 50));
  }, "persistState 吞错语义不得改变");
  app.close();
});

test("S03 B槽 reset×并发 persistState：播种写为串行序最后写，旧快照不得后落盘覆盖", async () => {
  const key = { clientId: "c", streamId: "s" };
  const slow = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // 多轮：原缺陷为 4/30 偶发；此处用可控门闩 + 注入慢写把交错确定性放大（每轮必现于无修复）
  for (let i = 0; i < 5; i++) {
    const dir = await tempDir("reset-race");
    const statePath = simStatePath(dir);
    const app = new SimApp({ codexHome: dir, statePath });
    await app.handleRequest(key, 0, "initialize", { clientInfo: { name: "t" } });
    // 制造非播种线程：使 reset 前快照与播种态不同
    await app.handleRequest(key, 1, "thread/start", { cwd: "/tmp-race-a" });
    await app.handleRequest(key, 2, "thread/start", { cwd: "/tmp-race-b" });

    const internal = app as unknown as { saveQueue: Promise<void> };
    // 可控门闩：reset 的前置排空会卡在这里，保证并发追加落在 reset 恢复之前（确定性交错）
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    internal.saveQueue = internal.saveQueue.then(() => gate);

    const resetP = app.resetToSeed();
    // 追加慢任务 + 一个"旧快照"运行期写（persistState 在内存播种前调用，捕获 pre-reset 内存）
    internal.saveQueue = internal.saveQueue.then(() => slow(40));
    await app.handleRequest(key, 3, "thread/start", { cwd: "/tmp-race-old" });
    release();
    await resetP;

    // 静置超过注入慢写窗口：无修复时旧快照写会在此后落地，把磁盘从播种态改回 reset 前
    await slow(150);
    const disk = JSON.parse(await readFile(statePath, "utf8")) as LooseStoreEntry[];
    assert.deepEqual(normStore(disk), SEED_SEMANTICS, `第 ${i + 1} 次：reset 后磁盘必须为播种态`);
    app.close();
  }
});

test("S03 B槽 reset 播种写：入列即冻结序列化，并发 turn/start 改动不得混入播种态", async () => {
  const key = { clientId: "c", streamId: "s" };
  const slow = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  for (let i = 0; i < 3; i++) {
    const dir = await tempDir("reset-freeze");
    const statePath = simStatePath(dir);
    // 巨大 stepDelay：并发 turn 在测试窗口内不完成，避免其 finish 落盘干扰
    const app = new SimApp({ codexHome: dir, statePath, stepDelayMs: 10_000, deltaIntervalMs: 10_000 });
    try {
      await app.handleRequest(key, 0, "initialize", { clientInfo: { name: "t" } });
      // 先制造非播种线程，使 reset 前快照与播种态不同
      await app.handleRequest(key, 1, "thread/start", { cwd: "/tmp-freeze" });

      const internal = app as unknown as { saveQueue: Promise<void>; threads: Map<string, unknown> };
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      internal.saveQueue = internal.saveQueue.then(() => gate);

      const resetP = app.resetToSeed();
      // 追加慢任务：reset 恢复后播种写排在它之后（执行被延后），留出改动内存的窗口
      internal.saveQueue = internal.saveQueue.then(() => slow(80));
      release();
      // 等 reset 完成内存播种（只剩 1 个预置线程），此时播种写已入列但尚未执行
      await waitFor(() => internal.threads.size === 1, 1000, "reset 内存播种");
      const seedId = [...internal.threads.keys()][0]!;
      // 对预置线程发 turn/start（改内存：push 新 turn+item），发生在播种写入列之后、执行之前
      const started = (await app.handleRequest(key, 2, "turn/start", {
        threadId: seedId,
        input: [{ type: "text", text: "RACE-TURN" }],
      })) as { result?: { turn?: { id: string } } };
      assert.ok(started.result?.turn?.id, "并发 turn/start 应成功");

      await resetP;
      await slow(50);
      const raw = await readFile(statePath, "utf8");
      const disk = JSON.parse(raw) as LooseStoreEntry[];
      assert.deepEqual(normStore(disk), SEED_SEMANTICS, `第 ${i + 1} 次：播种写须为入列时冻结内容`);
      assert.equal(raw.includes("RACE-TURN"), false, "播种写不得混入并发 turn 的输入");
    } finally {
      app.close(); // 失败时也清掉 10s 在途定时器，避免进程挂起
    }
  }
});

test("回环：thread/queue/delete 真删除（deleted 标志 + queue/changed 通知）", async () => {
  const loop = await startLoop({ commandWaitMs: 400 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/qdel" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    // 空闲线程 queue/add 会立即唤醒开跑（对齐 codex wake_if_loaded），
    // delete 语义须在 turn 运行的等待窗口内入队验证。
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "test queue" }] });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "item/started") && n.params.item.type === "commandExecution",
        ),
      8000,
      "活动 turn 未进入等待",
    );
    loop.mock.receivedNotifications.length = 0;

    const queued = (await loop.mock.rpc("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: "Hi" }],
      clientUserMessageId: "q-del-1",
    })) as { result: { queuedSubmission: { id: string } } };
    const queuedId = queued.result.queuedSubmission.id;
    assert.ok(queuedId);
    let qList = (await loop.mock.rpc("thread/queue/list", { threadId })) as {
      result: { data: Array<{ id: string }> };
    };
    assert.equal(qList.result.data.length, 1);

    // 删除存在的条目 → {deleted:true}，队列为空，且发 thread/queue/changed
    const deleted = (await loop.mock.rpc("thread/queue/delete", {
      threadId,
      queuedSubmissionId: queuedId,
    })) as { result: { deleted: boolean } };
    assert.deepEqual(deleted.result, { deleted: true });
    qList = (await loop.mock.rpc("thread/queue/list", { threadId })) as {
      result: { data: Array<{ id: string }> };
    };
    assert.equal(qList.result.data.length, 0, "删除后队列应为空");
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "thread/queue/changed" &&
            (n.params as { threadId: string }).threadId === threadId,
        ),
      2000,
      "queue/delete 未发 thread/queue/changed",
    );

    // 删除不存在的条目 → {deleted:false}
    const missing = (await loop.mock.rpc("thread/queue/delete", {
      threadId,
      queuedSubmissionId: "01a0dc13-0000-0000-0000-000000000000",
    })) as { result: { deleted: boolean } };
    assert.deepEqual(missing.result, { deleted: false });

    // 收尾：中止脚本 turn（队列已空，无后续开跑）
    await loop.mock.rpc("turn/interrupt", { threadId });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.status === "interrupted",
        ),
      5000,
      "脚本 turn 未被中止",
    );
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：活动期 turn/start 转 steer（对齐 start_or_steer_turn，不新建 turn）", async () => {
  const loop = await startLoop({ commandWaitMs: 300 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/steer-on-start" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    // test queue 脚本 turn：两次 commandExecution 等待窗口
    const active = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "test queue" }],
    })) as { result: { turn: { id: string } } };
    const activeTurnId = active.result.turn.id;

    // 等第一次模拟命令进入 inProgress（item/started 的 commandExecution）
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "item/started" &&
            (n.params as { item: { type: string } }).item.type === "commandExecution",
        ),
      8000,
      "第一次模拟命令未进入 inProgress",
    );

    // 活动期 turn/start：转 steer，返回同一 turn（items 空 / itemsView notLoaded）
    const steered = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "中途消息" }],
      clientUserMessageId: "steer-on-start-1",
    })) as { result: { turn: { id: string; items: unknown[]; itemsView: string } } };
    assert.equal(steered.result.turn.id, activeTurnId, "活动期 turn/start 必须返回同一 turn");
    assert.deepEqual(steered.result.turn.items, []);
    assert.equal(steered.result.turn.itemsView, "notLoaded");

    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "turn/completed" &&
            (n.params as { threadId: string }).threadId === threadId,
        ),
      15_000,
      "turn 未完成",
    );

    // 只有 1 个 turn：不得出现第二个 turn/started（不新建、不排队）
    assert.equal(
      loop.mock.receivedNotifications.filter(
        (n) =>
          n.method === "turn/started" && (n.params as { threadId: string }).threadId === threadId,
      ).length,
      1,
      "活动期 turn/start 不得触发第二个 turn/started",
    );
    const turns = (await loop.mock.rpc("thread/turns/list", { threadId })) as {
      result: { data: Array<{ id: string }> };
    };
    assert.equal(turns.result.data.length, 1, "活动期 turn/start 不得创建第二个 turn");

    // steer 注入的 userMessage 与其后的 steer 回复都在同一 turn 内
    const completedItems = loop.mock.receivedNotifications
      .filter(
        (n) =>
          n.method === "item/completed" && (n.params as { threadId: string }).threadId === threadId,
      )
      .map((n) => (n.params as { item: { type: string } & Record<string, unknown> }).item);
    const steerUserIndex = completedItems.findIndex(
      (i) => i.type === "userMessage" && (i.content as Array<{ text: string }>)?.[0]?.text === "中途消息",
    );
    assert.ok(steerUserIndex >= 0, "steer 注入的 userMessage 未出现");
    const steerReply = completedItems
      .slice(steerUserIndex + 1)
      .find((i) => i.type === "agentMessage" && String(i.text).includes("steer 注入"));
    assert.ok(steerReply, "steer 注入后应出现含「steer 注入」的回复");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：thread/resume 重订阅（清除 unsubscribe 标记，通知恢复）", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/resub" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;

    // 退订该线程：此后该 thread 的通知被 fanOut 丢弃
    const unsub = (await loop.mock.rpc("thread/unsubscribe", { threadId })) as {
      result: { status: string };
    };
    assert.equal(unsub.result.status, "unsubscribed");
    loop.mock.receivedNotifications.length = 0;

    const ping = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "ping" }],
      clientUserMessageId: "resub-ping",
    })) as { result: { turn: { id: string } } };
    // 退订期间无通知可等，轮询 turns/list 判定完成
    let pingCompleted = false;
    for (let i = 0; i < 100 && !pingCompleted; i++) {
      const turns = (await loop.mock.rpc("thread/turns/list", { threadId })) as {
        result: { data: Array<{ id: string; status: string }> };
      };
      pingCompleted = turns.result.data.some(
        (t) => t.id === ping.result.turn.id && t.status === "completed",
      );
      if (!pingCompleted) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(pingCompleted, "ping turn 未完成");
    assert.ok(
      !loop.mock.receivedNotifications.some(
        (n) =>
          n.method === "item/started" &&
          (n.params as { threadId: string; turnId: string }).turnId === ping.result.turn.id,
      ),
      "退订期间不得收到该 turn 的 item/started",
    );
    assert.ok(
      !loop.mock.receivedNotifications.some(
        (n) => (n.params as { threadId?: string }).threadId === threadId,
      ),
      "退订期间不得收到该 thread 的任何通知",
    );

    // resume 重新订阅：通知恢复
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("thread/resume", { threadId });
    const pong = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "pong" }],
    })) as { result: { turn: { id: string } } };
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "item/started" &&
            (n.params as { turnId: string }).turnId === pong.result.turn.id,
        ),
      8000,
      "resume 后 item/started 未恢复",
    );
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

// ------------------------------------------- S03：模拟层对齐 codex 可达功能

type Notif = { method: string; params: Record<string, any> };
const isNotif = (n: { method: string; params: unknown }, method: string): n is Notif =>
  n.method === method;
/** 查找通知并按 Notif 收窄类型（find 的布尔谓词不会收窄，故显式谓词）。 */
const findNotif = (
  loop: Loop,
  method: string,
  extra?: (p: Record<string, any>) => boolean,
): Notif | undefined =>
  loop.mock.receivedNotifications.find(
    (n): n is Notif => isNotif(n, method) && (extra ? extra(n.params) : true),
  );

/**
 * 等待「下一个」goal turn（不在 knownIds 中的 turn/started）完成，并校验其形状：
 * 恰 1 个 wait 命令条目（标签）、恰 1 条 agentMessage、goal 计量更新（终态与
 * 累计 tokensUsed）。返回 turn id 与消息文本。
 */
async function waitForGoalTurn(
  loop: Awaited<ReturnType<typeof startLoop>>,
  knownIds: string[],
  expect: { wait: string; endStatus: string; tokens: number },
): Promise<{ turnId: string; msgText: string }> {
  await waitFor(
    () =>
      loop.mock.receivedNotifications.some(
        (n) => isNotif(n, "turn/started") && !knownIds.includes(n.params.turn.id),
      ),
    2000,
    "下一个 goal turn 未自动开始",
  );
  const turnId = (loop.mock.receivedNotifications.filter(
    (n) => isNotif(n, "turn/started"),
  ) as Notif[])
    .map((n) => n.params.turn.id as string)
    .find((id) => !knownIds.includes(id))!;
  await waitFor(
    () =>
      loop.mock.receivedNotifications.some(
        (n) => isNotif(n, "turn/completed") && n.params.turn.id === turnId,
      ),
    8000,
    "goal turn 未完成",
  );
  const msgs = loop.mock.receivedNotifications.filter(
    (n) => isNotif(n, "item/completed") && n.params.turnId === turnId && n.params.item?.type === "agentMessage",
  ) as Notif[];
  const waits = loop.mock.receivedNotifications.filter(
    (n) => isNotif(n, "item/completed") && n.params.turnId === turnId && n.params.item?.type === "commandExecution",
  ) as Notif[];
  assert.equal(msgs.length, 1, "每个 goal turn 应输出 1 条 agentMessage");
  assert.equal(waits.length, 1, "每个 goal turn 应有 1 个 wait 命令");
  assert.equal(waits[0].params.item.command, expect.wait, "wait 时长标签");
  const upd = (loop.mock.receivedNotifications.filter(
    (n) => isNotif(n, "thread/goal/updated"),
  ) as Notif[]).find((n) => n.params.turnId === turnId);
  assert.ok(upd, "goal turn 结束应发带 turnId 的计量更新");
  assert.equal(upd.params.goal.status, expect.endStatus, "goal turn 结束终态");
  assert.equal(upd.params.goal.tokensUsed, expect.tokens, "goal 计量累计");
  return { turnId, msgText: String(msgs[0].params.item.text) };
}

test("S03-A goal：set/get 全键、tokenBudget 双层、clear、首轮阶段 3 turn 链式→blocked、再启 1 turn→complete", async () => {
  const loop = await startLoop({ commandWaitMs: 150, stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/goal" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    const set = (await loop.mock.rpc("thread/goal/set", {
      threadId,
      objective: "完成 S03",
      tokenBudget: 5000,
    })) as { result: { goal: Record<string, any> } };
    const goal = set.result.goal;
    assert.deepEqual(Object.keys(goal).sort(), [
      "createdAt",
      "objective",
      "status",
      "threadId",
      "timeUsedSeconds",
      "tokenBudget",
      "tokensUsed",
      "updatedAt",
    ]);
    assert.equal(goal.objective, "完成 S03");
    assert.equal(goal.status, "active");
    assert.equal(goal.tokenBudget, 5000);
    assert.equal(goal.tokensUsed, 0);
    assert.ok(Number.isInteger(goal.createdAt) && Number.isInteger(goal.updatedAt));

    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "thread/goal/updated")),
      2000,
      "thread/goal/updated 未收到",
    );
    const updated = findNotif(loop, "thread/goal/updated")!;
    assert.equal(updated.params.turnId, null, "goal/updated 的 turnId 应为 null");
    assert.equal(updated.params.goal.objective, "完成 S03");

    // 首轮阶段：active goal 空闲线程自动开跑 3 个 goal turn（continue_if_idle +
    // on_thread_idle 链式续跑），每个 turn = 1 个 wait + 1 条输出，无 userMessage
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "turn/started")),
      2000,
      "goal set 后应自动 turn/started",
    );
    assert.equal(findNotif(loop, "turn/started")!.params.turn.items.length, 0, "goal turn/started 不带 items");
    const t1 = await waitForGoalTurn(loop, [], { wait: "wait 10 seconds", endStatus: "active", tokens: 1234 });
    assert.ok(t1.msgText.includes("（goal 1/3）"));
    const t2 = await waitForGoalTurn(loop, [t1.turnId], { wait: "wait 30 seconds", endStatus: "active", tokens: 2468 });
    assert.ok(t2.msgText.includes("（goal 2/3）"));
    const t3 = await waitForGoalTurn(loop, [t1.turnId, t2.turnId], { wait: "wait 10 seconds", endStatus: "blocked", tokens: 3702 });
    assert.ok(t3.msgText.includes("（goal 3/3）"));

    const get = (await loop.mock.rpc("thread/goal/get", { threadId })) as {
      result: { goal: Record<string, any> };
    };
    assert.equal(get.result.goal.status, "blocked");
    assert.equal(get.result.goal.tokensUsed, 3702);
    assert.equal(get.result.goal.objective, "完成 S03", "计量不应改写 objective");
    assert.equal(get.result.goal.tokenBudget, 5000, "计量不应改写 tokenBudget");

    // 再次启动（仅 status active，objective 沿用）：第 4 个 goal turn → complete
    await loop.mock.rpc("thread/goal/set", { threadId, status: "active" });
    const t4 = await waitForGoalTurn(
      loop,
      [t1.turnId, t2.turnId, t3.turnId],
      { wait: "wait 10 seconds", endStatus: "complete", tokens: 4936 },
    );
    assert.ok(t4.msgText.includes("已重新启动目标"));
    assert.ok(
      !loop.mock.receivedNotifications.some((n) => isNotif(n, "thread/goal/cleared")),
      "turn 结束不应发 thread/goal/cleared（仅 clear RPC 发）",
    );
    const userItems = loop.mock.receivedNotifications.filter(
      (n) => isNotif(n, "item/started") && n.params.item?.type === "userMessage",
    );
    assert.equal(userItems.length, 0, "goal turn 不应产生 userMessage item");

    // tokenBudget:null 清除；objective 缺省保留（status 默认沿用 complete，不再续跑）
    const clearedBudget = (await loop.mock.rpc("thread/goal/set", { threadId, tokenBudget: null })) as {
      result: { goal: Record<string, any> };
    };
    assert.equal(clearedBudget.result.goal.tokenBudget, null);
    assert.equal(clearedBudget.result.goal.objective, "完成 S03", "objective 缺省应保留");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      loop.mock.receivedNotifications.filter((n) => isNotif(n, "turn/started")).length,
      4,
      "complete 后不应再自动开跑（共 4 个 goal turn）",
    );

    loop.mock.receivedNotifications.length = 0;
    const c1 = (await loop.mock.rpc("thread/goal/clear", { threadId })) as { result: { cleared: boolean } };
    assert.deepEqual(c1.result, { cleared: true });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "thread/goal/cleared")),
      2000,
      "thread/goal/cleared 未收到",
    );
    const c2 = (await loop.mock.rpc("thread/goal/clear", { threadId })) as { result: { cleared: boolean } };
    assert.deepEqual(c2.result, { cleared: false }, "无 goal 再 clear 应 false");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-A goal：用户 turn 运行中 set active → 计量后续跑首轮阶段 3 turn→blocked，再启 1 turn→complete", async () => {
  const loop = await startLoop({ commandWaitMs: 300, stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/goal-busy" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    // test queue 脚本 turn 有 2×300ms 等待窗口，保证 goal/set 落在 turn 运行中
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "test queue" }] });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "item/started") && n.params.item?.type === "commandExecution",
        ),
      2000,
      "脚本 turn 未进入等待窗口",
    );
    const userTurnId = findNotif(loop, "turn/started")!.params.turn.id;

    // 用户 turn 运行中设置 active goal：不立即开跑（线程忙），当前 turn 结束时计量
    await loop.mock.rpc("thread/goal/set", { threadId, objective: "忙时目标" });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.id === userTurnId,
        ),
      8000,
      "用户 turn 未完成",
    );
    const userAccounted = loop.mock.receivedNotifications
      .filter((n) => isNotif(n, "thread/goal/updated"))
      .find((n) => n.params.turnId === userTurnId);
    assert.ok(userAccounted, "用户 turn 结束应发带 turnId 的 goal 计量更新");
    assert.equal(userAccounted.params.goal.status, "active", "用户 turn 结束 goal 仍为 active");

    // 线程空闲 → 首轮阶段 3 个 goal turn 链式续跑（wait 10/30/10 秒）→ blocked
    const g1 = await waitForGoalTurn(loop, [userTurnId], { wait: "wait 10 seconds", endStatus: "active", tokens: 2468 });
    assert.ok(g1.msgText.includes("（goal 1/3）"));
    const g2 = await waitForGoalTurn(loop, [userTurnId, g1.turnId], { wait: "wait 30 seconds", endStatus: "active", tokens: 3702 });
    assert.ok(g2.msgText.includes("（goal 2/3）"));
    const g3 = await waitForGoalTurn(loop, [userTurnId, g1.turnId, g2.turnId], { wait: "wait 10 seconds", endStatus: "blocked", tokens: 4936 });
    assert.ok(g3.msgText.includes("（goal 3/3）"));

    // 再次启动：第 4 个 goal turn（wait 10 秒 + 1 条输出）→ complete
    await loop.mock.rpc("thread/goal/set", { threadId, status: "active" });
    const g4 = await waitForGoalTurn(
      loop,
      [userTurnId, g1.turnId, g2.turnId, g3.turnId],
      { wait: "wait 10 seconds", endStatus: "complete", tokens: 6170 },
    );
    assert.ok(g4.msgText.includes("已重新启动目标"));

    // 循环有界：complete 后不再有新 turn
    await new Promise((r) => setTimeout(r, 80));
    const turnStarts = loop.mock.receivedNotifications.filter((n) => isNotif(n, "turn/started"));
    assert.equal(turnStarts.length, 5, "用户 turn + 4 个 goal turn 后不应再自动开跑");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-A goal turn 运行中 turn/start → steer 注入当前 goal turn，链式续跑不受影响", async () => {
  const loop = await startLoop({ commandWaitMs: 300, stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/goal-steer" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    await loop.mock.rpc("thread/goal/set", { threadId, objective: "steer 目标" });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "turn/started")),
      2000,
      "goal set 后应自动 turn/started",
    );
    const g1 = findNotif(loop, "turn/started")!.params.turn.id as string;
    // 等 wait 命令开始（10s→200ms 窗口），在其间发送用户消息
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/started") &&
            n.params.item?.type === "commandExecution" &&
            n.params.turnId === g1,
        ),
      2000,
      "goal turn 未进入等待窗口",
    );

    // 活动期 turn/start → steer：返回同一 goal turn（start_or_steer_turn 的 Steered）
    const steered = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "插话" }],
    })) as { result: { turn: { id: string } } };
    assert.equal(steered.result.turn.id, g1, "turn/start 应 steer 进当前 goal turn（返回同一 turn id）");

    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.id === g1,
        ),
      8000,
      "goal turn 未完成",
    );
    // steer 消息作为 userMessage item 挂在同一 goal turn 内
    const steerUser = loop.mock.receivedNotifications
      .filter((n) => isNotif(n, "item/completed"))
      .find((n) => n.params.turnId === g1 && n.params.item?.type === "userMessage");
    assert.ok(steerUser, "steer 消息应作为 userMessage item 挂在 goal turn 内");
    assert.equal(steerUser.params.item.content?.[0]?.text, "插话");
    // turn 内 2 条 agentMessage：steer 回复在前，goal 1/3 消息在后；计量不变
    const msgs = loop.mock.receivedNotifications.filter(
      (n) =>
        isNotif(n, "item/completed") &&
        n.params.turnId === g1 &&
        n.params.item?.type === "agentMessage",
    ) as Notif[];
    assert.equal(msgs.length, 2, "steer 回复 + goal 输出共 2 条 agentMessage");
    assert.ok(String(msgs[0].params.item.text).includes("插话"), "steer 回复在前");
    assert.ok(String(msgs[1].params.item.text).includes("（goal 1/3）"), "goal 输出在后");
    const upd1 = loop.mock.receivedNotifications
      .filter((n) => isNotif(n, "thread/goal/updated"))
      .find((n) => n.params.turnId === g1);
    assert.ok(upd1, "g1 结束应有计量更新");
    assert.equal(upd1.params.goal.status, "active");
    assert.equal(upd1.params.goal.tokensUsed, 1234, "steer 不改变每 turn 计量");

    // 链式续跑照常：2/3（30 秒 wait）→ 3/3 blocked
    const g2 = await waitForGoalTurn(loop, [g1], { wait: "wait 30 seconds", endStatus: "active", tokens: 2468 });
    assert.ok(g2.msgText.includes("（goal 2/3）"));
    const g3 = await waitForGoalTurn(loop, [g1, g2.turnId], { wait: "wait 10 seconds", endStatus: "blocked", tokens: 3702 });
    assert.ok(g3.msgText.includes("（goal 3/3）"));

    // steer 不新建 turn：全程恰 3 个 turn/started
    const starts = loop.mock.receivedNotifications.filter((n) => isNotif(n, "turn/started"));
    assert.equal(new Set(starts.map((n) => n.params.turn.id as string)).size, 3, "steer 不新建 turn");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-A goal turn 中止后：goal 自动续跑（Interrupted 不拦 goal），排队消息挂起至 blocked 后才开跑", async () => {
  const loop = await startLoop({ commandWaitMs: 600, stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/goal-interrupt" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    await loop.mock.rpc("thread/goal/set", { threadId, objective: "中止目标" });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "turn/started")),
      2000,
      "goal set 后应自动 turn/started",
    );
    const g1 = findNotif(loop, "turn/started")!.params.turn.id as string;
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/started") &&
            n.params.item?.type === "commandExecution" &&
            n.params.turnId === g1,
        ),
      2000,
      "goal turn 未进入等待窗口",
    );

    // 等待窗口内：排队一条消息 + 中止当前 goal turn（10s→400ms 窗口）
    await loop.mock.rpc("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: "排队Z" }],
      clientUserMessageId: "q-z",
    });
    await loop.mock.rpc("turn/interrupt", { threadId });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.id === g1,
        ),
      8000,
      "goal turn 未被中止",
    );
    // 中止也计量（on_turn_abort → account_active_goal_progress）
    const upd1 = loop.mock.receivedNotifications
      .filter((n) => isNotif(n, "thread/goal/updated"))
      .find((n) => n.params.turnId === g1);
    assert.ok(upd1, "中止的 goal turn 也应有计量更新");
    assert.equal(upd1.params.goal.status, "active", "turn 中止 ≠ goal 停止");
    assert.equal(upd1.params.goal.tokensUsed, 1234);

    // 中止态下排队消息不得自动开跑（此刻唯一在途调度是 goal 续跑）
    assert.ok(
      !loop.mock.receivedNotifications.some(
        (n) =>
          isNotif(n, "item/completed") &&
          n.params.item?.type === "userMessage" &&
          n.params.item.content?.[0]?.text === "排队Z",
      ),
      "中止后排队消息不应自动开跑",
    );

    // goal 续跑：阶段索引已耗 1 轮 → 下一个是（goal 2/3），round=2 → 30 秒 wait
    const g2 = await waitForGoalTurn(loop, [g1], { wait: "wait 30 seconds", endStatus: "active", tokens: 2468 });
    assert.ok(g2.msgText.includes("（goal 2/3）"));

    // g2 完成 = Completed idle：队列先于 goal 续跑（queue 扩展注册在前）→ 排队Z
    // 作为普通用户 turn 开跑，goal 计量照加
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/completed") &&
            n.params.item?.type === "userMessage" &&
            n.params.item.content?.[0]?.text === "排队Z",
        ),
      8000,
      "g2 完成后排队消息未开跑",
    );
    const zItem = loop.mock.receivedNotifications
      .filter((n) => isNotif(n, "item/completed"))
      .find(
        (n) =>
          n.params.item?.type === "userMessage" &&
          n.params.item.content?.[0]?.text === "排队Z",
      )!;
    const zTurnId = zItem.params.turnId as string;
    const zUpd = loop.mock.receivedNotifications
      .filter((n) => isNotif(n, "thread/goal/updated"))
      .find((n) => n.params.turnId === zTurnId);
    assert.ok(zUpd, "排队 turn 结束也应有 goal 计量更新");
    assert.equal(zUpd.params.goal.status, "active", "排队 turn 后 goal 仍为 active");
    assert.equal(zUpd.params.goal.tokensUsed, 3702, "排队 turn 计量 +1234");

    // 队列排空后 goal 继续：g3 → blocked（累计 4936）
    const g3 = await waitForGoalTurn(loop, [g1, g2.turnId, zTurnId], { wait: "wait 10 seconds", endStatus: "blocked", tokens: 4936 });
    assert.ok(g3.msgText.includes("（goal 3/3）"));

    // 顺序：g2 完成 → 排队Z 开跑 → g3 开跑
    const notifs = loop.mock.receivedNotifications;
    const g2DoneIdx = notifs.findIndex(
      (n) => isNotif(n, "turn/completed") && n.params.turn.id === g2.turnId,
    );
    const zStartIdx = notifs.findIndex(
      (n) => isNotif(n, "turn/started") && n.params.turn.id === zTurnId,
    );
    const g3StartIdx = notifs.findIndex(
      (n) => isNotif(n, "turn/started") && n.params.turn.id === g3.turnId,
    );
    assert.ok(g2DoneIdx >= 0 && zStartIdx > g2DoneIdx, "排队消息应在 g2 完成后开跑");
    assert.ok(g3StartIdx > zStartIdx, "排队消息跑完后 goal 才继续");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：空闲线程 thread/queue/add 立即唤醒开跑（对齐 wake_if_loaded）", async () => {
  const loop = await startLoop({ stepDelayMs: 20, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/qwake" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    await loop.mock.rpc("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: "唤醒消息" }],
      clientUserMessageId: "q-w",
    });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "turn/started")),
      3000,
      "空闲线程入队未自动开跑",
    );
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "turn/completed")),
      5000,
      "唤醒 turn 未完成",
    );
    const userMsg = loop.mock.receivedNotifications.find(
      (n) =>
        isNotif(n, "item/completed") &&
        n.params.item?.type === "userMessage" &&
        n.params.item.content?.[0]?.text === "唤醒消息",
    );
    assert.ok(userMsg, "入队消息应作为 turn 的 userMessage 开跑");
    const qList = (await loop.mock.rpc("thread/queue/list", { threadId })) as {
      result: { data: unknown[] };
    };
    assert.equal(qList.result.data.length, 0, "开跑后队列应已消费");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-A resume 快照：响应先于 goal 通知上线（updated / cleared）", async () => {
  const loop = await startLoop({ stepDelayMs: 5 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/goal-resume" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    // paused：不触发 goal 自动续跑（active 会开跑 goal turn，其计量通知会与
    // resume 的快照通知在 envelope 时序上竞争）
    await loop.mock.rpc("thread/goal/set", { threadId, objective: "resume 快照", status: "paused" });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "thread/goal/updated")),
      2000,
      "set 的 goal/updated 未到",
    );

    loop.mock.receivedEnvelopeLog.length = 0;
    const resumed = (await loop.mock.rpc("thread/resume", { threadId })) as { id: number; result: any };
    await waitFor(
      () =>
        loop.mock.receivedEnvelopeLog.some(
          (e) => e.kind === "notification" && e.method === "thread/goal/updated",
        ),
      2000,
      "resume 快照 goal/updated 未到",
    );
    const log = loop.mock.receivedEnvelopeLog;
    const respIdx = log.findIndex((e) => e.kind === "response" && String(e.id) === String(resumed.id));
    const goalIdx = log.findIndex((e) => e.kind === "notification" && e.method === "thread/goal/updated");
    assert.ok(respIdx >= 0, "resume 响应应在时序日志中");
    assert.ok(goalIdx > respIdx, "goal 快照通知必须晚于 resume 响应上线");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("F3 回归：goal set/clear 通知晚于响应上线", async () => {
  const loop = await startLoop({ stepDelayMs: 5 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/goal-order" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;

    loop.mock.receivedEnvelopeLog.length = 0;
    const set = (await loop.mock.rpc("thread/goal/set", { threadId, objective: "次序" })) as { id: number };
    await waitFor(
      () =>
        loop.mock.receivedEnvelopeLog.some(
          (e) => e.kind === "notification" && e.method === "thread/goal/updated",
        ),
      2000,
      "thread/goal/updated 未到",
    );
    const setLog = loop.mock.receivedEnvelopeLog;
    const setResp = setLog.findIndex((e) => e.kind === "response" && String(e.id) === String(set.id));
    const updatedIdx = setLog.findIndex((e) => e.kind === "notification" && e.method === "thread/goal/updated");
    assert.ok(setResp >= 0, "set 响应应在时序日志中");
    assert.ok(updatedIdx > setResp, "goal/updated 必须晚于 set 响应上线");

    loop.mock.receivedEnvelopeLog.length = 0;
    const clear = (await loop.mock.rpc("thread/goal/clear", { threadId })) as { id: number };
    await waitFor(
      () =>
        loop.mock.receivedEnvelopeLog.some(
          (e) => e.kind === "notification" && e.method === "thread/goal/cleared",
        ),
      2000,
      "thread/goal/cleared 未到",
    );
    const clearLog = loop.mock.receivedEnvelopeLog;
    const clearResp = clearLog.findIndex((e) => e.kind === "response" && String(e.id) === String(clear.id));
    const clearedIdx = clearLog.findIndex((e) => e.kind === "notification" && e.method === "thread/goal/cleared");
    assert.ok(clearResp >= 0, "clear 响应应在时序日志中");
    assert.ok(clearedIdx > clearResp, "goal/cleared 必须晚于 clear 响应上线");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("F3 回归：goalSet 入参校验（非法 status / 非数字 tokenBudget）", async () => {
  const loop = await startLoop({ stepDelayMs: 5 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/goal-validate" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;

    const badStatus = (await loop.mock.rpc("thread/goal/set", { threadId, status: "bogus" })) as {
      error?: { code: number; message: string };
    };
    assert.equal(badStatus.error?.code, -32600);
    assert.equal(badStatus.error?.message, "invalid goal status: bogus");

    const badBudget = (await loop.mock.rpc("thread/goal/set", { threadId, tokenBudget: "abc" })) as {
      error?: { code: number; message: string };
    };
    assert.equal(badBudget.error?.code, -32600);
    assert.equal(badBudget.error?.message, "invalid tokenBudget");

    // 失败请求不得写入 goal
    const get = (await loop.mock.rpc("thread/goal/get", { threadId })) as { result: { goal: unknown } };
    assert.equal(get.result.goal, null, "非法入参不得留下 goal");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-B compact：contextCompaction 条目 + 下一条回复标记（用后即清）", async () => {
  const loop = await startLoop({ compactWaitMs: 30, stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/compact" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    const compact = (await loop.mock.rpc("thread/compact/start", { threadId })) as { result: unknown };
    assert.deepEqual(compact.result, {});
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "item/completed") && n.params.item.type === "contextCompaction",
        ),
      5000,
      "contextCompaction completed 未收到",
    );
    assert.ok(
      loop.mock.receivedNotifications.some(
        (n) => isNotif(n, "item/started") && n.params.item.type === "contextCompaction",
      ),
      "contextCompaction started 未收到",
    );
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.status === "completed",
        ),
      5000,
      "compact turn 未完成",
    );

    // 下一条普通 turn：首行「刚刚经历过compact」
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "after-compact" }] });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "item/completed") && n.params.item.type === "agentMessage",
        ),
      5000,
      "compact 后回复未到",
    );
    const firstReply = findNotif(
      loop,
      "item/completed",
      (p) => p.item.type === "agentMessage",
    )!;
    assert.equal(
      String(firstReply.params.item.text).split("\n")[0],
      "刚刚经历过compact",
      "compact 后首条回复首行应为标记",
    );

    // 第二条不再带
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "second" }] });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "item/completed") && n.params.item.type === "agentMessage",
        ),
      5000,
      "第二条回复未到",
    );
    const secondReply = findNotif(
      loop,
      "item/completed",
      (p) => p.item.type === "agentMessage",
    )!;
    assert.ok(
      !String(secondReply.params.item.text).startsWith("刚刚经历过compact"),
      "标记用后即清（第二条不得再带）",
    );
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-B compact 双入口拒绝：steer -32600 / turn-start -32603", async () => {
  const loop = await startLoop({ compactWaitMs: 500 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/compact-reject" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    await loop.mock.rpc("thread/compact/start", { threadId });

    const steer = (await loop.mock.rpc("turn/steer", {
      threadId,
      expectedTurnId: "01a0dc13-0000-0000-0000-000000000000",
      input: [{ type: "text", text: "中途" }],
    })) as { error?: { code: number; message: string } };
    assert.equal(steer.error?.code, -32600);
    assert.equal(steer.error?.message, "cannot steer a compact turn");

    const start = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "接管" }],
    })) as { error?: { code: number; message: string } };
    assert.equal(start.error?.code, -32603);
    assert.match(String(start.error?.message), /^failed to submit turn input: .*Compact/);
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-B compact 打断活动 turn：原 turn interrupted，compact 完成后 idle", async () => {
  const loop = await startLoop({ commandWaitMs: 5000, compactWaitMs: 20, stepDelayMs: 10, deltaIntervalMs: 1 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/compact-interrupt" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "test queue" }] });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "item/started") && n.params.item.type === "commandExecution",
        ),
      8000,
      "活动 turn 的模拟命令未进入 inProgress",
    );
    await loop.mock.rpc("thread/compact/start", { threadId });

    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.status === "interrupted",
        ),
      5000,
      "原 turn 未 interrupted",
    );
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.status === "completed",
        ),
      5000,
      "compact turn 未完成",
    );
    const statuses = loop.mock.receivedNotifications.filter((n) => isNotif(n, "thread/status/changed"));
    assert.equal(
      (statuses[statuses.length - 1]!.params.status as { type: string }).type,
      "idle",
      "compact 完成后最后状态应为 idle",
    );
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-B 队列不因 compact 打断丢失：完成后排队消息开跑", async () => {
  const loop = await startLoop({ commandWaitMs: 5000, compactWaitMs: 30, stepDelayMs: 10, deltaIntervalMs: 1 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/compact-queue" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "test queue" }] });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "item/started") && n.params.item.type === "commandExecution",
        ),
      8000,
      "活动 turn 未进入等待",
    );
    await loop.mock.rpc("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: "排队C" }],
      clientUserMessageId: "q-c",
    });
    await loop.mock.rpc("thread/compact/start", { threadId });

    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/completed") &&
            n.params.item.type === "userMessage" &&
            n.params.item.content?.[0]?.text === "排队C",
        ),
      8000,
      "排队消息未在 compact 后开跑",
    );
    const notifs = loop.mock.receivedNotifications;
    const compactStarted = findNotif(loop, "item/started", (p) => p.item.type === "contextCompaction")!;
    const compactTurnId = compactStarted.params.turnId as string;
    const compactDoneIdx = notifs.findIndex(
      (n) => isNotif(n, "turn/completed") && n.params.turn.id === compactTurnId,
    );
    const queuedIdx = notifs.findIndex(
      (n) =>
        isNotif(n, "item/completed") &&
        n.params.item.type === "userMessage" &&
        n.params.item.content?.[0]?.text === "排队C",
    );
    assert.ok(compactDoneIdx >= 0, "compact turn 应完成");
    assert.ok(queuedIdx > compactDoneIdx, "排队消息应在 compact 完成后才开跑");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-B consumeQueue 竞态 MB3：compact 接管窗口内排队消息不被覆盖/丢失", async () => {
  // stepDelayMs=500 制造 turn 完成 → 队列续跑之间的等待窗口；compactWaitMs=800
  // 令 compact 跨越该窗口，触发 consumeQueue 回调的 MB3 检查。
  const loop = await startLoop({ stepDelayMs: 500, deltaIntervalMs: 1, deltaChars: 64, compactWaitMs: 800 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/compact-race" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    await loop.mock.rpc("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: "排队M" }],
      clientUserMessageId: "q-m",
    });
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "主任务" }] });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.status === "completed",
        ),
      5000,
      "主 turn 未完成",
    );
    // 主 turn 完成后 consumeQueue 已排下续跑计时器（stepDelayMs=500ms 窗口）；
    // 该窗口内 compact 接管
    await loop.mock.rpc("thread/compact/start", { threadId });

    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/completed") &&
            n.params.item.type === "userMessage" &&
            n.params.item.content?.[0]?.text === "排队M",
        ),
      8000,
      "排队消息未在 compact 后开跑",
    );
    const notifs = loop.mock.receivedNotifications;
    const compactStarted = findNotif(loop, "item/started", (p) => p.item.type === "contextCompaction")!;
    const compactTurnId = compactStarted.params.turnId as string;
    const compactDoneIdx = notifs.findIndex(
      (n) => isNotif(n, "turn/completed") && n.params.turn.id === compactTurnId,
    );
    assert.ok(compactDoneIdx >= 0, "compact turn 未被覆盖，应正常完成");
    const queuedUserIdx = notifs.findIndex(
      (n) =>
        isNotif(n, "item/completed") &&
        n.params.item.type === "userMessage" &&
        n.params.item.content?.[0]?.text === "排队M",
    );
    assert.ok(queuedUserIdx > compactDoneIdx, "排队消息应在 compact 完成后开跑");
    assert.equal(
      notifs.filter(
        (n) =>
          isNotif(n, "item/started") &&
          n.params.item.type === "userMessage" &&
          n.params.item.content?.[0]?.text === "排队M",
      ).length,
      1,
      "排队消息应恰好开跑一次",
    );
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-C plan：collaborationMode 闭环 + 回复前缀 + turn/plan/updated", async () => {
  const loop = await startLoop({ stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/plan" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;

    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("thread/settings/update", {
      threadId,
      collaborationMode: {
        mode: "plan",
        settings: { model: "gpt-6-luna", reasoning_effort: "medium", developer_instructions: null },
      },
    });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "thread/settings/updated")),
      2000,
      "thread/settings/updated 未到",
    );
    const settingsUpdated = findNotif(loop, "thread/settings/updated")!;
    assert.equal(settingsUpdated.params.threadSettings.collaborationMode.mode, "plan");

    const resumed = (await loop.mock.rpc("thread/resume", { threadId })) as {
      result: { collaborationMode: { mode: string; settings: Record<string, unknown> } };
    };
    assert.equal(resumed.result.collaborationMode.mode, "plan");
    assert.ok("developer_instructions" in resumed.result.collaborationMode.settings);

    // plan 下 turn：前缀 + plan 通知
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "做个计划" }] });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "turn/plan/updated")),
      5000,
      "turn/plan/updated 未到",
    );
    const reply = findNotif(
      loop,
      "item/completed",
      (p) => p.item.type === "agentMessage",
    )!;
    assert.equal(String(reply.params.item.text).split("\n")[0], "【Plan 模式（模拟）】");
    const planUpdated = findNotif(loop, "turn/plan/updated")!;
    assert.deepEqual(planUpdated.params.plan, [
      { step: "第一步：梳理任务", status: "completed" },
      { step: "第二步：等待用户确认", status: "pending" },
    ]);
    assert.equal(planUpdated.params.explanation, "模拟计划：展示 plan 通知形状");
    assert.equal(planUpdated.params.turnId, reply.params.turnId);
    assert.ok(
      loop.mock.receivedNotifications.some((n) => isNotif(n, "item/plan/delta")),
      "应下发 item/plan/delta",
    );

    // turn/start collaborationMode(default) 切回：不再前缀
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "切回默认" }],
      collaborationMode: {
        mode: "default",
        settings: { model: "gpt-6-luna", reasoning_effort: "medium", developer_instructions: null },
      },
    });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "item/completed") && n.params.item.type === "agentMessage",
        ),
      5000,
      "切回后回复未到",
    );
    const reply2 = findNotif(
      loop,
      "item/completed",
      (p) => p.item.type === "agentMessage",
    )!;
    assert.ok(!String(reply2.params.item.text).startsWith("【Plan 模式（模拟）】"));
    assert.ok(
      !loop.mock.receivedNotifications.some((n) => isNotif(n, "turn/plan/updated")),
      "default 模式不应发 turn/plan/updated",
    );
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-D status：server/diagnostics、remoteControl/status/read、memory/status", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });

    const diag = (await loop.mock.rpc("server/diagnostics", {})) as {
      result: { process: Record<string, unknown>; gauges: unknown[] };
    };
    assert.deepEqual(Object.keys(diag.result).sort(), ["gauges", "process"]);
    assert.equal(typeof diag.result.process.id, "number");
    assert.ok(Array.isArray(diag.result.gauges));

    const rc = (await loop.mock.rpc("remoteControl/status/read", {})) as {
      result: { status: string; serverName: unknown; installationId: unknown; environmentId: unknown };
    };
    assert.deepEqual(Object.keys(rc.result).sort(), ["environmentId", "installationId", "serverName", "status"]);
    assert.equal(rc.result.status, "disabled");
    assert.equal(rc.result.environmentId, null);

    const mem = (await loop.mock.rpc("memory/status", {})) as {
      result: { v2ConsolidatedThreads: number; v2Ready: boolean };
    };
    assert.deepEqual(mem.result, { v2ConsolidatedThreads: 0, v2Ready: false });
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-E side：shellCommand 命令条目 + backgroundTerminals list/terminate/clean", async () => {
  const loop = await startLoop({ shellWaitMs: 20, stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/shell" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    const empty = (await loop.mock.rpc("thread/shellCommand", { threadId, command: "" })) as {
      error?: { code: number; message: string };
    };
    assert.equal(empty.error?.code, -32600);
    assert.equal(empty.error?.message, "command must not be empty");

    const ok = (await loop.mock.rpc("thread/shellCommand", { threadId, command: "echo hi" })) as {
      result: unknown;
    };
    assert.deepEqual(ok.result, {}, "shellCommand 应立即返回 {}");
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/completed") &&
            n.params.item.type === "commandExecution" &&
            n.params.item.status === "completed",
        ),
      5000,
      "shell commandExecution completed 未到",
    );
    const completed = findNotif(
      loop,
      "item/completed",
      (p) => p.item.type === "commandExecution" && p.item.status === "completed",
    )!;
    assert.equal(completed.params.item.exitCode, 0);
    assert.ok(String(completed.params.item.aggregatedOutput).includes("（未调用真实 shell）"));
    assert.ok(
      loop.mock.receivedNotifications.some((n) => isNotif(n, "item/commandExecution/outputDelta")),
      "应下发 outputDelta",
    );

    const list = (await loop.mock.rpc("thread/backgroundTerminals/list", { threadId })) as {
      result: { data: Array<Record<string, unknown>>; nextCursor: unknown };
    };
    assert.equal(list.result.nextCursor, null);
    assert.equal(list.result.data.length, 1);
    const entry = list.result.data[0]!;
    assert.deepEqual(Object.keys(entry).sort(), [
      "command",
      "cpuPercent",
      "cwd",
      "itemId",
      "osPid",
      "processId",
      "rssKb",
    ]);
    assert.equal(entry.command, "echo hi");
    assert.equal(entry.osPid, null);
    assert.equal(entry.cpuPercent, null);
    assert.equal(entry.rssKb, null);

    const processId = String(entry.processId);
    const hit = (await loop.mock.rpc("thread/backgroundTerminals/terminate", { threadId, processId })) as {
      result: { terminated: boolean };
    };
    assert.deepEqual(hit.result, { terminated: true });
    const miss = (await loop.mock.rpc("thread/backgroundTerminals/terminate", {
      threadId,
      processId: "999999999",
    })) as { result: { terminated: boolean } };
    assert.deepEqual(miss.result, { terminated: false });
    const bad = (await loop.mock.rpc("thread/backgroundTerminals/terminate", {
      threadId,
      processId: "not-a-number",
    })) as { error?: { code: number } };
    assert.equal(bad.error?.code, -32600);

    const clean = (await loop.mock.rpc("thread/backgroundTerminals/clean", { threadId })) as {
      result: unknown;
    };
    assert.deepEqual(clean.result, {});
    const list2 = (await loop.mock.rpc("thread/backgroundTerminals/list", { threadId })) as {
      result: { data: unknown[] };
    };
    assert.equal(list2.result.data.length, 0, "clean 后列表应为空");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("F1 回归：独立 shell turn 期间 turn/start 不吞消息（steer 语义排水）", async () => {
  const loop = await startLoop({ shellWaitMs: 250, stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/shell-f1-start" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    // 无活动 turn → thread/shellCommand 创建独立轻量 shell turn
    await loop.mock.rpc("thread/shellCommand", { threadId, command: "echo hi" });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "turn/started")),
      2000,
      "shell turn/started 未到",
    );
    const shellTurnId = findNotif(loop, "turn/started")!.params.turn.id as string;

    // shell 进行中发消息：活动期 turn/start 转 steer，必须返回同一 turn id，不得丢失
    const ts = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "重要消息" }],
    })) as { result: { turn: { id: string } } };
    assert.equal(ts.result.turn.id, shellTurnId, "活动 shell turn 期间 turn/start 应返回同一 turn");
    const q0 = (await loop.mock.rpc("thread/queue/list", { threadId })) as { result: { data: unknown[] } };
    assert.equal(q0.result.data.length, 0, "steer 路径不得入队");

    // shell 条目 completed 后，消息以 userMessage 注入（steer 语义）并得到 agentMessage 回复
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/completed") &&
            n.params.item.type === "commandExecution" &&
            n.params.item.status === "completed",
        ),
      5000,
      "shell 条目未完成",
    );
    const steerFinder = (n: { method: string; params: unknown }) =>
      isNotif(n, "item/started") &&
      n.params.item.type === "userMessage" &&
      String(n.params.item.content?.[0]?.text ?? "").includes("重要消息");
    await waitFor(() => loop.mock.receivedNotifications.some(steerFinder), 5000, "steer 消息未注入为 userMessage");
    const steerMsg = loop.mock.receivedNotifications.find(steerFinder)! as Notif;
    assert.equal(steerMsg.params.turnId, shellTurnId, "steer 注入应归属 shell turn");
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/completed") &&
            n.params.item.type === "agentMessage" &&
            String(n.params.item.text).includes("steer 注入"),
        ),
      5000,
      "steer 回复未到",
    );

    const turns = (await loop.mock.rpc("thread/turns/list", { threadId })) as {
      result: { data: Array<{ id: string }> };
    };
    assert.equal(turns.result.data.length, 1, "steer 不得新建 turn");
    const q = (await loop.mock.rpc("thread/queue/list", { threadId })) as { result: { data: unknown[] } };
    assert.equal(q.result.data.length, 0, "queue 全程为空");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("F1 回归：独立 shell turn 期间 turn/steer 不吞消息", async () => {
  const loop = await startLoop({ shellWaitMs: 250, stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/shell-f1-steer" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    await loop.mock.rpc("thread/shellCommand", { threadId, command: "echo hi" });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => isNotif(n, "turn/started")),
      2000,
      "shell turn/started 未到",
    );
    const shellTurnId = findNotif(loop, "turn/started")!.params.turn.id as string;

    // 不传 expectedTurnId：断言服务器确实把 steer 注入 shell turn
    const st = (await loop.mock.rpc("turn/steer", {
      threadId,
      input: [{ type: "text", text: "重要消息" }],
    })) as { result: { turnId: string } };
    assert.equal(st.result.turnId, shellTurnId, "turn/steer 应定位到活动 shell turn");

    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/completed") &&
            n.params.item.type === "commandExecution" &&
            n.params.item.status === "completed",
        ),
      5000,
      "shell 条目未完成",
    );
    const steerFinder = (n: { method: string; params: unknown }) =>
      isNotif(n, "item/started") &&
      n.params.item.type === "userMessage" &&
      String(n.params.item.content?.[0]?.text ?? "").includes("重要消息");
    await waitFor(() => loop.mock.receivedNotifications.some(steerFinder), 5000, "steer 消息未注入为 userMessage");
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/completed") &&
            n.params.item.type === "agentMessage" &&
            String(n.params.item.text).includes("steer 注入"),
        ),
      5000,
      "steer 回复未到",
    );

    const turns = (await loop.mock.rpc("thread/turns/list", { threadId })) as {
      result: { data: Array<{ id: string }> };
    };
    assert.equal(turns.result.data.length, 1, "steer 不得新建 turn");
    const q = (await loop.mock.rpc("thread/queue/list", { threadId })) as { result: { data: unknown[] } };
    assert.equal(q.result.data.length, 0, "queue 全程为空");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("F2 回归：attached shell 随父 turn 自然结束补发 failed 条目并登记后台终端", async () => {
  const loop = await startLoop({ shellWaitMs: 500, stepDelayMs: 150, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/shell-f2" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    loop.mock.receivedNotifications.length = 0;

    // 普通 turn 进行中（stepDelayMs=150 制造窗口）挂一条 shellCommand
    const ts = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "父 turn" }],
    })) as { result: { turn: { id: string } } };
    const parentTurnId = ts.result.turn.id;
    await loop.mock.rpc("thread/shellCommand", { threadId, command: "long-running" });

    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "item/started") && n.params.item.type === "commandExecution",
        ),
      2000,
      "attached shell item/started 未到",
    );
    const shellStarted = findNotif(loop, "item/started", (p) => p.item.type === "commandExecution")!;
    assert.equal(shellStarted.params.turnId, parentTurnId, "attached 条目应挂父 turn");

    // 父 turn 先自然完成（非打断）
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.id === parentTurnId,
        ),
      5000,
      "父 turn 未自然完成",
    );

    // shell 条目随后以 failed 终态补发（此前会悬挂；对齐 codex 取消路径 user_shell.rs:247-274）
    const itemId = shellStarted.params.item.id as string;
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            isNotif(n, "item/completed") &&
            n.params.item.type === "commandExecution" &&
            n.params.item.id === itemId,
        ),
      5000,
      "attached shell 条目未终结（悬挂）",
    );
    const shellCompleted = findNotif(
      loop,
      "item/completed",
      (p) => p.item.type === "commandExecution" && p.item.id === itemId,
    )!;
    assert.equal(shellCompleted.params.item.status, "failed");
    assert.equal(shellCompleted.params.item.exitCode, -1);
    assert.equal(
      shellCompleted.params.item.aggregatedOutput,
      "command aborted by user（模拟：父 turn 已结束）",
    );
    assert.ok(
      String(shellCompleted.params.item.aggregatedOutput).includes("command aborted"),
      "aggregatedOutput 应含 codex 取消文案 command aborted",
    );
    assert.ok(
      typeof shellCompleted.params.item.durationMs === "number" && shellCompleted.params.item.durationMs >= 1,
      "durationMs 应为实测数字",
    );
    assert.equal(shellCompleted.params.turnId, parentTurnId, "条目仍归属父 turn");

    // 条目登记进后台终端（turn 结束后仍存活），list 返回且进程指标为 null
    const list = (await loop.mock.rpc("thread/backgroundTerminals/list", { threadId })) as {
      result: { data: Array<Record<string, unknown>> };
    };
    assert.equal(list.result.data.length, 1, "attached shell 应登记后台终端");
    const entry = list.result.data[0]!;
    assert.equal(entry.itemId, itemId);
    assert.equal(entry.command, "long-running");
    assert.equal(entry.osPid, null);
    assert.equal(entry.cpuPercent, null);
    assert.equal(entry.rssKb, null);
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-F branch：metadata/update 双层语义、错误文案、fork 截断历史", async () => {
  const loop = await startLoop({ stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/branch" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;

    // 设 sha+branch
    const m1 = (await loop.mock.rpc("thread/metadata/update", {
      threadId,
      gitInfo: { sha: "abc123", branch: "main" },
    })) as { result: { thread: { gitInfo: Record<string, unknown> } } };
    assert.deepEqual(m1.result.thread.gitInfo, { sha: "abc123", branch: "main", originUrl: null });

    // resume 返回带 gitInfo
    const resumed = (await loop.mock.rpc("thread/resume", { threadId })) as {
      result: { thread: { gitInfo: Record<string, unknown> } };
    };
    assert.deepEqual(resumed.result.thread.gitInfo, { sha: "abc123", branch: "main", originUrl: null });

    // branch:null 清除、sha 缺省保留
    const m2 = (await loop.mock.rpc("thread/metadata/update", {
      threadId,
      gitInfo: { branch: null },
    })) as { result: { thread: { gitInfo: Record<string, unknown> } } };
    assert.deepEqual(m2.result.thread.gitInfo, { sha: "abc123", branch: null, originUrl: null });

    // 错误文案
    const none = (await loop.mock.rpc("thread/metadata/update", { threadId })) as {
      error?: { code: number; message: string };
    };
    assert.equal(none.error?.code, -32600);
    assert.equal(none.error?.message, "thread metadata update must include at least one field");
    const emptyGit = (await loop.mock.rpc("thread/metadata/update", { threadId, gitInfo: {} })) as {
      error?: { code: number; message: string };
    };
    assert.equal(emptyGit.error?.code, -32600);
    assert.equal(emptyGit.error?.message, "gitInfo must include at least one field");
    const proj = (await loop.mock.rpc("thread/metadata/update", { threadId, projectId: "p1" })) as {
      error?: { code: number; message: string };
    };
    assert.equal(proj.error?.code, -32600);
    assert.equal(proj.error?.message, "project not found: p1");

    // 两轮 turn
    const t1 = (await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "第一轮" }] })) as {
      result: { turn: { id: string } };
    };
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.id === t1.result.turn.id,
        ),
      5000,
      "第一轮未完成",
    );
    const t2 = (await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "第二轮" }] })) as {
      result: { turn: { id: string } };
    };
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.id === t2.result.turn.id,
        ),
      5000,
      "第二轮未完成",
    );

    // fork 截至第一轮
    const fork = (await loop.mock.rpc("thread/fork", { threadId, lastTurnId: t1.result.turn.id })) as {
      result: { thread: { id: string; turns: unknown[]; forkedFromId: string; preview: string } } & Record<string, unknown>;
    };
    assert.notEqual(fork.result.thread.id, threadId);
    assert.equal(fork.result.thread.forkedFromId, threadId);
    assert.equal(fork.result.thread.turns.length, 1, "fork 应截至第一轮（含）");
    assert.deepEqual(
      Object.keys(fork.result).sort(),
      [
        "activePermissionProfile",
        "approvalPolicy",
        "approvalsReviewer",
        "cwd",
        "disabledPluginIds",
        "instructionSources",
        "model",
        "modelProvider",
        "multiAgentMode",
        "reasoningEffort",
        "runtimeWorkspaceRoots",
        "sandbox",
        "serviceTier",
        "thread",
      ],
      "ForkResponse 顶层 14 键",
    );
    // preview = 截断后继承历史的首条用户消息（thread_processor.rs:6219
    // preview_from_rollout_items；非 ephemeral 分支 :5115-5123）
    assert.equal(fork.result.thread.preview, "第一轮");
    // lastTurnId 截断把快照所属 turn（第二轮）截掉 → 不补发 restored usage
    // （codex 从 fork 自己的截断历史恢复；sim 宁缺毋滥不回溯，见 threadFork 注释）
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      !loop.mock.receivedNotifications.some(
        (n) =>
          n.method === "thread/tokenUsage/updated" &&
          (n.params as { threadId: string }).threadId === fork.result.thread.id,
      ),
      "截断掉快照所属 turn 的 fork 不得补发 restored usage",
    );
    // fork 历史段：以**过滤后继承的 items** 为准——lastTurnId 截断后只剩
    // 「第一轮」的用户消息（「第二轮」不在段内，模拟回复不含）
    const f1 = (await loop.mock.rpc("turn/start", {
      threadId: fork.result.thread.id,
      input: [{ type: "text", text: "fork 第一问" }],
    })) as { result: { turn: { id: string } } };
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "turn/completed") && n.params.turn.id === f1.result.turn.id,
        ),
      5000,
      "fork 首轮未完成",
    );
    const forkReply = (
      loop.mock.receivedNotifications.find(
        (n) => isNotif(n, "turn/completed") && n.params.turn.id === f1.result.turn.id,
      )!.params as { turn: { items: Array<{ type: string; text?: string }> } }
    ).turn.items.find((i) => i.type === "agentMessage")?.text ?? "";
    assert.match(forkReply, /已收到消息：「fork 第一问」/);
    assert.match(forkReply, /此前的历史消息：第一轮$/, "历史段=截断后继承的用户消息（不含模拟回复/后续轮）");
    const badTurn = (await loop.mock.rpc("thread/fork", { threadId, lastTurnId: "unknown-turn" })) as {
      error?: { code: number; message: string };
    };
    assert.equal(badTurn.error?.code, -32600);
    assert.equal(badTurn.error?.message, "unknown turn id: unknown-turn");

    // ephemeral fork 不进列表
    loop.mock.receivedEnvelopeLog.length = 0; // 只考察 fork 后的信封顺序
    const eph = (await loop.mock.rpc("thread/fork", { threadId, ephemeral: true })) as {
      id: number | string;
      result: { thread: { id: string; ephemeral: boolean; preview: string } };
    };
    assert.equal(eph.result.thread.ephemeral, true);
    // 全量 fork（无 excludeTurns/lastTurnId）→ 响应先行 + restored usage 补发 +
    // thread/started 广播，三者信封顺序对齐 thread_processor.rs:5355-5376
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) =>
            n.method === "thread/started" &&
            (n.params as { thread: { id: string } }).thread.id === eph.result.thread.id,
        ),
      2000,
      "eph fork 的 thread/started 未收到",
    );
    const ephLog = loop.mock.receivedEnvelopeLog;
    const ephRespIdx = ephLog.findIndex(
      (e) => e.kind === "response" && String(e.id) === String(eph.id),
    );
    const ephUsageIdx = ephLog.findIndex(
      (e) => e.kind === "notification" && e.method === "thread/tokenUsage/updated",
    );
    const ephStartedIdx = ephLog.findIndex(
      (e) => e.kind === "notification" && e.method === "thread/started",
    );
    assert.ok(ephRespIdx >= 0, "fork 响应应在时序日志中");
    assert.ok(ephUsageIdx > ephRespIdx, "restored usage 补发必须晚于 fork 响应");
    assert.ok(ephStartedIdx > ephUsageIdx, "thread/started 应晚于 restored usage 补发");
    const ephUsage = loop.mock.receivedNotifications.find(
      (n) =>
        n.method === "thread/tokenUsage/updated" &&
        (n.params as { threadId: string }).threadId === eph.result.thread.id,
    )!.params as { turnId: string };
    assert.equal(ephUsage.turnId, t2.result.turn.id, "补发应归属源线程最后完成的 turn");
    const list = (await loop.mock.rpc("thread/list", {})) as { result: { data: Array<{ id: string }> } };
    assert.ok(!list.result.data.some((t) => t.id === eph.result.thread.id), "ephemeral fork 不应进列表");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("S03-G skill：extraRoots/configWrite/skillRead + $技能名 钩子", async () => {
  const loop = await startLoop({ stepDelayMs: 5, deltaIntervalMs: 1, deltaChars: 64 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/skill" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;

    const extra = (await loop.mock.rpc("skills/extraRoots/set", { extraRoots: ["/tmp/extra"] })) as {
      result: unknown;
    };
    assert.deepEqual(extra.result, {});

    const both = (await loop.mock.rpc("skills/config/write", {
      path: "/tmp/a/SKILL.md",
      name: "bridge-sim-demo",
      enabled: true,
    })) as { error?: { code: number; message: string } };
    assert.equal(both.error?.code, -32602);
    assert.equal(both.error?.message, "skills/config/write requires exactly one of path or name");
    const noneSel = (await loop.mock.rpc("skills/config/write", { enabled: true })) as {
      error?: { code: number };
    };
    assert.equal(noneSel.error?.code, -32602);
    const single = (await loop.mock.rpc("skills/config/write", { name: "bridge-sim-demo", enabled: true })) as {
      result: { effectiveEnabled: boolean };
    };
    assert.deepEqual(single.result, { effectiveEnabled: true });

    const read = (await loop.mock.rpc("plugin/skill/read", {
      remoteMarketplaceName: "openai",
      remotePluginId: "bridge",
      skillName: "bridge-sim-demo",
    })) as { result: { contents: string } };
    assert.ok(read.result.contents.includes("# bridge-sim-demo"));
    assert.ok(read.result.contents.includes("bridge@openai"));

    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "用 $bridge-sim-demo 做点事" }],
    });
    await waitFor(
      () =>
        loop.mock.receivedNotifications.some(
          (n) => isNotif(n, "item/completed") && n.params.item.type === "agentMessage",
        ),
      5000,
      "$技能名 回复未到",
    );
    const reply = findNotif(
      loop,
      "item/completed",
      (p) => p.item.type === "agentMessage",
    )!;
    assert.equal(String(reply.params.item.text).split("\n")[0], "已加载技能 $bridge-sim-demo（模拟）。");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`waitFor 超时: ${message}`));
      }
    }, 20);
  });
}

test("回环：手机标题生成 turn（turnTrigger=remote_ios + outputSchema{title}）按契约回 JSON", async () => {
  const loop = await startLoop({ stepDelayMs: 5, deltaIntervalMs: 5 });
  try {
    await loop.mock.rpc("initialize", {
      clientInfo: { name: "codex_chatgpt_ios_remote" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-title", threadSource: "user" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;

    // 手机标题 turn 的真实形状（2026-09-26 抓包）：注入 prompt 尾部带用户消息
    const injectionPrompt =
      "You are a helpful assistant. You will be presented with a user prompt, and your job is to " +
      "provide a short title for a task that will be created from that prompt.\n\nUser prompt:\nFix the login bug";
    const turn = (await loop.mock.rpc("turn/start", {
      threadId,
      turnTrigger: "remote_ios",
      effort: "low",
      outputSchema: {
        properties: { title: { type: "string", maxLength: 36, minLength: 1 } },
        additionalProperties: false,
        required: ["title"],
        type: "object",
      },
      input: [{ text: injectionPrompt, type: "text" }],
      clientUserMessageId: "title-turn-1",
    })) as { result: { turn: { id: string; status: string } } };
    assert.equal(turn.result.turn.status, "inProgress");

    await waitFor(() =>
      loop.mock.receivedNotifications.some(
        (n) => n.method === "turn/completed" &&
          (n.params as { turn?: { id?: string } }).turn?.id === turn.result.turn.id,
      ),
      5000,
      "标题 turn 未完成",
    );

    // agentMessage 文本必须是符合 outputSchema 的 JSON（手机解析失败会冻结 UI）
    const completed = loop.mock.receivedNotifications.find(
      (n) =>
        n.method === "item/completed" &&
        (n.params as { item?: { type?: string } }).item?.type === "agentMessage",
    )!;
    const item = (completed.params as { item: { text: string } }).item;
    assert.deepEqual(JSON.parse(item.text), { title: "Fix the login bug" });

    // thread.preview 用提取的标题（手机任务列表 UI 标题）
    const list = (await loop.mock.rpc("thread/list", {})) as {
      result: { data: Array<{ id: string; preview: string }> };
    };
    const listed = list.result.data.find((t) => t.id === threadId);
    assert.ok(listed, "标题线程应出现在 thread/list");
    assert.equal(listed!.preview, "Fix the login bug");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：标题 turn 超 maxLength 截断、含 test queue 字样不误触发脚本", async () => {
  const loop = await startLoop({ stepDelayMs: 5, deltaIntervalMs: 5 });
  try {
    await loop.mock.rpc("initialize", {
      clientInfo: { name: "codex_chatgpt_ios_remote" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-title2", threadSource: "user" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;

    const longPrompt =
      "You are a helpful assistant.\n\nUser prompt:\ntest queue with an extremely long user message that exceeds the schema limit";
    const turn = (await loop.mock.rpc("turn/start", {
      threadId,
      turnTrigger: "remote_ios",
      outputSchema: {
        properties: { title: { type: "string", maxLength: 36 } },
        required: ["title"],
        type: "object",
      },
      input: [{ text: longPrompt, type: "text" }],
    })) as { result: { turn: { id: string } } };

    await waitFor(() =>
      loop.mock.receivedNotifications.some(
        (n) => n.method === "turn/completed" &&
          (n.params as { turn?: { id?: string } }).turn?.id === turn.result.turn.id,
      ),
      5000,
      "标题 turn 未完成",
    );

    const msgs = loop.mock.receivedNotifications.filter(
      (n) =>
        n.method === "item/completed" &&
        (n.params as { item?: { type?: string } }).item?.type === "agentMessage",
    );
    // 标题 turn 只产出 1 条 agentMessage（不得误入 test queue 的 3 条脚本）
    assert.equal(msgs.length, 1);
    const { title } = JSON.parse((msgs[0]!.params as { item: { text: string } }).item.text) as {
      title: string;
    };
    assert.ok(title.length <= 36, `title 超 schema maxLength: ${title}`);
    assert.ok(title.startsWith("test queue with an extremely"), `title 应取自 User prompt 之后: ${title}`);
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：command/exec HOME 探测（ChatGPT 1.2026.258 发消息前置）流式 outputDelta + 空响应", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", {
      clientInfo: { name: "codex_chatgpt_ios_remote" },
      capabilities: { experimentalApi: true },
    });
    // 真机 2026-09-26T17:12:38Z 抓包原样参数（codex-read-only 只读沙箱包装）。
    // 旧版走 process/spawn；新版发消息前必经此调用，-32601 会让手机报
    // 「Codex 服务器返回了错误」并进入 30s 会话重建循环
    const res = (await loop.mock.rpc("command/exec", {
      timeoutMs: 20000,
      cwd: "/",
      processId: "ios-read-only-CBF71100",
      outputBytesCap: 4097,
      command: [
        "/bin/sh", "-c", "printf '\\0'; exec \"$@\"", "codex-read-only",
        "/bin/sh", "-lc", "cd \"$HOME\" && pwd -P",
      ],
      streamStdoutStderr: true,
      env: { ENV: null, BASH_ENV: null },
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    })) as { result: { exitCode: number; stdout: string; stderr: string } };
    // 流式最终响应不带输出（command_exec.rs：流式字节不重复携带进响应）
    assert.deepEqual(res.result, { exitCode: 0, stdout: "", stderr: "" });

    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "command/exec/outputDelta"),
      5000,
      "outputDelta 通知未到达",
    );
    const delta = loop.mock.receivedNotifications.find(
      (n) => n.method === "command/exec/outputDelta",
    )!.params as { processId: string; stream: string; deltaBase64: string; capReached: boolean };
    assert.equal(delta.processId, "ios-read-only-CBF71100");
    assert.equal(delta.stream, "stdout");
    assert.equal(delta.capReached, false);
    // 外壳 printf '\0' 前缀 + 内层 pwd -P：与真实 codex 执行输出逐字节一致
    const text = Buffer.from(delta.deltaBase64, "base64").toString("utf8");
    assert.equal(text, `\0${realpathSync(homedir())}\n`);
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：command/exec 缓冲模式 stdout 随响应返回 + outputBytesCap 按字节截断", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "codex_chatgpt_ios_remote" } });
    const command = [
      "/bin/sh", "-c", "printf '\\0'; exec \"$@\"", "codex-read-only",
      "/bin/sh", "-lc", "cd \"$HOME\" && pwd -P",
    ];
    const res = (await loop.mock.rpc("command/exec", { command, cwd: "/" })) as {
      result: { exitCode: number; stdout: string; stderr: string };
    };
    assert.equal(res.result.exitCode, 0);
    assert.equal(res.result.stderr, "");
    assert.equal(res.result.stdout, `\0${realpathSync(homedir())}\n`);
    assert.equal(
      loop.mock.receivedNotifications.filter((n) => n.method === "command/exec/outputDelta").length,
      0,
      "缓冲模式不得发 outputDelta",
    );

    const capped = (await loop.mock.rpc("command/exec", { command, outputBytesCap: 3 })) as {
      result: { stdout: string };
    };
    assert.equal(Buffer.byteLength(capped.result.stdout), 3, "outputBytesCap 应按字节截断");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：command/exec 校验顺序与 write/terminate/resize 无会话错误对齐 codex 文案", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "codex_chatgpt_ios_remote" } });
    // 流式前置校验先于空命令校验（command_exec.rs start() 159 行 → 254 行）
    const noId = (await loop.mock.rpc("command/exec", {
      command: ["/bin/sh", "-lc", "true"],
      streamStdoutStderr: true,
    })) as { error?: { code: number; message: string } };
    assert.equal(noId.error?.code, -32600);
    assert.equal(noId.error?.message, "command/exec tty or streaming requires a client-supplied processId");

    const empty = (await loop.mock.rpc("command/exec", { command: [] })) as {
      error?: { code: number; message: string };
    };
    assert.equal(empty.error?.code, -32600);
    assert.equal(empty.error?.message, "command must not be empty");

    const noDelta = (await loop.mock.rpc("command/exec/write", { processId: "p1" })) as {
      error?: { code: number; message: string };
    };
    assert.equal(noDelta.error?.code, -32602);
    assert.equal(noDelta.error?.message, "command/exec/write requires deltaBase64 or closeStdin");

    const write = (await loop.mock.rpc("command/exec/write", { processId: "p1", deltaBase64: "aGk=" })) as {
      error?: { code: number; message: string };
    };
    assert.equal(write.error?.code, -32600);
    assert.equal(write.error?.message, 'no active command/exec for process id "p1"');

    const terminate = (await loop.mock.rpc("command/exec/terminate", { processId: "p2" })) as {
      error?: { code: number; message: string };
    };
    assert.equal(terminate.error?.code, -32600);
    assert.equal(terminate.error?.message, 'no active command/exec for process id "p2"');

    const badSize = (await loop.mock.rpc("command/exec/resize", {
      processId: "p3",
      size: { rows: 0, cols: 80 },
    })) as { error?: { code: number; message: string } };
    assert.equal(badSize.error?.code, -32602);
    assert.equal(badSize.error?.message, "command/exec size rows and cols must be greater than 0");

    const resize = (await loop.mock.rpc("command/exec/resize", {
      processId: "p3",
      size: { rows: 24, cols: 80 },
    })) as { error?: { code: number; message: string } };
    assert.equal(resize.error?.code, -32600);
    assert.equal(resize.error?.message, 'no active command/exec for process id "p3"');
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：command/exec codex-workspace-write 任务目录脚本（1.2026.258 新会话）应答 candidate 路径", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "codex_chatgpt_ios_remote" } });
    // 真机 2026-09-26T17:31:54Z 抓包原样：根目录经 env CODEX_PROJECTLESS_ROOT 注入，
    // base=消息文本；应答 stdout 即新任务目录（手机拿不到路径 →「Codex 执行失败」）
    const script = [
      "set -eu",
      'root="$CODEX_PROJECTLESS_ROOT"',
      'date_directory="$root/$(date +%Y-%m-%d)"',
      'mkdir -p "$root"',
      'if [ ! -d "$root" ] || [ -L "$root" ]; then',
      '  echo "Codex projectless chat root must be a real directory." >&2',
      "  exit 1",
      "fi",
      'mkdir -p "$date_directory"',
      'if [ ! -d "$date_directory" ] || [ -L "$date_directory" ]; then',
      '  echo "Codex projectless chat date directory must be a real directory." >&2',
      "  exit 1",
      "fi",
      'base="hi"',
      'candidate="$date_directory/$base"',
      "index=1",
      'while ! mkdir "$candidate" 2>/dev/null; do',
      "  index=$((index + 1))",
      '  if [ "$index" -gt 1000 ]; then',
      '    echo "Could not create a unique Codex projectless chat directory." >&2',
      "    exit 1",
      "  fi",
      '  candidate="$date_directory/$base-$index"',
      "done",
      "printf '%s\\n' \"$candidate\"",
    ].join("\n");
    const root = `${homedir()}/Documents/Codex`;
    const res = (await loop.mock.rpc("command/exec", {
      timeoutMs: 20000,
      cwd: "/",
      env: { ENV: null, BASH_ENV: null, CODEX_PROJECTLESS_ROOT: root },
      processId: "ios-workspace-write-TEST",
      outputBytesCap: 4097,
      streamStdoutStderr: true,
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: true,
        writableRoots: [`${homedir()}/Documents`],
        excludeSlashTmp: false,
        excludeTmpdirEnvVar: false,
      },
      command: [
        "/bin/sh", "-c", "printf '\\0'; exec \"$@\"", "codex-workspace-write",
        "/bin/sh", "-lc", script,
      ],
    })) as { result: { exitCode: number; stdout: string; stderr: string } };
    assert.deepEqual(res.result, { exitCode: 0, stdout: "", stderr: "" });

    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "command/exec/outputDelta"),
      5000,
      "任务目录 outputDelta 未到达",
    );
    const delta = loop.mock.receivedNotifications.find(
      (n) => n.method === "command/exec/outputDelta",
    )!.params as { processId: string; stream: string; deltaBase64: string };
    assert.equal(delta.processId, "ios-workspace-write-TEST");
    const text = Buffer.from(delta.deltaBase64, "base64").toString("utf8");
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    assert.equal(text, `\0${root}/${ymd}/hi\n`, "应答应为 NUL 前缀 + 新任务目录路径");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：initialize 不推 account/updated 与 remoteControl/status/changed（codex 只随附 ConfigWarning）", async () => {
  const loop = await startLoop();
  try {
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    // 微任务/近即时通知浮出窗口
    await new Promise((r) => setTimeout(r, 30));
    const methods = loop.mock.receivedNotifications.map((n) => n.method);
    assert.ok(
      !methods.includes("account/updated"),
      "initialize 不应推 account/updated——手机每 ~30s 重连即收一次「账户变更」会把上下文显示打回不可用（来回跳根因）",
    );
    assert.ok(!methods.includes("remoteControl/status/changed"), "initialize 不应推 remoteControl/status/changed（只在真实状态迁移时发）");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：account/rateLimits/read 返回 5h/7d 双窗快照；turn 后滚动 account/rateLimits/updated", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const limits = (await loop.mock.rpc("account/rateLimits/read", {})) as {
      result: {
        ordinaryUsageAllowed: boolean;
        rateLimits: {
          primary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
          secondary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
        };
      };
    };
    assert.equal(limits.result.ordinaryUsageAllowed, true, "ordinaryUsageAllowed 应为 true");
    const { primary, secondary } = limits.result.rateLimits;
    assert.equal(primary.windowDurationMins, 300, "primary 应为 5 小时滚动窗（300 分钟）");
    assert.equal(secondary.windowDurationMins, 10080, "secondary 应为 7 天周窗（10080 分钟）");
    for (const w of [primary, secondary]) {
      assert.ok(w.usedPercent >= 0 && w.usedPercent <= 100, "usedPercent 应为 0-100 百分比");
      assert.ok(typeof w.resetsAt === "number", "resetsAt 应为 Unix 秒时间戳");
    }
    const usage = (await loop.mock.rpc("account/usage/read", {})) as {
      result: { summary: { lifetimeTokens: number } };
    };
    assert.ok(Number.isFinite(usage.result.summary.lifetimeTokens), "lifetimeTokens 应为数值");

    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/rate" })) as {
      result: { thread: { id: string } };
    };
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("turn/start", {
      threadId: started.result.thread.id,
      input: [{ type: "text", text: "限额探测" }],
    });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "turn/completed 未收到",
    );
    // handle_token_count_event（bespoke_event_handling.rs:1581-1599）顺序：tokenUsage
    // 之后紧跟账户级滚动更新
    const tokenIdx = loop.mock.receivedNotifications.findIndex((n) => n.method === "thread/tokenUsage/updated");
    const rollIdx = loop.mock.receivedNotifications.findIndex((n) => n.method === "account/rateLimits/updated");
    assert.ok(tokenIdx >= 0, "turn 结束应广播 thread/tokenUsage/updated");
    assert.ok(rollIdx > tokenIdx, "account/rateLimits/updated 应晚于 tokenUsage/updated");
    const rolled = loop.mock.receivedNotifications.find((n) => n.method === "account/rateLimits/updated")!
      .params as { rateLimits: { secondary: { windowDurationMins: number | null } } };
    assert.equal(rolled.rateLimits.secondary.windowDurationMins, 10080, "滚动更新应同为 7 天周窗形状");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：resume 补发 tokenUsage 快照（上下文行数据源），响应先行且先于 goal 快照", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/ctx" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    const turn = (await loop.mock.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "上下文探测" }],
    })) as { result: { turn: { id: string } } };
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "turn/completed 未收到",
    );
    const liveUsage = loop.mock.receivedNotifications.find((n) => n.method === "thread/tokenUsage/updated")!
      .params as { tokenUsage: { total: { totalTokens: number }; modelContextWindow: number } };
    assert.ok(liveUsage.tokenUsage.total.totalTokens > 0, "新会话基线 0，首轮后已占用 = 本轮消息字符数（>0）");
    assert.equal(liveUsage.tokenUsage.modelContextWindow, 258000);

    loop.mock.receivedEnvelopeLog.length = 0;
    loop.mock.receivedNotifications.length = 0;
    const resumed = (await loop.mock.rpc("thread/resume", { threadId })) as { id: number | string; result: unknown };
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "thread/tokenUsage/updated"),
      2000,
      "resume 未补发 thread/tokenUsage/updated",
    );
    // 响应信封先于补发通知（thread_processor.rs:4172-4175：发送在响应之后以保持
    // JSON-RPC 请求序，同时赶在下个 turn 生命周期前填充状态行）
    const log = loop.mock.receivedEnvelopeLog;
    const responseIndex = log.findIndex(
      (e) => e.kind === "response" && String(e.id) === String(resumed.id),
    );
    const notifIndex = log.findIndex(
      (e) => e.kind === "notification" && e.method === "thread/tokenUsage/updated",
    );
    assert.ok(responseIndex >= 0, "thread/resume 响应应在时序日志中");
    assert.ok(notifIndex > responseIndex, "tokenUsage 补发必须晚于 resume 响应上线");
    const replay = loop.mock.receivedNotifications.find((n) => n.method === "thread/tokenUsage/updated")!
      .params as {
      threadId: string;
      turnId: string;
      tokenUsage: { total: { totalTokens: number }; modelContextWindow: number };
    };
    assert.equal(replay.threadId, threadId);
    assert.equal(replay.turnId, turn.result.turn.id, "补发应归属最近一个完成的 turn");
    assert.equal(replay.tokenUsage.total.totalTokens, liveUsage.tokenUsage.total.totalTokens, "补发应携带最近快照值");
    assert.equal(replay.tokenUsage.modelContextWindow, 258000);
    // tokenUsage 补发先于 goal 快照（thread_processor.rs:4166-4190 顺序）
    const goalIdx = loop.mock.receivedNotifications.findIndex((n) => n.method === "thread/goal/cleared");
    if (goalIdx >= 0) {
      assert.ok(
        goalIdx > loop.mock.receivedNotifications.findIndex((n) => n.method === "thread/tokenUsage/updated"),
        "tokenUsage 补发应先于 goal 快照",
      );
    }
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：上下文占用 = 会话消息 char 数（新会话 0 基线，上限 257999，compact 后 200）", async () => {
  const loop = await startLoop({ compactWaitMs: 60 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/ctxchars" })) as {
      result: { thread: { id: string } };
    };
    const threadId = started.result.thread.id;
    const lastUsage = () => {
      const notifs = loop.mock.receivedNotifications.filter((n) => n.method === "thread/tokenUsage/updated");
      return notifs[notifs.length - 1]!.params as {
        tokenUsage: {
          total: { totalTokens: number; inputTokens: number; outputTokens: number };
          last: { totalTokens: number; inputTokens: number; outputTokens: number };
        };
      };
    };
    const lastCompletedAgentChars = () => {
      const completions = loop.mock.receivedNotifications.filter((n) => n.method === "turn/completed");
      const items = (completions[completions.length - 1]!.params as { turn: { items: Array<{ type: string; text?: string }> } }).turn.items;
      return (items.find((i) => i.type === "agentMessage")?.text ?? "").length;
    };

    // 第 1 轮：新会话基线 0，已占用 = 本轮 user + agent 消息字符数
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "占用探测" }] });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "turn/completed 未收到",
    );
    const u1 = lastUsage();
    const agent1 = lastCompletedAgentChars();
    assert.equal(u1.tokenUsage.total.totalTokens, "占用探测".length + agent1, "新会话首轮已占用 = user+agent 消息字符数");
    assert.equal(u1.tokenUsage.total.inputTokens, "占用探测".length);
    assert.equal(u1.tokenUsage.total.outputTokens, agent1);
    assert.equal(u1.tokenUsage.last.totalTokens, "占用探测".length + agent1);

    // compact：上下文重置为 200 基线
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("thread/compact/start", { threadId });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "compact turn 未完成",
    );
    assert.equal(lastUsage().tokenUsage.total.totalTokens, 200, "compact 后已占用应重置为 200 基线");

    // 第 2 轮：在 200 基线上继续累加
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("turn/start", { threadId, input: [{ type: "text", text: "再占用" }] });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "turn/completed 未收到",
    );
    const agent3 = lastCompletedAgentChars();
    assert.equal(
      lastUsage().tokenUsage.total.totalTokens,
      200 + "再占用".length + agent3,
      "compact 后占用 = 200 基线 + 新消息字符",
    );
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("回环：side conversation——ephemeral fork 走标准回复；inject_items 注入边界（计入历史与上下文）；name/set 更新并广播", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    // 父线程：一轮对话打底（side chat 从它 fork）
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/sidechat" })) as {
      result: { thread: { id: string } };
    };
    const parentId = started.result.thread.id;
    await loop.mock.rpc("turn/start", { threadId: parentId, input: [{ type: "text", text: "父线程消息" }] });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "父线程 turn/completed 未收到",
    );
    const parentUsage = (
      loop.mock.receivedNotifications.filter((n) => n.method === "thread/tokenUsage/updated").pop()!
        .params as { tokenUsage: { total: { totalTokens: number } } }
    ).tokenUsage.total.totalTokens;
    assert.ok(parentUsage > 0, "父线程先产生非零占用");

    // fork 真机形状：ephemeral + excludeTurns（响应只带元数据，turns 空），
    // 线程本体仍继承全部历史
    await new Promise((resolve) => setTimeout(resolve, 150)); // 等 emitSoon 浮面
    loop.mock.receivedNotifications.length = 0;
    const fork = (await loop.mock.rpc("thread/fork", {
      threadId: parentId,
      ephemeral: true,
      excludeTurns: true,
    })) as {
      result: { thread: { id: string; ephemeral: boolean; forkedFromId: string | null; turns: unknown[] } };
    };
    const sideId = fork.result.thread.id;
    assert.notEqual(sideId, parentId);
    assert.equal(fork.result.thread.ephemeral, true);
    assert.equal(fork.result.thread.forkedFromId, parentId);
    assert.equal(fork.result.thread.turns.length, 0, "excludeTurns=true 响应不填充 turns");
    const forkTurns = (await loop.mock.rpc("thread/turns/list", { threadId: sideId })) as {
      result: { data: Array<{ id: string }> };
    };
    assert.equal(forkTurns.result.data.length, 1, "fork 本体仍继承父线程 turn 历史");

    // inject_items：App 实发形状（role:user message + input_text content）；
    // 响应 {}，且不产生任何通知（codex 纯历史写入，无 server notification）
    await new Promise((resolve) => setTimeout(resolve, 150)); // 等 fork 的 thread/started 浮面
    // excludeTurns=true 是 cheap fork 路径：跳过 restored usage 重放
    // （thread_processor.rs:5360-5367），只有 thread/started 广播
    assert.ok(
      !loop.mock.receivedNotifications.some(
        (n) =>
          n.method === "thread/tokenUsage/updated" &&
          (n.params as { threadId: string }).threadId === sideId,
      ),
      "excludeTurns（side chat）fork 不补发 restored usage",
    );
    assert.ok(
      loop.mock.receivedNotifications.some(
        (n) =>
          n.method === "thread/started" &&
          (n.params as { thread: { id: string } }).thread.id === sideId,
      ),
      "side chat fork 应广播 thread/started",
    );
    loop.mock.receivedNotifications.length = 0;
    const boundary =
      "Side conversation boundary.\n\nEverything before this boundary is inherited history from the parent thread.";
    const inject = (await loop.mock.rpc("thread/inject_items", {
      threadId: sideId,
      items: [{ role: "user", type: "message", content: [{ type: "input_text", text: boundary }] }],
    })) as { result: unknown };
    assert.deepEqual(inject.result, {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(loop.mock.receivedNotifications.length, 0, "inject_items 不产生通知");
    // 注入项进 items/list，文本一致
    const items = (await loop.mock.rpc("thread/items/list", { threadId: sideId })) as {
      result: { data: Array<{ item: { type: string; content?: Array<{ text: string }> } }> };
    };
    const injected = items.result.data.find(
      (e) => e.item.type === "userMessage" && e.item.content?.[0]?.text === boundary,
    );
    assert.ok(injected, "注入的边界消息应出现在 items/list");

    // side 首轮：ephemeral 线程上的裸用户输入必须走**标准完整回复**——曾因
    // ephemeral 起名兜底误伤被截成 ≤36 字符标题（2026-09-27 真机 "Hi"→"Hi"）
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("turn/start", { threadId: sideId, input: [{ type: "text", text: "side 问题" }] });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "side turn/completed 未收到",
    );
    const sideAgentItem = (
      loop.mock.receivedNotifications.find((n) => n.method === "turn/completed")!.params as {
        turn: { items: Array<{ type: string; text?: string }> };
      }
    ).turn.items.find((i) => i.type === "agentMessage");
    const sideAgentText = sideAgentItem?.text ?? "";
    assert.match(sideAgentText, /已收到消息：「side 问题」/, "side chat 回复须含标准首行");
    assert.match(sideAgentText, /bridge 模拟层的固定回复/, "side chat 回复须含完整说明块");
    assert.ok(sideAgentText.length > "side 问题".length, "回复不得被截成用户原文");
    // fork 历史段：side 首条回复末尾附「此前的历史消息：…」（继承的父线程
    // 用户消息按序 join「、」，不含模拟回复；边界注入发生在 fork 后、不在段内）
    assert.match(sideAgentText, /此前的历史消息：父线程消息$/);
    // 上下文 = 继承的父线程占用 + 边界注入 + 本轮消息（fork 复制计数 + inject 即时计入）
    const sideUsage = (
      loop.mock.receivedNotifications.filter((n) => n.method === "thread/tokenUsage/updated").pop()!
        .params as { tokenUsage: { total: { totalTokens: number } } }
    ).tokenUsage.total.totalTokens;
    assert.equal(
      sideUsage,
      parentUsage + boundary.length + "side 问题".length + sideAgentText.length,
      "side 首轮占用 = 继承 + 注入 + 本轮",
    );
    // 第二条回复不再附加（用后即清）
    loop.mock.receivedNotifications.length = 0;
    await loop.mock.rpc("turn/start", { threadId: sideId, input: [{ type: "text", text: "side 第二问" }] });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "side 第二轮 turn/completed 未收到",
    );
    const sideAgentText2 = (
      loop.mock.receivedNotifications.find((n) => n.method === "turn/completed")!.params as {
        turn: { items: Array<{ type: string; text?: string }> };
      }
    ).turn.items.find((i) => i.type === "agentMessage")?.text ?? "";
    assert.match(sideAgentText2, /已收到消息：「side 第二问」/);
    assert.ok(!sideAgentText2.includes("此前的历史消息"), "历史段只附加 fork 后第一条回复");

    // name/set（真机给持久线程起名）：响应 {} + thread/name/updated（trim 归一化），thread/list 生效
    loop.mock.receivedNotifications.length = 0;
    const named = (await loop.mock.rpc("thread/name/set", { threadId: parentId, name: "  hi  " })) as {
      result: unknown;
    };
    assert.deepEqual(named.result, {});
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "thread/name/updated"),
      2000,
      "thread/name/updated 未收到",
    );
    const nameNotif = loop.mock.receivedNotifications.find(
      (n) => n.method === "thread/name/updated",
    )!.params as { threadId: string; threadName: string };
    assert.equal(nameNotif.threadId, parentId);
    assert.equal(nameNotif.threadName, "hi");
    const list = (await loop.mock.rpc("thread/list", {})) as {
      result: { data: Array<{ id: string; name: string | null }> };
    };
    assert.equal(list.result.data.find((t) => t.id === parentId)?.name, "hi");
    assert.ok(!list.result.data.some((t) => t.id === sideId), "ephemeral side chat 不进 thread/list");

    // 非法入参：空 items / 坏 item / 空名 → -32600（对齐 codex invalid_request）
    const badItems = (await loop.mock.rpc("thread/inject_items", { threadId: sideId, items: [] })) as {
      error?: { code: number; message: string };
    };
    assert.equal(badItems.error?.code, -32600);
    assert.equal(badItems.error?.message, "items must not be empty");
    const badItem = (await loop.mock.rpc("thread/inject_items", {
      threadId: sideId,
      items: [{ type: "message", content: "not-array" }],
    })) as { error?: { code: number; message: string } };
    assert.equal(badItem.error?.code, -32600);
    assert.match(String(badItem.error?.message), /items\[0\] is not a valid response item/);
    const badName = (await loop.mock.rpc("thread/name/set", { threadId: sideId, name: "   " })) as {
      error?: { code: number; message: string };
    };
    assert.equal(badName.error?.code, -32600);
    assert.equal(badName.error?.message, "thread name must not be empty");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

// ------------------------------------------- ephemeral 线程空闲卸载（codex 对齐）

test("回环：ephemeral 线程空闲卸载——有订阅不卸；退订后超时移除；非 ephemeral 永不卸载", async () => {
  const loop = await startLoop({ threadUnloadDelayMs: 150 });
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const started = (await loop.mock.rpc("thread/start", { cwd: "/tmp-sim/unload" })) as {
      result: { thread: { id: string } };
    };
    const parentId = started.result.thread.id;
    await loop.mock.rpc("turn/start", { threadId: parentId, input: [{ type: "text", text: "打底" }] });
    await waitFor(
      () => loop.mock.receivedNotifications.some((n) => n.method === "turn/completed"),
      10_000,
      "父线程 turn/completed 未收到",
    );

    // side chat：ephemeral fork（创建连接已 attach）
    const fork = (await loop.mock.rpc("thread/fork", { threadId: parentId, ephemeral: true, excludeTurns: true })) as {
      result: { thread: { id: string } };
    };
    const sideId = fork.result.thread.id;

    // 有订阅：超过 2×delay 仍存活
    await new Promise((r) => setTimeout(r, 400));
    const alive = (await loop.mock.rpc("thread/items/list", { threadId: sideId })) as {
      result?: unknown; error?: { code: number };
    };
    assert.ok(alive.result, "有订阅的 ephemeral 线程不得卸载");

    // 退订（唯一订阅者离开）→ 超时卸载：resume/items/list 均 thread not found
    await loop.mock.rpc("thread/unsubscribe", { threadId: sideId });
    await new Promise((r) => setTimeout(r, 400));
    const resumed = (await loop.mock.rpc("thread/resume", { threadId: sideId })) as {
      result?: unknown; error?: { code: number; message: string };
    };
    assert.equal(resumed.error?.code, -32000, "退订超时后 ephemeral 线程应已卸载");
    assert.match(String(resumed.error?.message), /thread not found/);
    const items = (await loop.mock.rpc("thread/items/list", { threadId: sideId })) as {
      result?: unknown; error?: { code: number };
    };
    assert.ok(items.error, "卸载后 items/list 也应报 thread not found");

    // 非 ephemeral：同样退订 + 超时，永不卸载（落盘线程 resume 冷加载，驻留等价）
    await loop.mock.rpc("thread/unsubscribe", { threadId: parentId });
    await new Promise((r) => setTimeout(r, 400));
    const parentBack = (await loop.mock.rpc("thread/resume", { threadId: parentId })) as {
      result?: { thread: { id: string } }; error?: { code: number };
    };
    assert.ok(parentBack.result, "非 ephemeral 线程不得被空闲卸载");
  } finally {
    await loop.tunnel.stop();
    await loop.mock.stop();
  }
});

test("直连：ephemeral 卸载计时——重订阅重置 deadline；连接断开（forgetClient）触发计时", async () => {
  const dir = await tempDir("unload-direct");
  const statePath = join(dir, "state.json");
  const app = new SimApp({ codexHome: dir, statePath, threadUnloadDelayMs: 120, log: () => {} });
  const key = { clientId: "c1", streamId: "s1" };
  try {
    await app.handleRequest(key, 1, "initialize", { clientInfo: { name: "t" } });
    const started = (await app.handleRequest(key, 2, "thread/start", {
      cwd: "/tmp-sim/unload2",
      ephemeral: true,
    })) as { result: { thread: { id: string } } };
    const threadId = started.result.thread.id;
    const exists = async () => {
      const out = (await app.handleRequest(key, 99, "thread/items/list", { threadId })) as {
        result?: unknown; error?: { code: number };
      };
      return !out.error;
    };

    // 半程重订阅（resume）→ deadline 重置：越过原始 120ms 界线仍存活
    await app.handleRequest(key, 3, "thread/unsubscribe", { threadId });
    await new Promise((r) => setTimeout(r, 60));
    await app.handleRequest(key, 4, "thread/resume", { threadId });
    await new Promise((r) => setTimeout(r, 250)); // > 原始 deadline(120)+余量
    assert.ok(await exists(), "半程重订阅后 deadline 必须重置");

    // 再次退订 → 计时归零重跑 → 超时卸载
    await app.handleRequest(key, 5, "thread/unsubscribe", { threadId });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!(await exists()), "退订超时后应卸载");

    // 连接断开（订阅随连接消失）→ 同样触发计时
    const started2 = (await app.handleRequest(key, 6, "thread/start", {
      cwd: "/tmp-sim/unload3",
      ephemeral: true,
    })) as { result: { thread: { id: string } } };
    const threadId2 = started2.result.thread.id;
    app.forgetClient(key);
    await new Promise((r) => setTimeout(r, 300));
    const out2 = (await app.handleRequest(key, 7, "thread/items/list", { threadId: threadId2 })) as {
      result?: unknown; error?: { code: number };
    };
    assert.ok(out2.error, "连接断开后 ephemeral 线程应超时卸载");
  } finally {
    app.close();
  }
});

test("直连：活动 turn 冻结 ephemeral 卸载——turn 结束后才开始计时", async () => {
  const dir = await tempDir("unload-active");
  const statePath = join(dir, "state.json");
  // stepDelayMs 300：turn 从开跑到完成明显长于卸载延迟 120ms
  const app = new SimApp({ codexHome: dir, statePath, threadUnloadDelayMs: 120, stepDelayMs: 300, log: () => {} });
  const key = { clientId: "c1", streamId: "s1" };
  try {
    await app.handleRequest(key, 1, "initialize", { clientInfo: { name: "t" } });
    const started = (await app.handleRequest(key, 2, "thread/start", {
      cwd: "/tmp-sim/unload4",
      ephemeral: true,
    })) as { result: { thread: { id: string } } };
    const threadId = started.result.thread.id;
    const turn = (await app.handleRequest(key, 3, "turn/start", {
      threadId,
      input: [{ type: "text", text: "长 turn" }],
    })) as { result: { turn: { id: string } } };
    // turn 进行中退订：活动 turn 冻结卸载（超过 delay 仍存活）
    await app.handleRequest(key, 4, "thread/unsubscribe", { threadId });
    await new Promise((r) => setTimeout(r, 200));
    let mid = (await app.handleRequest(key, 5, "thread/items/list", { threadId })) as {
      result?: unknown; error?: { code: number };
    };
    assert.ok(mid.result, "活动 turn 期间不得卸载");

    // turn 完成（is_active 翻 false）→ 计时启动 → 超时卸载
    let completed = false;
    for (let i = 0; i < 100 && !completed; i++) {
      const turns = (await app.handleRequest(key, 100 + i, "thread/turns/list", { threadId })) as {
        result?: { data: Array<{ id: string; status: string }> };
      };
      completed = turns.result?.data.some((t) => t.id === turn.result.turn.id && t.status === "completed") ?? false;
      if (!completed) await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(completed, "turn 未完成");
    await new Promise((r) => setTimeout(r, 300));
    mid = (await app.handleRequest(key, 300, "thread/items/list", { threadId })) as {
      result?: unknown; error?: { code: number };
    };
    assert.ok(mid.error, "turn 结束 + 退订超时后应卸载");
  } finally {
    app.close();
  }
});
