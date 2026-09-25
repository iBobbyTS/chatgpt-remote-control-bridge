import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, after } from "node:test";
import WebSocket from "ws";
import { MockWhamServer } from "../src/wham/mockServer.ts";
import {
  REST_PATHS,
  WS_HEADERS,
  type ClientEnvelope,
  type EnrollRemoteServerResponse,
  type ServerEnvelope,
} from "../src/wham/protocol.ts";

const cleanupDirs: string[] = [];
after(async () => {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(slug: string): Promise<string> {
  const base = join(process.cwd(), ".agent-work", "tmp", "wham-tests");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, `${slug}-`));
  cleanupDirs.push(dir);
  return dir;
}

interface Started {
  server: MockWhamServer;
  port: number;
  jsonlPath: string;
}

async function startMock(overrides: Partial<ConstructorParameters<typeof MockWhamServer>[0]> = {}): Promise<Started> {
  const dir = await tempDir("home");
  const jsonlPath = join(dir, "frames.jsonl");
  const server = new MockWhamServer({
    port: 0,
    jsonlPath,
    autoScript: false,
    log: () => {},
    ...overrides,
  });
  await server.start();
  return { server, port: server.port, jsonlPath };
}

test("REST：enroll → refresh（token 轮换）→ pair → pair/status", async () => {
  const { server, port } = await startMock();
  try {
    const base = `http://127.0.0.1:${port}`;
    const enroll = await fetch(`${base}${REST_PATHS.enroll}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "probe-host",
        os: "macos",
        arch: "arm64",
        app_server_version: "0.156.1",
        installation_id: "inst-1",
      }),
    });
    assert.equal(enroll.status, 200);
    const enrolled = (await enroll.json()) as EnrollRemoteServerResponse;
    assert.ok(enrolled.server_id.startsWith("srv_"));
    assert.ok(enrolled.remote_control_token.startsWith("rct_"));

    // 旧 token refresh → 新 token
    const refresh = await fetch(`${base}${REST_PATHS.refresh}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${enrolled.remote_control_token}`,
      },
      body: JSON.stringify({
        server_id: enrolled.server_id,
        installation_id: "inst-1",
      }),
    });
    assert.equal(refresh.status, 200);
    const refreshed = (await refresh.json()) as EnrollRemoteServerResponse;
    assert.notEqual(refreshed.remote_control_token, enrolled.remote_control_token);

    // 无效 token → 401
    const bad = await fetch(`${base}${REST_PATHS.refresh}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ server_id: enrolled.server_id, installation_id: "inst-1" }),
    });
    assert.equal(bad.status, 401);

    // pair（用新 token）
    const pair = await fetch(`${base}${REST_PATHS.pair}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${refreshed.remote_control_token}`,
      },
      body: JSON.stringify({ manual_code: true }),
    });
    assert.equal(pair.status, 200);
    const paired = (await pair.json()) as { manual_pairing_code: string | null; claimed?: boolean };
    assert.equal(paired.manual_pairing_code, "123-456");

    // pair/status → claimed
    const status = await fetch(`${base}${REST_PATHS.pairStatus}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code: "pc_1" }),
    });
    assert.deepEqual(await status.json(), { claimed: true });

    assert.ok(server["enrollment"], "enrollment 已保存");
  } finally {
    await server.stop();
  }
});

test("WS：握手头记录、rpc 下发(client_message)、响应(server_message)匹配、ack 回执、分片重组、帧落盘", async () => {
  const { server, port, jsonlPath } = await startMock();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REST_PATHS.websocket}`, {
      headers: {
        [WS_HEADERS.serverId]: "srv_test",
        [WS_HEADERS.name]: Buffer.from("probe-host").toString("base64"),
        [WS_HEADERS.protocolVersion]: "3",
        [WS_HEADERS.installationId]: "inst-1",
      },
    });
    // 测试端扮演 codex：收到 ClientEnvelope，发出 ServerEnvelope
    const receivedClientFrames: ClientEnvelope[] = [];
    ws.on("message", (data) => {
      receivedClientFrames.push(JSON.parse(data.toString()) as ClientEnvelope);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // 模拟手机 rpc：mock 下发 client_message（JSON-RPC 请求）
    const rpcPromise = server.rpc("initialize", { client_info: { name: "t" } }, 5000);
    await waitFor(() => receivedClientFrames.some((f) => f.type === "client_message"));
    const req = receivedClientFrames.find((f) => f.type === "client_message")!;
    assert.ok(req.message && "method" in req.message);
    assert.equal(req.message.method, "initialize");
    assert.equal(req.client_id, server.mobileClientId);
    assert.ok(req.stream_id);

    // codex 方向回 server_message 响应（带 seq_id）
    const rpcId = (req.message as { id: number }).id;
    ws.send(
      JSON.stringify({
        type: "server_message",
        client_id: req.client_id,
        stream_id: req.stream_id!,
        seq_id: 1,
        message: { jsonrpc: "2.0", id: rpcId, result: { user_agent: "test" } },
      } satisfies ServerEnvelope),
    );
    const reply = await rpcPromise;
    assert.deepEqual("result" in reply ? reply.result : null, { user_agent: "test" });

    // mock 应回 ack(seq_id=1)
    await waitFor(() => receivedClientFrames.some((f) => f.type === "ack"));
    const ackFrame = receivedClientFrames.find((f) => f.type === "ack")!;
    assert.equal(ackFrame.seq_id, 1);

    // 分片：codex 发 server_message_chunk × 2，mock 重组后匹配响应
    const rpc2 = server.rpc("thread/list", {}, 5000);
    await waitFor(() => receivedClientFrames.some((f) => f.type === "client_message" && f.message && "method" in f.message && f.message.method === "thread/list"));
    const req2 = receivedClientFrames.find(
      (f) => f.type === "client_message" && f.message && "method" in f.message && f.message.method === "thread/list",
    )!;
    const rpc2Id = (req2.message as { id: number }).id;
    const full = JSON.stringify({ jsonrpc: "2.0", id: rpc2Id, result: { threads: [] } });
    const b64 = Buffer.from(full, "utf8").toString("base64");
    const mid = Math.ceil(b64.length / 2);
    for (const [seg, chunk] of [
      [0, b64.slice(0, mid)],
      [1, b64.slice(mid)],
    ] as const) {
      ws.send(
        JSON.stringify({
          type: "server_message_chunk",
          client_id: req2.client_id,
          stream_id: req2.stream_id!,
          seq_id: 2 + seg,
          segment_id: seg,
          segment_count: 2,
          message_size_bytes: full.length,
          message_chunk_base64: chunk,
        } satisfies ServerEnvelope),
      );
    }
    const reply2 = await rpc2;
    assert.deepEqual("result" in reply2 ? reply2.result : null, { threads: [] });

    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const lines = (await readFile(jsonlPath, "utf8")).trim().split("\n");
    const dirs = new Set(lines.map((l) => (JSON.parse(l) as { dir: string }).dir));
    assert.ok(dirs.has("codex→mock"));
    assert.ok(dirs.has("mock→codex"));
  } finally {
    await server.stop();
  }
});

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor 超时"));
      }
    }, 20);
  });
}
