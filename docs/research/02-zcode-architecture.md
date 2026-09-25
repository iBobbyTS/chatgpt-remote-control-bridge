# ZCode 架构与可编程接口调查

> 源码：`reference/ZCode`（z.ai，version `3.14.3`，commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，2026-09-24）
> 问题：ZCode 有哪些可编程驱动接口（app-server/CLI）？手机远控 `zcode.z.ai/remote/v4` 的实现是否开源？

## 仓库结构（pnpm monorepo，Node 24.14.0 / pnpm 10.33.2）

| 目录 | 包名 | 说明 |
| --- | --- | --- |
| `apps/zcode-cli/` | （独立 workspace） | 终端 agent CLI（TUI + headless）与运行时源码（`packages/core`、`contracts`、`bootstrap`、`tui` 等） |
| `packages/desktop/` | | Electron 桌面应用。main 进程 + 每窗口 UtilityProcess host（跑 `@zcode/services`） |
| `packages/server/` | `@zcode/server` | **独立 headless HTTP+WS 服务**（见下） |
| `packages/zcode-server-cli/` | `@zcode/server-cli` | bin 名 `zcode`；service 安装 / stable launcher / update / uninstall |
| `packages/rpc/` | `@zcode/rpc` | VS Code 风格 RPC：`ChannelServer`/`ChannelClient`/`SocketProtocol`/serialization |
| `packages/services/` | `@zcode/services` | `ServiceCollection` + 各服务接口；`createLocalServices()` 工厂 |
| `packages/shared/` | `@zcode/shared` | 含 `zcode-protocol-v4/`（conversation 协议 v4，~50 文件） |
| `packages/web/` | | 仅 web 开发模式（vite, 5173→3030 代理）+ 会话分享预览；**不含手机远控 UI** |
| `packages/ui/` | | 桌面/Web 共用 React 组件（含 v4/ 目录） |

## 可编程接口（路径 1 的三个层次）

### ① `@zcode/server` — 官方 headless 服务（推荐接口）

`packages/server/src/entry-http.ts` + `http.ts`（Hono + `@hono/node-ws`）：

- 默认端口 3030；`ZCODE_SERVER_HOST`、`ZCODE_SERVER_WORKSPACE`（默认 cwd）、`ZCODE_SERVER_AUTH_TOKEN`（开启后 `/ws` 与 `/api/*` 需 token，支持 `?token=` 或 cookie）
- 端点：
  - `GET /api/server-info` — serverId/版本/协议版本/workspaces/capabilities
  - `POST /api/rpc-host-capability` — 签发 host capability（一次性）
  - `GET /ws` — WebSocket 升级为 ChannelServer，**clientMode 为 `web-remote-replayable`（terminal-client）**；这正是网页版 UI 驱动 ZCode 的通道
  - `GET /ws/host` — 受信桌面 host 通道（需 `ZCODE_RPC_HOST_CAPABILITY_HEADER`，`desktop-continuous`；Provider Provisioning 等敏感操作仅此模式）
  - `POST /api/connect-remote` + `GET /ws/remote/:id` — web 模式发起 SSH/WSL/Docker 远程连接并桥接
  - `POST /api/bots/:provider(/:botId)` — Bot 渠道 webhook 回调
- 连接后经 `services.exposeOnChannelServer(server, overrides)` 暴露服务：`IZCodeAgentService`、`IFileService`、`IGitService`、`ISystemService`、`ITerminalService`、`IBotsService`（Provisioning target 对非 trusted client 拒绝）
- bridge 若为 Node/TS，可直接 `import { ChannelClient } from "@zcode/rpc"` 连接（协议零逆向），或直接依赖 workspace 包构建

### ② `IZCodeAgentService` — 核心驱动接口

`packages/services/src/zcode-agent/zcodeAgent.ts:569-740+`：

- 会话管理：`createSession` / `resumeSession` / `listSessions` / `listSessionSubagents` / `readSession` / `readSessionMessages` / `readSessionEvents` / `closeSession`
- 运行控制：`compactSession` / `goalSession` / `setModel` / `setThoughtLevel` / `setMode` / `interrupt`（经 v4 命令面）
- 旧订阅面（deprecated）：`sendPrompt`、`onDynamicSessionEvent`
- **v4 conversation 通道（现行主路径）**：`helloConversationV4()`（读 host 可信 hello）→ `initializeConversationV4(clientHello)` → `subscribeConversationV4(params)` + v4 命令（`sendText` 等）；帧含 snapshot / rows 增量 / sessions-index / workspace-config
- 旁路能力：plugins / skills / workflows（listSavedWorkflows 等）/ automations（定时任务）/ MCP 状态 / 资源遥测

v4 协议实现细节在 `packages/shared/src/zcode-protocol-v4/`（`wire.ts`/`wire-codec.ts`/`wire-assembler.ts`/`wire-reassembly.ts`/`transport.ts`/`snapshot.ts`/`rows.ts`/`delta.ts`/`command.ts` 等），CLI 侧网关在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`。

### ③ `zcode` CLI headless 模式（快速原型备选）

`apps/zcode-cli/packages/cli/src/prompt-command.ts`：

- 非交互执行 prompt，`--output-format text|json|stream-json`（逐事件输出）
- `headless-workflow.ts`：`createHeadlessPermissionBroker`（无 UI 审批策略）、`createHeadlessSessionObserver`、`waitForHeadlessWorkflowSettle`
- 类似 `codex exec`，粒度较粗但零依赖

## 手机远控（`/remote/v4`）不开源的证据

用户实测链接形态：`https://zcode.z.ai/remote/v4?sid=…&hash=…&t=…&mid=…&name=MacBook-Pro.local&app_version=3.14.3`

1. **生成该链接的代码不在仓库**：全仓库按 `remote/v`、`sid`+`hash`+`mid`、`app_version` 等 URL 构造搜索无果（仅遥测/force-update 用到 `app_version`，无关）。
2. **relay 常量只有声明没有实现**：`VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 只出现在 `packages/web/src/env.d.ts:17`，整个 web 包无任何引用——手机远控 Web UI（部署在 zcode.z.ai）与云端 relay 闭源。
3. **本地端连接 relay 的客户端闭源**：desktop/services/shared 中无 `remoteControl` 命名实现；仓库内"远程"代码均属其他功能：
   - `packages/server/src/remote/`、`packages/desktop/src/main/desktopRemoteSessions.ts` — SSH/WSL/Docker **远程工作区部署**（把 agent 部署到远程机器），不是手机远控
   - `packages/services/src/bots/` — Bot 渠道（微信/飞书/lark/Telegram）远控，开源，但与 `/remote/v4` Web 链接是两条独立通路
4. **开源的部分**只有协议与挂载点：
   - v4 conversation 帧格式（上述 `zcode-protocol-v4/`）——手机 remote 是其订阅者之一（`v4-gateway.ts:2714` 注释："该会话是否还有 conversation 订阅者（桌面 tab / 手机 remote）"）
   - `clientMode: "web-remote-replayable"` 挂载点（`desktopRemoteSessions.ts:887`、`http.ts` setupChannelServer）
   - UI 侧痕迹：`packages/web/src/env.d.ts:6`（"手机远控按构建 base 区分 /remote 和 /remote/v3"——v3→v4 迭代证据）、`packages/ui/src/v4/conversationRowContext.ts:54`（"手机 /remote 紧凑模式"）
5. **推断**：手机远控数据通路为 手机浏览器（zcode.z.ai 云端 Web UI）→ Z.ai relay（`VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`）→ 本地桌面（闭源客户端）。`hash` 疑为链接签名、`sid` 会话 id、`mid` 机器 id、`t` 时间戳——算法均不可见，需抓包+反编译才能确定。
