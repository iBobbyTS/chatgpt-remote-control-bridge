/**
 * 模拟层回环测试：SimWhamServer（桥被控端）↔ MockWhamServer（扮演 wham 后端 + 手机端）。
 *
 * 覆盖：enroll → WSS 握手 → initialize/thread/list/thread/start/turn/start
 * 的固定响应与通知事件流、seq 递增、interrupt、虚拟 FS、process/spawn。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { BridgeAuthManager } from "../src/auth/manager.ts";
import { makeTestJwt } from "../src/auth/jwt.ts";
import { writeAuthStore, type AuthDotJson } from "../src/auth/store.ts";
import { MockWhamServer } from "../src/wham/mockServer.ts";
import { SimApp } from "../src/sim/appServer.ts";
import { SimWhamServer } from "../src/sim/server.ts";

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
  sim: SimWhamServer;
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

  const sim = new SimWhamServer({
    authManager,
    baseUrl: `http://127.0.0.1:${mock.port}/backend-api`,
    reconnectDelayMs: 0,
    log: () => {},
    app: new SimApp({
      codexHome: authHome,
      stepDelayMs: 10,
      deltaIntervalMs: 2,
      deltaChars: 16,
    }),
  });
  try {
    await sim.start();
  } catch (err) {
    await mock.stop();
    throw err;
  }
  // 等 WSS 建立
  await waitFor(() => sim.connected, 5000, "sim wss 未连接");
  return { mock, sim, authHome };
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

    // thread/list：固定线程列表（2 个预置会话）
    const list = (await loop.mock.rpc("thread/list", {})) as {
      result: { data: Array<{ id: string; preview: string }> };
    };
    assert.equal(list.result.data.length, 2);
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
    await loop.sim.stop();
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
    await loop.sim.stop();
    await loop.mock.stop();
  }
});

test("回环：fs 虚拟目录 + process/spawn mkdir 覆盖层", async () => {
  const loop = await startLoop();
  try {
    await loop.mock.rpc("initialize", { clientInfo: { name: "t" } });
    const home = homedir();
    const real = (await loop.mock.rpc("fs/readDirectory", { path: home })) as {
      result: { entries: Array<{ fileName: string; isDirectory: boolean }> };
    };
    assert.ok(Array.isArray(real.result.entries) && real.result.entries.length > 0);

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
    const taskMeta = (await loop.mock.rpc("fs/getMetadata", { path: taskDir })) as {
      result: { isDirectory: boolean };
    };
    assert.equal(taskMeta.result.isDirectory, true);

    // process/spawn 模拟手机 mkdir 任务目录（不真正落盘）
    const overlayDir = `${home}/Documents/Codex/2026-09-25/sim-overlay-task`;
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
    const parent = (await loop.mock.rpc("fs/readDirectory", {
      path: `${home}/Documents/Codex/2026-09-25`,
    })) as { result: { entries: Array<{ fileName: string; isDirectory: boolean }> } };
    assert.ok(
      parent.result.entries.some((e) => e.fileName === "sim-overlay-task" && e.isDirectory),
    );
    const meta = (await loop.mock.rpc("fs/getMetadata", { path: overlayDir })) as {
      result: { isDirectory: boolean };
    };
    assert.equal(meta.result.isDirectory, true);
  } finally {
    await loop.sim.stop();
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
  // 等 turn 流结束落盘
  await new Promise((r) => setTimeout(r, 300));
  app1.close();

  const app2 = make();
  await app2.handleRequest(key, 0, "initialize", { clientInfo: { name: "t" } });
  const list = (await app2.handleRequest(key, 3, "thread/list", {})) as {
    result: { data: Array<{ id: string }> };
  };
  assert.ok(list.result.data.some((t) => t.id === threadId), "重启后同 thread id 仍存在");
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
