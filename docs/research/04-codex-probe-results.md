# 04 · codex 远程控制探测结果（mock wham 实证）

日期：2026-09-25 · 探测人：bridge 项目

## 目标与环境

用本地 mock wham 服务器扮演 chatgpt.com 远程控制后端 + 模拟手机端，
让真实 codex 连上来，验证 enroll → WebSocket 隧道 → 双向 JSON-RPC 的完整数据链路。

| 项 | 值 |
|---|---|
| codex | 0.156.1（homebrew 安装版） |
| mock wham | 本仓库 `src/wham/mockServer.ts`（Node + ws，零外部状态） |
| codex CODEX_HOME | 独立目录（假凭证，未使用 `~/.codex` 真实登录态） |
| chatgpt_base_url | `http://127.0.0.1:8787/backend-api`（localhost 放行规则生效） |

## 结果总览：全链路打通 ✅

1. **enroll** ✅ codex POST `{name:"MacBook-Pro.local", os:"macos", arch:"aarch64",
   app_server_version:"0.156.1", installation_id:<uuid>}`，mock 返回
   `{server_id, environment_id, remote_control_token, expires_at}`。
2. **WebSocket 隧道** ✅ codex 拨出 WS，握手头齐全：
   `x-codex-server-id` / `x-codex-name`(base64) / `x-codex-protocol-version: "3"` /
   `authorization: Bearer <remote_control_token>` / `x-codex-installation-id`。
3. **心跳** ✅ codex 每 10s 发 **WS 协议层** Ping（非 JSON 帧），WS 栈自动回 Pong 即可。
4. **模拟手机 → codex JSON-RPC** ✅ `initialize` / `thread/list` / `thread/start`
   全部返回真实响应（见下）。
5. **codex → 模拟手机 通知** ✅ 主动收到 `remoteControl/status/changed`、
   `thread/started`、`mcpServer/startupStatus/updated`。
6. **seq/ack** ✅ codex 发出的每条 server_message 带 `(client_id, stream_id)` 维度
   递增的 `seq_id`；服务器须回 `{"type":"ack","seq_id":N}`。
7. **enrollment 持久化 + 断线重连** ✅ mock 重启后 codex 用持久化 enrollment
   （不再 enroll）自动重连。

## 协议实证细节（踩坑修正）

### 1. 帧方向（最关键、最容易搞反）

类型以 **codex 视角**命名——"client" 指**手机（远端控制器）**：

- **codex 收到的一切 JSON 帧是 `ClientEnvelope`**（client_message /
  client_message_chunk / ack / ping / client_closed）。手机要发给 codex 的
  JSON-RPC 请求装在 `client_message.message` 里，由 wham 服务器代替手机下发。
- **codex 发出的一切 JSON 帧是 `ServerEnvelope`**（server_message /
  server_message_chunk / pong），必带 `client_id` + `stream_id` + `seq_id`。

把 server_message 发给 codex 会被 serde 静默丢弃（解析失败仅 warn），表现为
"无响应无 ack"。实证位置：`websocket.rs:1180`（reader 解析 `ClientEnvelope`）、
`websocket.rs:1040-1045`（writer 构造 `ServerEnvelope`）。

### 2. JSON-RPC 参数与响应的命名

- 请求 params 用 **camelCase**（`clientInfo`，不是 `client_info`）——
  发 snake_case 会得到 `-32600 Invalid request: missing field 'clientInfo'`。
- codex 响应的 message 只有 `{"id", "result"|"error"}`，**没有 `jsonrpc` 字段**
  （`OutgoingMessage` untagged 序列化）。

### 3. 实测帧样本（2026-09-25 session）

下发（mock→codex）：

```json
{"type":"client_message","client_id":"mock-mobile-client","stream_id":"3f0092fb-…",
 "message":{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"clientInfo":{"name":"codex_mobile_probe","title":"ChatGPT Mobile (mock)","version":"0.1.0"}}}}
```

响应（codex→mock）：

```json
{"type":"server_message","message":{"id":1,"result":{
  "userAgent":"codex_mobile_probe/0.156.1 (Mac OS 26.6.2; arm64) dumb (codex_mobile_probe; 0.1.0)",
  "codexHome":"…","platformFamily":"unix","platformOs":"macos"}},
 "client_id":"mock-mobile-client","stream_id":"3f0092fb-…","seq_id":1}
```

ack（mock→codex）：

```json
{"type":"ack","client_id":"mock-mobile-client","stream_id":"3f0092fb-…","seq_id":1}
```

方法响应摘要：

| 方法 | 响应（截取） |
|---|---|
| `initialize` | `{userAgent, codexHome, platformFamily:"unix", platformOs:"macos"}`；未 initialize 前其他方法返回 `-32600 "Not initialized"` |
| `thread/list` | `{data:[], nextCursor:null, backwardsCursor:null}` |
| `thread/start` | `{thread:{id:"<uuidv7>", environments:[{environmentId:"local", cwd, runtimeWorkspaceRoots}], sessionId, forkedFromId, …}}` |

主动通知（本探测中实测出现）：

- `remoteControl/status/changed {status:"connected", serverName, installationId, environmentId}`
- `thread/started {thread:{…}}`
- `mcpServer/startupStatus/updated {threadId, name:"codex_apps", status, error}`

### 4. 消息分片

codex → 手机方向的整消息超过约 100KiB（目标）/150KiB（上限）时拆为
`server_message_chunk`（base64 分段，`segment_id`/`segment_count`/
`message_size_bytes`），ack 时需带 `segment_id`。本次探测的消息均未触发分片。
常量：`segment.rs:19-21`。

## 环境坑记录

1. **Unix socket SUN_LEN**：`app-server-control.sock` 路径必须 <104 字符，
   项目目录过深导致 `path must be shorter than SUN_LEN`。
   解决：CODEX_HOME 放短路径（如 `~/.cache/cgc-bridge`）。
2. **daemon 残留**：`codex remote-control start` 失败（如 SUN_LEN）也可能已
   拉起 daemon 并连上 mock；`remote-control stop` 只停指定 CODEX_HOME 的。
   排查时留意 `codexHome` 字段暴露的真实 home。
3. **models 刷新 401**（假凭证 + 真实 chatgpt.com URL）：`codex/models` 刷新
   走的 URL 不受 `chatgpt_base_url` 影响，仅报 ERROR 不阻断 remote control。

## 产物

- mock wham 服务器：`src/wham/mockServer.ts`（`npm run wham -- --port 8787`）
- 帧日志（38 行完整实录）：`.agent-work/tmp/wham-probe/session-2026-09-25T18-06-07-397Z.jsonl`
- 单测（REST/WS/分片/ack）：`test/wham.test.ts`

## 下一步

1. 真实登录：`npm run auth -- login`（浏览器 ChatGPT OAuth，需用户参与），
   凭证落在 bridge 自己的 CODEX_HOME。
2. 用真实凭证 + 真实 `wss://chatgpt.com/backend-api/wham/remote/control/server`
   验证 enroll/pair（手机 ChatGPT App 配对）。
3. bridge 侧实现 wham 客户端（本探测的帧格式即最终实现规格），
   再接 ZCode 驱动层。
