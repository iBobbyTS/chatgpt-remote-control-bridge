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

async function startLoop(): Promise<Loop> {
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
    })) as { result: { thread: { id: string; cwd: string } } };
    const threadId = started.result.thread.id;
    assert.equal(started.result.thread.cwd, "/Users/ibobby/Documents/Codex/2026-09-25/sim-test");

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
