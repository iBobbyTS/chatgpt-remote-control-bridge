# codex 远程控制功能调查

> 源码：`reference/codex`（openai/codex，main @ `f92655d07f40c9999915cd9244291ad3acfc2dca`，2026-09-25）
> 问题：手机 ChatGPT App 远程控制 codex 的功能是否在开源源码里？

## 结论

**被控端（运行在电脑上的 codex）完整开源，手机 App 和云端中继服务不开源。**

## 代码位置

### 核心模块

`codex-rs/app-server-transport/src/transport/remote_control/`，约 20 个文件：

| 文件 | 职责 |
| --- | --- |
| `protocol.rs` | 消息/信封定义、URL 规范化（`normalize_remote_control_url`） |
| `websocket.rs` | 与 wham 服务器的 WebSocket 长连接（`RemoteControlWebsocket`） |
| `server_api.rs` | enroll/refresh/pair 等 REST 调用 |
| `enroll.rs` / `persistence.rs` | 本机环境注册、sqlite 持久化 |
| `auth.rs` | 复用 codex 登录态（`AuthManager`），401 自动恢复 |
| `clients.rs` | 已配对客户端 list/revoke |
| `controller.rs` / `mod.rs` | 会话生命周期（`RemoteControlSession`、enable/disable/start_pairing） |
| `segment.rs` / `client_tracker.rs` | 大消息 base64 分片、多客户端路由 |
| `desired_state.rs` / `host_device.rs` | 期望状态机、主机设备标识 |
| `tests/` + `*_tests.rs` | 配对/重试/分片/websocket 刷新等单元测试 |

### 入口与开关

- CLI 子命令：`codex remote-control [start|stop|pair]` — `codex-rs/cli/src/remote_control_cmd.rs`；在 `codex-rs/cli/src/main.rs:172` 标注 `[experimental]`
- feature flag：`remote_control` — `codex-rs/features/src/lib.rs:1777`
- app-server 协议侧类型：`codex-rs/app-server-protocol` 中的 `RemoteControl*`（PairingStart/StatusParams、ClientsList/Revoke、ConnectionStatus、StatusChangedNotification）
- 企业禁用：managed requirements → `RemoteControlPolicy::DisabledByRequirements`（`mod.rs:73`）；daemon 内部环境变量 `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED`（`mod.rs:87`）

## 工作链路（从源码还原）

1. **长连接**：本地 codex 作为客户端连接 `wss://chatgpt.com/backend-api/wham/remote/control/server`（"wham" 服务）。URL 规范化见 `protocol.rs:300-312`；staging 为 `api.chatgpt-staging.com`。
2. **注册与配对**：
   - `enroll` / `refresh` 接口（`.../enroll`、`.../refresh`）把本机环境注册到 ChatGPT 后端，含 `installation_id`、`server_name`（hostname）
   - 配对端点 `.../pair`、`.../pair/status`，支持 pairing code（扫码）与 manual pairing code（手动输入）两种方式
   - 已配对设备可 `list` / `revoke`（`clients.rs`）
3. **远程驱动**：隧道里承载的就是标准 app-server 协议 JSON-RPC：
   - 手机→本地：`ClientEvent::ClientMessage { message: JSONRPCMessage }`（`protocol.rs:106`）
   - 本地→手机：`ServerEvent::ServerMessage { message: OutgoingMessage }`（`protocol.rs:154`）
   - 即远程客户端可以完整驱动 codex（新建任务、发送用户输入、接收流式输出），与本地 IDE 扩展同一套协议
4. **可靠性设计**（全部在开源代码中，可直接照抄语义）：
   - `seq_id`/`ack` 确认 + `cursor` 断线续传
   - 大消息 base64 分片（`segment_id`/`segment_count`/`message_chunk_base64`）
   - `ping`/`pong` 心活
   - 服务端过载时 `retry-after` 截止时间在 enrollment 状态中共享（`mod.rs:133-204`）
5. **鉴权**：复用 codex 的 ChatGPT 账号 OAuth 登录态（`codex-rs/login` 的 `AuthManager`）；auth 错误触发恢复流程后重试。

## 重要测试口子：localhost URL

`normalize_remote_control_url`（`protocol.rs:197-271`）只允许：

- `chatgpt.com` / `*.chatgpt.com`（HTTPS）
- `chatgpt-staging.com` 系（HTTPS）
- **localhost（HTTP/HTTPS）**

→ bridge 可以起一个**本地 mock wham 服务**做端到端离线测试（enroll/pair/隧道全流程），不必每次碰线上。

## 隧道内的 app-server JSON-RPC 方法集

方法枚举由宏生成，定义在 `codex-rs/app-server-protocol/src/protocol/common.rs`（`ClientRequest`/`ServerRequest`/`ServerNotification`，wire 名 snake_case 如 `thread/start`）。抽样（共数十个）：

- `thread/start`、`thread/resume`、`thread/fork`、`thread/list`、`thread/read`、`thread/items/list`、`thread/turns/list`
- `thread/compact/start`、`thread/revert`、`thread/shellCommand`、`thread/settings/update`、`thread/metadata/update`
- `thread/queue/*`（add/list/update/delete/reorder/start，experimental）
- `thread/realtime/start`、`thread/realtime/appendAudio`（experimental）
- 审批类 server→client 请求（applyPatch / execCommand approval 等）与 `interrupt`

类型定义在 `protocol/v1.rs`（如 `InitializeParams`/`InitializeResponse`/`ConversationSummary`）。

**注意**：手机 App 实际调用的方法子集未知（协议全集很大）。实证方法：跑真的 `codex remote-control start` + 手机配对，开 debug 日志观察 app-server 收到的调用序列——这就是 bridge 适配层的需求清单。

## 不在开源部分

- 手机上的 ChatGPT App（iOS/Android 客户端）
- `chatgpt.com` 后端的 wham remote control 中继服务（服务端）
