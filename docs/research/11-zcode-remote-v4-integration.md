# 11 - ZCode 官方 remote/v4 通路逆向与桥接入方案

- 状态：**逆向完成 + 真实凭证端到端实测通过**（2026-09-27）
- 决策背景：用户拍板放弃 ACP 自研 zcode serving agent（不能保证与 GUI 完全同步），改为接入官方 remote/v4 通路以获得"手机远程控制 = GUI 本体"的完全同步语义。
- 证据方法：解包 `/Applications/ZCode.app/Contents/Resources/app.asar`（v3.14.3）主进程/host 包并美化；抓取官方手机 Web UI 公网 JS（`zcode.z.ai/remote/v4/latest/assets/`）；对照本机 `~/.zcode/v2` 真实状态；**用真实 sid/hash 以 terminal 角色接入官方中继，在 `reference/test_rc` 工作区完成全链路实测（含 GLM-5.3-Flash 真实模型调用与权限请求结构抓取）**。
- 逆向工作产物（代码引用均在此目录）：`.agent-work/tmp/zcode-v4-reverse/`
  - `main-index.pretty.js`（主进程，含 device 腿 + WebRemoteControlManager）
  - `main-chunk.pretty.js`（共享 chunk，含 rpc-frame 规格与 QR URL 构造）
  - `main-chunk2.pretty.js` / `host-chunk*.pretty.js` / `host-index.pretty.js`（端口协议与 host 服务）
  - `web-index.js` / `web-src.js`（手机 Web 端，terminal 腿 + 服务代理）
  - `probe-v4.mjs`（**terminal 探针：4 层协议全实现，实测通过**）、`matrix-*.mjs`（隔离实验）
  - `mock-relay.mjs` / `mock-device.mjs`（本地 mock 中继+device+ChannelServer，桥开发测试夹具）
  - `probe-*.log`（实测日志）

## TL;DR

1. **官方通路三层全部逆向成功且实测打通**：本地 device 腿（GUI 主进程内）、云中继 `wss://zcode.z.ai/ws`、手机 terminal 腿（公网 Web UI）。协议无混淆，全部为明文 JSON 信封 + 已还原的二进制内层。探针已用真实凭证走完：配对 → bootstrap → workspace-bridge → Channel RPC → 建会话 → **GLM-5.3-Flash 真实对话** → 事件流 → **权限请求结构抓取**。
2. **链接即凭证**：QR URL 里的 `sid`+`hash` 就是中继配对凭证（hash = 随机 24 字节密码的 SHA256-base64）。桥拿到这条链接即可作为"手机"接入。**实测确认链接长期有效、可反复使用**。
3. **桥的正确接入姿势 = terminal 角色**：桥冒充手机 Web 端连中继，GUI 作为 device 腿不动。手机/桥的一切操作都发生在 GUI 的 workspace host 里 → **与 GUI 完全同步是协议结构保证的，不是仿真**。
4. **桥要实现 5 层协议**（全部有规格+探针参考实现）：中继握手（HMAC proof + mid 路由）→ 应用 payload（bootstrap/bridge-open）→ rpc-frame 可靠分片传输 → 裸 VQL Channel RPC（39 个服务通道）→ v4 conversation 层（hello/命令信封/订阅事件流）。
5. 开放问题全部关闭（§10）：权限映射实测确定、建会话调用链实测确定、终端互斥用户已拍板接受。

## 一、完整架构

```
ChatGPT 手机 App (wham)                      手机浏览器 (官方 Web UI)
      │ wham 协议                                    │ terminal 腿（同一协议）
      ▼                                              ▼
┌─────────────┐   AgentApp    ┌──────────────────────────────┐
│ cgrcb 桥     │ ───────────▶ │  wss://zcode.z.ai/ws 云中继    │
│ (新增 terminal│              │  （配对路由 + 可靠传输边界）     │
│  角色客户端)  │ ◀─────────── │                              │
└─────────────┘   data 帧     └──────────────────────────────┘
                                     ▲ device 腿（GUI 主进程内）
                                     ▼
                     ┌────────────────────────────────┐
                     │ ZCode GUI 主进程                 │
                     │  WebRemoteControlManager         │
                     │  AttachServicePort{              │
                     │    clientMode:web-remote-replayable}│
                     └──────────────┬─────────────────┘
                                    ▼ Electron MessagePort
                     ┌────────────────────────────────┐
                     │ workspace host（共享 host 进程）  │
                     │ session 服务 = ZCode Protocol v1 │
                     │  session/create|send|subscribe…  │
                     └──────────────┬─────────────────┘
                                    ▼ spawn
                          zcode.cjs app-server --stdio --cwd <workspace>
```

要点：
- device 腿在 **GUI 主进程**里（`main-index.pretty.js` `WebRemoteControlDeviceTransport`），GUI 开启"Web 远程控制"后常驻连接中继。今天（09-27）本机日志显示 device 腿处于 `waiting_terminal` 状态——中继侧已在等终端接入。
- `workspace-bridge-open` 后，主进程向**该窗口的共享 host 进程**请求 `attach-service-port`（`clientMode:"web-remote-replayable"`），拿到 MessagePort 后把 rpc-frame 字节流与 host 双向直通。**GUI 渲染器与手机/桥看到的是同一个 host、同一批会话**——这就是完全同步的结构保证。
- host 的 session 服务内部就是 ZCode Protocol v1（`session/setModel`、`session/close`…与 doc 10 探测的同一套），并 spawn `zcode.cjs app-server --stdio --cwd <ws>` 作为 agent runtime。

## 二、中继协议（wss://zcode.z.ai/ws）

物理层：单个 WebSocket（`perMessageDeflate`），每帧一条 UTF-8 JSON：`{type, ...}`。物理帧上限 `maxPhysicalFrameBytes`（超限直接丢弃）。

### 2.1 device 角色（GUI 侧）

连接：`wss://zcode.z.ai/ws?mid=<deviceMid>`，附加 header `X-Device-ID: <deviceMid>`。

| 步骤 | 方向 | 消息 |
|---|---|---|
| 注册（首次） | dev→relay | `{type:"device_register_init", device_mid, pass_hash, meta:{platform,version,name}, client_ts}` |
| 注册回执 | relay→dev | `{type:"device_register_ack", device_sid}` → 本地持久化 `{deviceSid, passHash}` |
| 认证（后续） | dev→relay | `{type:"auth_init", role:"device", device_sid, meta, client_ts}` |
| 挑战 | relay→dev | `{type:"auth_challenge", nonce}` |
| 应答 | dev→relay | `{type:"auth_response", device_sid, proof, client_ts}` |
| 配对状态 | relay→dev | `{type:"auth_ack"|"pair_status_ack", pair_status:"waiting"|"matched"}` |
| 心跳 | dev→relay | `{type:"pair_status_query", device_sid, client_ts}`（10s 周期，30s 无 ack 即重连） |
| 数据 | 双向 | `{type:"data", payload:{zcode_type...}|{rpc-frame...}, client_ts?, server_ts?}` |
| 错误 | relay→dev | `{type:"error", code, message}` |

### 2.2 terminal 角色（手机/桥侧）

与 device 对称，差异：
- `auth_init` 用 `role:"terminal"`；meta 建议 `{platform:"web", version, name}`。
- **URL 的 `?mid=` 必须用 QR 链接里的 deviceMid（=device 腿的 mid）——中继按 mid 做会话路由**。实测矩阵：mid=deviceMid → 立即 matched；自造 mid → auth 通过但 `pair_status:"waiting"`（中继找不到 device），约 17s 后被 `KICKED`（排队超时清理，**不是**有竞争终端）。最初误判为"手机页面抢占"，用户确认手机未开后通过矩阵实验定位真因。
- **waiting 状态也必须发 10s 心跳**（`pair_status_query`）——中继据此评估配对。
- 无注册流程，凭证就是 `device_sid`+`pass_hash`（来自 QR 链接）。
- 额外错误码 `DEVICE_OFFLINE`；**实测：已注册但离线的 device 表现为 terminal 认证通过 + 持续 `waiting`**（DEVICE_OFFLINE 未复现，推测用于配对后 device 掉线的推送）；`waiting` 30s 未配对 → 终态失败 `invalid-mobile-connection`。
- 页面隐藏时 `suspend()`，回前台 `recoverConnection()`。
- `auth_ack(matched)` 后即可发首个 data 帧（**实测立即发送 631ms 内成功**，无需人为延迟）。

### 2.3 proof 公式（两端一致）

```
passHash = base64( SHA256( randomBytes(24).toString("base64url") ) )   // 32B, base64 标准字母表
proof    = base64url( HMAC-SHA256( key=passHash, msg=`${nonce}|${role}|${device_sid}` ) )
```

- 桌面实现：`createNodeWebRemoteControlRelayAuthProvider`（main-index 19240 行附近）。
- Web 实现：WebCrypto 版同公式。桥直接用 Node `crypto.createHmac` 即可。

### 2.4 错误码语义

| code | 含义 | 终端侧行为 | device 侧行为 |
|---|---|---|---|
| `KICKED` | 同 sid 出现竞争连接 | 终态 `session-conflict` | 关 socket 重连 |
| `AUTH_FAILED` | proof/sid 错 | 终态 `invalid-mobile-connection` | 清凭证重新 register |
| `WRONG_PARAM` | 参数不合法 | 终态 `invalid-mobile-connection` | 报错 |
| `DEVICE_OFFLINE` | device 腿离线 | 等待恢复 | — |
| `INTERNAL` | 中继内部错 | 已配对则转 waiting 等恢复 | 重连 |

HTTP 侧对应错误码（token 入口用）：4004 session-not-found / 4009 session-conflict / 4010 desktop-disconnected / 4011 session-expired / 4012 workspace-closed / 4013 invalid-mobile-connection。

## 三、应用层 payload（data 帧内，JSON，`zcode_type` 判别）

> **实测重要细节（序列化层差异）**：device → terminal 方向的部分响应 payload 在 wire 上**没有 `zcode_type`/`success` 字段**（如 bootstrap-response、workspace-list-updated 只见 `{requestId, result}` / `{result}`），而 workspace-bridge-ready 带 `zcode_type`。**终端匹配响应一律按 `requestId`，不要依赖 `zcode_type`**。另：data 帧（应用 payload）实测可达 **99KB+**（中继无 1KB 限制；`maxFrameBytes=1024` 只是 rpc-frame 单片信封的 schema 校验值，见 §5）。
>
> workspaces 数组元素（wire）：`{workspacePath, workspaceIdentity?, remoteSessionId?, kind}` —— **不含 workspaceKey**；`workspaceKey ≡ workspaceIdentity?.trim() || workspacePath`，由终端派生后用于 `workspace-bridge-open`。

terminal→device：

| zcode_type | 关键字段 | 作用 |
|---|---|---|
| `bootstrap-request` | requestId | 启动握手，要 workspace/task 清单 |
| `workspace-list-request` | requestId | 刷新清单 |
| `workspace-bridge-open` | requestId, **bridgeSessionId**(随机), **bridgeGeneration**(递增), recoveryId?, workspaceKey, taskId? | 打开某个工作区的 bridge（rpc-frame 通道） |
| `workspace-reconnect-request` | requestId, workspaceKey | 重连远端工作区 |
| `platform-request` | requestId, method, args | 调桌面平台能力 |
| `mobile-view-state-update` | viewState{activeWorkspaceKey, activeTaskId}, deviceInfo | 同步手机当前视图 |
| `rpc-frame` / `rpc-frame-ack` | 见 §5 | 可靠字节流（走 raw 通道优先） |
| `telemetry-report` / `mobile-diagnostic` | event | 遥测/诊断 |

device→terminal（应答 + 主动推送）：

| zcode_type | 说明 |
|---|---|
| `bootstrap-response` | `{requestId, success, result:{windowControlSessionId, desktopAppVersion, workspaces[], tasks[], initialViewState, mobileViewState}}` |
| `workspace-list-response` | 清单应答 |
| `workspace-bridge-ready` | `{requestId, bridgeSessionId, bridgeGeneration, recoveryId, bridge:{kind, workspaceKey, workspacePath, workspaceIdentity?, remoteSessionId?, initialTaskId}}` |
| `workspace-bridge-error` | bridge 建立失败/被关闭（reason: remote-session-closed 等） |
| `workspace-reconnect-response` | 重连结果 |
| `platform-response` | `{requestId, method, success, result|error}` |
| `workspace-list-updated` | 清单变化主动推送（含 task 标题/未读/置顶/归档等展示态） |
| `bridge-degraded` | rpc 传输降级（reason: rpc-transport-fault） |
| `app-error` | device 侧终态错误（desktop-disconnected 等） |

workspaces/tasks 元素：`{workspaceKey(=workspaceIdentity||workspacePath), workspacePath, workspaceIdentity?, remoteSessionId?, kind:"local"|"remote"}` / tasks 含 taskId、title、displayStatus、hasBackgroundWork、unreadAt、pinned、archived。

## 四、workspace bridge 生命周期

1. terminal 发 `workspace-bridge-open`（新 bridge 用新 `bridgeSessionId`，重连复用 id 并 `bridgeGeneration+1`，恢复用 `recoveryId`）。
2. device 校验 workspaceKey 在当前窗口可用 → `attachWorkspaceHost` → 向共享 host 进程 `attach-service-port {attachmentId, clientMode:"web-remote-replayable", scope:{kind:"local"|"remote",...}}` → 得 MessagePort。
3. 回 `workspace-bridge-ready`；此后该 bridgeSessionId 的 rpc-frame 双向直通 host。
4. 一个 device（窗口）同一时刻只有一个 currentBridge；`workspace-bridge-open` 换工作区 = 拆旧建新。
5. device 侧窗口关闭/停止 → `workspace-bridge-error` + `app-error(desktop-disconnected)`。

## 五、rpc-frame 可靠传输层

把任方向的一条 **完整消息（UTF-8 字节）** 切片传输，字段：

```
{ zcode_type:"rpc-frame", bridgeSessionId, bridgeGeneration?, recoveryId?,
  seq            // 物理帧序号（每方向独立、从 1 递增）
  messageSeq     // 逻辑消息序号（从 1 递增）
  fragmentIndex, fragmentCount, messageBytes,
  checksum:{algorithm:"crc32", value:"<8hex>"},
  dataBase64     // 该分片字节（规范 base64：重新编码后须与原文逐字节一致）
}
{ zcode_type:"rpc-frame-ack", bridgeSessionId, ..., ackMessageSeq }   // 累积确认
```

- 上限：单消息 16MB、≤64 分片、组装超时 30s、**单片信封（含 base64 数据）≤1024 字节**（`et.maxFrameBytes`，rpc-frame 的 zod 校验值；实测按"信封 JSON + 4/3×数据"预算切片即可）。
- 可靠性：发送方保留未 ack 批次（重放缓冲上限 8MB / 宽限 45s）；`onSendReady`（配对恢复/同 socket 重连）时 `replayUnacknowledged()`。**实测确认**：终端不回 ack 时 device 每 ~8s 重发未确认帧。
- 流控：未确认字节 > 高水位（1MB）→ 向对端/host 发 `saturated`，< 低水位（256KB）→ `drained`。
- 降级（不可恢复，需重建 bridge）：`remote.rpcFrame.{envelopeTooLarge,invalidIdentity,invalidPhysicalSeq,invalidMessageSeq,invalidPhysicalLimit,invalidMessageLimit,invalidFragmentLimit,emptyMessage,messageTooLarge,encodingFailed,outerMeterFailed,replayBufferExceeded,sendFailed,manuallyDegraded,ackTimeout…}`。

## 六、内层 Channel RPC（rpc-frame 载荷）＝ 裸 VQL 消息

**实测纠正**：rpc-frame 载荷**不含 13 字节帧头**。13 字节头（`type+id+ack+len`）只出现在 SocketProtocol（stdio/socket 传输）上；workspace host 走 Electron MessagePort → device 直通中继，**每条 rpc-frame 重组出的字节就是一条裸 VQL 消息**（`head 值 + args 值` 两个连续 VQL 值）：

- 消息类型：请求侧 `100 Promise / 101 PromiseCancel / 102 EventListen / 103 EventDispose`；应答侧 `200 Initialize / 201 PromiseSuccess / 202 PromiseError / 203 PromiseErrorObj / 204 EventFire`（实测 device 建桥后 ~150ms 主动发 Initialize=[200]）。
- VQL 编码：变长整数 + 类型标签（`0 undefined / 1 string / 2 Buffer / 3 VSBuffer / 4 Array / 5 Object(JSON) / 6 Int`；嵌套 Uint8Array 走 base64 标记 `__zcode_rpc_nested_uint8array_v1`）。**varint 位级规则**（自足规格，无需查参考码）：每值为一连串字节，低 7 位有效、**little-endian 组序**，最高位 (0x80) 为续位标志——`e=0` 编码为单字节 `0x00`；否则循环 `out[i]=e&0x7F; e>>>=7; if(e>0) out[i]|=0x80`。字符串/Buffer 体前缀 varint 长度（字节数）；Array = 标签+varint 元素数+元素序列；Object = 标签+varint 长度+JSON UTF-8 体。**整条消息 = 两个连续 VQL 值**（head 数组，然后 args 或 undefined 标签字节）。
- 打包（实测）：请求 head = `[100, requestId, channelName, method]`，随后单独序列化 args（`[arg0]` 或 undefined）；**EventListen(102) 的 args 就是监听上下文对象本身（不包数组）**，204 EventFire 的 id = 102 的 requestId。
- 语义：`channel.call(method, args)` / `channel.listen(method, ctx)`；服务代理约定 `on*` 前缀=事件、`onDynamic*`=带 ctx 的动态事件。
- 流控控制消息：`{__zcodeRpcControl:"connection-flow-v1", state:"saturated"|"drained"}`（只在 device↔host 端口上出现，不进 rpc-frame）。

参考实现：`main-chunk2.pretty.js`（serialize/deserialize/ChannelClient 全套）+ `probe-v4.mjs`（终端侧 4 层完整实现，已对真实 GUI 验证）。

## 七、服务通道目录

Channel 名全集（39 个，桌面/手机同表）：
`file, media-preview, system, terminal, git, git-checkpoint, setting, credential, cua-permission, cua-pip-session, broadcast, zcode-task, window-controller, zcode-agent, zcode-session, conversation-share, file-watcher, oauth, provider-settings, model-selection, provider-provisioning-target, usage-stats, coding-plan-subscription, client-scenes, skills, skill-sync, mcp-sync, plugin-sync, plugins, plugin-management, subagents, commands, hooks, memory, output-style, settings-sync, bots, feedback, repo-wiki, prompt-attachment-transfer, off-peak-task`

桥需要用到的核心方法（host 侧实现即 ZCode Protocol 包装，host-index.pretty.js）：

| 通道.方法 | 对应 ZCode Protocol / 功能 |
|---|---|
| **zcode-agent.sendPrompt** | session/send（turn 输入 + 内联附件；实测通道在 zcode-agent，非 zcode-session） |
| zcode-session.stop_generation（任务命令） | session/interrupt |
| zcode-session.respond_permission（任务命令） | interaction/requestPermission 应答 |
| zcode-session.respond_elicitation（任务命令） | 反向请求应答 |
| zcode-session.listSessions / readSession / readSessionMessages / readSessionEvents | 会话与历史 |
| zcode-session.setMode / setModel / setThoughtLevel | session/setMode 等 |
| zcode-session.compactSession / goalSession | compact / goal |
| zcode-session.subscribeConversationV4 / resyncConversationV4 | 会话事件流（delta 在此） |
| zcode-session.attachment*V4 | 附件上传（分块） |
| zcode-task.*（15 方法：rename/archive/pin/…） | 任务列表管理 |
| model-selection.getView / usage-stats.getEntitlementSnapshot | 模型清单 / 额度快照 |
| file.readdir / resolvePath | 只读文件面（写/删引导 agent 用工具；**terminal 通道已除名**：localTerminal:false，见 §十一-2） |
| credential.save / delete / setting.get / update | 配置 |

任务命令面（task-owner 命令，可 enqueue/promote/cancel）：`send_prompt{content, attachments, automationId}`, `stop_generation`, `respond_permission{permissionRequestId, optionId, response}`, `respond_elicitation{action:accept|decline|cancel, content}`, `respond_workspace_hook_review`。

### 7.1 v4 conversation 层（会话操作的实际入口，实测还原）

会话命令不走上面零散的 `zcode-session.*`，而是 **`zcode-agent` 通道的 V4 命令信封**。完整依赖链（顺序错误会得到 `fault.connection.*` 错误，全部实测）：

1. **`helloConversationV4(ctx)`**（ctx = workspace 定位 `{workspacePath, workspaceIdentity?}`）→ server hello：
   `{kind:"hello", protocolVersion:3, connectionId:"host-rpc-<uuid>", clientMode:"web-remote-replayable", deliveryProfile:"replayable", serverTime, capabilities:{nativeDialogs:false, localTerminal:false, binaryFrames:false, compression:"none", workspaceHookReview:true, independentPlanState:true, workflowRunDeltas:true}, auth:{}}`
2. **`initializeConversationV4(clientHello)`**（strict schema，**不得混入 workspace 字段**）：
   `{kind:"clientHello", protocolVersion:3, clientId, clientKind:"web"|"desktop", appVersion, capabilities:{workspaceHookReviewUi:true}}`
3. **命令信封 `sendConversationCommandV4({workspacePath, workspaceIdentity?, clientMode, envelope})`**：
   ```
   envelope = { type: <命令>, commandId: "<id>", issuedAt: <epoch ms>, clientId: "<同 clientHello>",
                sessionId: <null|sid>, payload: {...} }
   createSession.payload = { workspaceId: identity||path,
                             config: { provider?, model?, thought?, mode? }, mcpServers? }
   sendText.payload     = { text, heldQueueDisposition: "keepQueueAndSend"|"clearQueueAndSend"|…,
                            modelSelection?, toolDisallowlist?, attachments? }
   ```
   响应：`{commandId, status:"accepted"|"rejected"|"stale"|"duplicate"|"noop"|"failed", reasonCode?, result}`；createSession → `result:{type:"createSession", sessionId}`；sendText → `result:{type:"inputAccepted", delivery:"startNow"|"queue"|"guide", inputId, messageId?}`。

   **V4 命令全目录**（host zod 还原；UI 端 fork 按钮事件链 `v4-fork-*` → `fr("forkAssistant",…)` 实证）：
   | type | payload | 说明 |
   |---|---|---|
   | createSession / sendText | 见上 | 会话与输入 |
   | **forkAssistant** | `{target:{rowId, entityId}}` + 信封必带 **`baseRevision`**（state.updated 的 revision）与 **`baseLogEpoch`**（subscriptionId 去 `sub-` 前缀与 `-N` 后缀）——CAS 语义，缺任一报 `proto.invalidPayload`（实测踩坑） | **按行分叉**；响应 `result:{type:"forkAssistant", sessionId}`，纯聊天实测分叉成功且历史完整 |
   | stop | `{expectedForegroundExecutionId?}` | 打断当前 turn（turn/interrupt 的 v4 形态） |
   | compact | `{}` | 上下文压缩 |
   | editUserQuery | `{target, newText, attachments?, workspaceMode:"preserve"\|"rewind"}` | 编辑历史用户消息（服务端可回 disposition: rewind/fork/blocked） |
   | retryTurn / applyFileRewind / setAssistantFeedback | `{target…}` | 重试 / 文件回滚 / 点赞点踩 |
   | **sendQueuedNow / editQueueItem / reorderQueueItem / deleteQueueItem / setAutoDrain** | `{queueItemId…}` | **原生队列管理**（配合 sendText 的 heldQueueDisposition 与 autoDrain 策略） |
   | resolveInteraction | `{interactionId, answer…}` | 交互应答（与任务命令 respond_permission 并存的另一应答路径） |
4. **订阅 `subscribeConversationV4({workspacePath…, sessionId})`** → `{ack:{subscriptionId:"sub-<logEpoch>-N", mode:"snapshot", logEpoch, openTiming{…}}}`；取消 `unsubscribeConversationV4({…, subscriptionId})`。
5. **事件流 `onDynamicConversationFrame`（动态事件，listen ctx = 纯 workspace 定位，不含 sessionId）**。wire 帧结构（实测样例）：
   ```
   { wireVersion:3, kind:"complete", deliveryKind:"online",
     logicalFrameId, logicalFrameOrdinal, topic:"conversation/<sessionId>", subscriptionId,
     frame:{ topic, subscriptionId, sentAt, fromSeq, toSeq,
       payload:{ kind:"snapshot", snapshot:{…} } | { kind:"deltas", deltas:[…] } } }
   ```
   deltas 操作全集（web 端 zod + reducer 还原）：
   - `row.appended{row}` / `row.upserted{row}`（行对象按 rowId 幂等替换）
   - `row.removed{fromRowId}`（删除 ≥fromRowId 的行）
   - **`row.delta{rowId, path, append}`（真流式增量，按 path 追加）**：
     | path | 适用行 kind | 追加字段 |
     |---|---|---|
     | `text` | assistantText、reasoning | `row.text += append`（**assistant 文本增量 = 此通道**；reasoning 按需求丢弃） |
     | `inputText` | toolCall | 工具参数流 |
     | `output.text` | toolCall（有 output 时） | **命令输出流式追加路径** |
     | `summaryText` | subagent | 摘要流 |
   - `state.updated{patch}`：`{revision, usage:{contextWindow{usedTokens,maxTokens,cache{…},breakdown{…}}, cumulative{…}}, pendingInteractions?:[…], queue?, goal?, plan?, backgroundWorks?, subagents?, …}`（patch 即 snapshot 状态投影的部分更新）。
   行 kind 已确认：`assistantText`、`reasoning`、`toolCall`、`subagent`（userInput 类同构；未知 kind 建议透传忽略）。toolCall 行字段：`rowId, turnId, productTurnId, kind, toolCallId, toolName, status("inputStreaming"|…), inputText, input{解析后参数}, output?{text,…}`。

   **权限/交互的完整闭环**（含请求侧结构，补齐实测截断部分）：会话出现待审批交互时，`state.updated` 携带 `pendingInteractions:[{interactionId, kind:"permission"|"userInput", toolName?, autoResolution?}]`（sessions-index 通道的 session 快照同构：`pendingInteraction` 单数 + `pendingInteractionSummary{permissionCount, userInputCount}`）。应答命令：**`resolveInteraction{interactionId, answer:{optionId?, freeText?, action:"accept"|"decline"|"cancel"?, content?}}`**——`optionId` 即 §7.1 实测的 allowOnce/allowAlways/deny 选项 id；另有 `snoozeInteractionAutoResolution{interactionId}`。（任务命令通道的 `respond_permission{permissionRequestId, optionId, response}` 与此并存，实现时任选其一先行验证，推荐 resolveInteraction——它与事件流的 interactionId 同源。）

   **sessions-index / config 订阅**（workspace 级，subscribeSessionsIndexV4 / subscribeWorkspaceConfigV4）：topic `sessions-index/<workspaceId>` 与 config 通道，帧 ops `session.upserted/session.removed`、`config.updated`；session 快照字段：`sessionId, workspaceId, parentSessionId?, title, titleSource, phase, sessionEnded, hasBackgroundWork, pendingInteraction?, goalStatus?, lastAssistantPreview?, lastTerminalQuery?, createdAt`——**thread/list 可直接复用此通道维持实时性**（bootstrap 之外的增量来源）。
6. 错误码（实测/静态）：`fault.connection.{helloRequired, handshakeRequired, closed, invalidConnectionId, flowControlForbidden}`、`fault.command.clientMismatch`（clientId 不一致）、`proto.invalidPayload`（zod 详情）、`fault.subscription.*`。

**权限请求实测结构（2026-09-27，Write 工具触发）**——权限选项作为 toolCall 行流的一部分到达，options 原文：

```
{optionId:"allowOnce",   label:"Allow once",                 kind:"allowOnce",
 response:{decision:"allow", reason:"Approved once"}}
{optionId:"allowAlways", label:"Always allow in this project", kind:"allowAlways",
 response:{decision:"allow", permissionUpdates:[{behavior:"allow",
   rules:[{toolName:"Write", ruleContent:"<目标文件绝对路径>"}]}]}}
（另有 deny 选项，同构）
```

应答**优先 `resolveInteraction{interactionId, answer:{optionId}}`（实测闭环：accepted → pendingInteractions 清空 → 文件落地）**；任务命令 `respond_permission{permissionRequestId, optionId, response}`（response 原样回显）为并存路径。**wham 审批枚举映射就此确定**：`accept→allowOnce.response`、`acceptForSession→allowAlways.response`（含 permissionUpdates 规则）、`deny→deny.response`——与 doc 10 D1/D3 决策（映射手机 approvalPolicy、桥侧会话缓存模拟 acceptForSession）严丝合缝。

## 八、QR 链接与凭证

### 8.1 链接构造

```
https://zcode.z.ai/remote/{v3|v4}?sid=<device_sid>&hash=<pass_hash>&t=<ms>
  &mid=<deviceMid>&name=<deviceName>&app_version=<version>
```

- 版本门控：桌面 app 版本 ≥3.4.0 → v4 页面，否则 v3（`Wx()` semver 比较，`Bx="3.4.0"`）。
- 参数在手机端只做解析，`t` 仅要求是有限数字；**sid+hash 即全部凭证**。
- 手机端错误分支：链接参数缺失 → `invalid-mobile-connection`。

### 8.2 凭证生命周期

- 首次开启：`createPassword()`(24B base64url) → `createPassHash` → device_register → 持久化。
- 存储：`~/.zcode/v2/setting.json` 的 `webRemoteControlExternalRelayDevice.deviceSid`（明文）；`~/.zcode/v2/credentials.json` 的 `web-remote-control:external-relay:pass_hash`（`enc:v1:` Electron safeStorage/Keychain 加密）。
- 轮换：GUI"重置配对"（`ResetWebRemoteControlPairing`，reason 含 leaked-qr）→ 清凭证 → 重新 register（**旧 sid/hash 全部失效，桥需重新拿新链接**）。
- `AUTH_FAILED` 时 device 自动走一次重新注册。

### 8.3 桥获取凭证的三个选项

| 方案 | 说明 | 评价 |
|---|---|---|
| A. 用户粘贴 QR URL（推荐） | GUI 显示二维码/链接 → 配置进桥 → 桥解析 sid+hash | 零权限问题；重置配对后需更新；链接在桥配置里要当密文对待 |
| B. 读 setting.json + Keychain 解密 | sid 明文可读；passHash 用 "ZCode Safe Storage" Keychain 密钥按 Electron os_crypt 方式解 `enc:v1` | 全自动但触发钥匙串授权弹窗，且绑定 Electron 加密实现 |
| C. 抓 GUI 日志 | 已验证：日志（`~/.zcode/v2/logs/*.log`）有状态痕迹（waiting_terminal 等）但**不含**明文 URL | 不可行 |

### 8.4 第二入口（token 化，v4 页面同时支持）

URL 带 `remoteControlToken` 时走 HTTP 网关：`GET /api/remote-control/windows/bootstrap/{token}`、`POST .../workspace-bridge`（返回 `wsUrl`）、`POST .../mobile-view-state`、`POST /api/remote-control/platform/{token}`，另开 `wss://…/ws/remote-control/window/{token}`。这是给已登录 Web 账号体系的入口，桥用 sid/hash 直连入口即可，不需要 token 交换路径。

## 九、桥接入设计（zcode-remote serving agent）

### 9.1 模块定位

新增第三种 serving agent：`zcode-remote`（与 `sim`、原计划的自研 zcode ACP 并列）。数据流：

```
wham ⇄ 桥(zcode-remote agent) ⇄ wss://zcode.z.ai/ws(terminal) ⇄ 中继 ⇄ GUI device 腿 ⇄ host ⇄ app-server
```

### 9.2 wham ⇄ v4 映射（实测版）

| wham 方法/通知 | v4 侧 | 状态 |
|---|---|---|
| initialize | terminal 握手 + `helloConversationV4` + `initializeConversationV4` | ✅ 实测 |
| thread/list | bootstrap-response.workspaces/tasks + `workspace-list-updated` 推送（GUI 全部工作区/会话，含标题/未读/置顶） | ✅ 实测 |
| thread/start | `workspace-bridge-open`（workspaceKey=identity\|\|path）→ `createSession` envelope（provider/model/thought/mode 可指定） | ✅ 实测（test_rc 建会话 sess_9f2a…） |
| turn/start | `sendText` envelope（text + modelSelection + heldQueueDisposition） | ✅ 实测（GLM-5.3-Flash 真实调用，inputAccepted/startNow） |
| turn/interrupt | v4 命令 `stop`（任务命令 stop_generation 并存） | ✅ 实测 |
| turn/steer | 无原生 → 沿用 D2 决策：打断重发 | 设计决策 |
| 权限审批 | `resolveInteraction{interactionId, answer:{optionId}}`（interactionId 取自 pendingInteractions） | ✅ 实测闭环 |
| item/agentMessage/delta | `subscribeConversationV4` + `onDynamicConversationFrame` wire 帧（row.appended/upserted + state.updated 带 token usage） | ✅ 实测 |
| 历史/重放 | 订阅 `mode:"snapshot"` + fromSeq/toSeq 断线补齐（logEpoch 机制） | ✅ ack 实测，重放待桥实现时用 |
| fs/*、command/exec | file 通道只读方法 + agent 的 Bash/Write/Edit 工具（**terminal 通道除名**，§十一-2） | file.readdir 实测 ✓ |
| model/list、settings/update | `model-selection.getView`（实测返回 providers+preferredSelection）/ `setModel`/`setMode` | ✅ getView 实测 |
| /status 额度 | `usage-stats.getEntitlementSnapshot` 或沿用 doc 10 HTTP 额度端点 | D10 不变 |
| thread/name 等 | `zcode-task.renameTask` 等 15 方法 | 静态 |
| 会话关闭 | `zcode-session.closeSession{sessionId, expectedPersistence:"immediate"|"deferred"}` | ✅ 实测 |


### 9.3 wham 接口兼容性总表（v4 通路，2026-09-27 实测版）

**✅ 完全兼容（核心链路全通）**

- 连接生命周期 initialize：terminal 握手（mid=deviceMid 路由 + HMAC proof + 10s 心跳）→ `helloConversationV4` → `initializeConversationV4`(clientHello, protocolVersion=3)【实测】
- thread/list：bootstrap-response workspaces/tasks + `workspace-list-updated` 主动推送（GUI 全部项目/任务，含标题、状态、置顶、未读；data 帧实测 99KB）【实测】
- thread/start：`workspace-bridge-open`（workspaceKey=identity‖path 终端派生）+ `createSession` envelope（config 可指定 provider/model/thought/mode）【实测：test_rc 建会话】
- turn/start 文本：`sendText` envelope → `inputAccepted`/`startNow`【实测：GLM-5.3-Flash 真实调用】
- 图片附件：`zcode-agent.sendPrompt({content, attachments:[{kind:"image", mimeType, dataBase64}]})` 内联 base64——**v4 链路实测 ✓（真图辨色"红色"）**，无需 attachment*V4 分块上传
- turn/interrupt：v4 命令 `stop`（可选 expectedForegroundExecutionId）+ 任务命令 `stop_generation`【schema+实测(同源层)】
- 增量流 item/agentMessage/delta、item/started|completed：`onDynamicConversationFrame` wireV3 帧（row.appended/upserted，带 turnId/productTurnId；toolCall 的 inputText 流式可见）【实测】
- 命令执行项 CommandExecution：toolCall 行（toolName/input/status 流）【实测：Write 工具全流程】
- 权限审批：`resolveInteraction` 闭环【实测】（pendingInteractions 全量结构 + allowOnce/allowAlways(含 addRules)/deny 完整 options + 应答 → 文件落地）
- compact：v4 命令 `compact{}` + `compactSession`【host schema + doc 10 app-server 实测】
- token 用量：`state.updated` patch.usage（contextWindow 分项 + 缓存命中率 + breakdown，比 ACP 视图更细）【实测】
- 历史与断线重放：订阅 `mode:"snapshot"` + `base{logEpoch,seq}` 断点 + 行级 fromSeq/toSeq（web-remote-replayable 的设计目标）；行含 turnId 天然支持按 turn 分组【ack 实测；行结构实测】
- 并发多会话：host 多任务原生（GUI 同一视图），单连接按 sessionId 多订阅【架构+实测订阅】
- model/list：`model-selection.getView`（providers / preferredSelection / effectiveSelection）【实测】
- settings/update：`setMode` / `setModel` / `setThoughtLevel`【host 目录 + doc 10 实测】
- thread/name/set：`zcode-task.renameTask`【静态（GUI 功能同源）】
- /status 额度：`usage-stats.getEntitlementSnapshot` 通道 + doc 10 的 HTTP 额度端点（实测），D10 决策（按需+1min 缓存）沿用
- fs 读 / 命令执行：file / terminal 服务通道（`terminalService.onDynamicData` 为流式输出）【通道连通实测】
- remoteControl/*：由 terminal 通道本身承担，桥自实现面比 ACP 路线显著缩小【架构】
- 账号与 provider：**ACP 路线的 OAuth 无头物化问题在 v4 不存在**——桥直接使用 GUI 已登录的 `account:zai-individual-coding-plan`（实测 createSession config.provider 直用）【实测】

- **fork**：`forkAssistant`（CAS：baseRevision+baseLogEpoch，见 §7.1 命令表）——纯聊天会话按行分叉，新会话历史完整【实测闭环】
- queue/*：v4 原生命令族 `sendQueuedNow/editQueueItem/reorderQueueItem/deleteQueueItem/setAutoDrain` + sendText 的 heldQueueDisposition【schema 齐；排队时机实测未复现，实现期对齐】
- sessions-index/config 订阅（thread/list 实时增量来源）【实测 ✓ initial snapshot 帧】

**🟡 部分兼容（4 项）**

- turn/steer：无原生转向；队列族提供"排队下一轮"语义（非 mid-turn 改道）→ 沿用 D2 决策打断重发
- stdout 实时滚屏：agent 命令输出在 toolCall 行（output.text 有流式追加路径，但 flash 场景主力随 result 一次性给出）→ 完成时补发 outputDelta
- fs 写/删/搜索：file 通道读侧实测 ✓；写删方法目录不全，实现期按需探测（兜底：引导 agent 用 Write/Bash 工具）
- plan 模式回读：createSession `config.mode` 可传入（schema 支持），但设置回读不一致问题沿用 doc 10（不落 settings.mode.current）

**❌ 无法兼容（1 项）**

- thread/inject_items：无向历史注入消息的接口（`editUserQuery` 是改写历史，非注入）

（原 ACP 清单中的"OAuth account provider 无头物化 ❌"在 v4 路线已消除，见 ✅ 最后一条。）

### 9.4 同步语义（与 ACP 路线的本质差异）

- 会话本体、权限判定、文件系统、进程全部在 GUI 的 host/app-server 里；桥和官方手机页是平级终端。
- GUI 上的人工操作（切换会话、改模型、批准权限）会通过 task/workspace-list-updated 与事件流反映到桥 → 反向同步同样成立。
- 代价：**GUI 必须运行且开启 Web 远程控制**；GUI 重置配对/退出会断桥。

### 9.5 实现清单（建议 section 划分）

1. relay-terminal 客户端（握手/心跳/重连/suspend，§2 规格；**mid 必须取链接 deviceMid**）。
2. payload 层 + workspace bridge 状态机（§3-4；响应用 requestId 匹配，不依赖 zcode_type）。
3. rpc-frame 编解码 + 重放缓冲 + 流控（§5；probe-v4.mjs 已有验证过的实现）。
4. 裸 VQL Channel RPC codec + 请求/订阅管理（§6）。
5. v4 conversation 层（hello/clientHello/命令信封/订阅事件流，§7.1）。
6. zcode-remote AgentApp 适配器 + wham 映射（§9.2，全部条目已实测或有 schema）。
7. 凭证管理（QR URL 解析、AUTH_FAILED→提示重贴）。
8. 回归：mock 夹具单测 + 真实凭证端到端（probe-v4.mjs / probe-verify.mjs 即回归脚本）。

## 十、风险与开放问题（全部关闭/定性）

1. ~~双终端并存~~：**用户拍板不考虑并存**。**已实测互斥实锤**：第二个 terminal（同 sid+mid）接入瞬间，先连者收到 `KICKED`；若先连者自动重连则反向踢回——双方拉锯互踢（vrelay-⑥，判定逻辑修正后确认）。
2. ~~respond_permission 映射待实测~~：**已实测关闭**（§7.1：allowOnce/allowAlways(+permissionUpdates 规则)/deny 三类 option，response 原样回显；wham accept/acceptForSession/deny 一一对应）。
3. ~~新建会话调用链待实测~~：**已实测关闭**（§7.1：helloConversationV4 → clientHello → createSession envelope{commandId,issuedAt,clientId}，缺一步都会得到明确 fault.* 错误码）。
4. **协议漂移**（保留风险）：v3→v4 已迭代一次；`protocolVersion:3` 是 v4 页面内的 conversation 协议版本（独立演进）。ZCode.app 升级后应跑 `probe-v4.mjs` 回归（探针保留在逆向产物目录，可重复执行）。
5. **中继可用性依赖**（保留）：云中继故障 = 远控不可用（官方手机页同样受制）。
6. **凭证敏感**（保留）：QR URL = 密码；桥配置需 0600 + 日志脱敏；GUI"重置配对"轮换后桥提示重贴（AUTH_FAILED → 引导更新链接）。

## 十一、操作红线（实测事故记录，桥实现绝对不能做）

来自 2026-09-27 验证轮的三次 GUI 故障（两次会话内容空白 + 一次应用退出，日志实锤）：

1. **绝对不能硬杀桥进程（SIGKILL / 进程组连杀）**。terminal 客户端异常断开（close 帧未发出）会触发 host 的 attachment 清理链，实测日志：`failed to forward attachment connection flow state{"state":"closed"}` → `ZCode agent process exited` → **GUI 该工作区会话内容整体空白**；更严重时可连锁 host Utility 进程崩溃（`child-process-gone type:Utility`）→ 窗口关闭 → 整个 app 退出（`all-windows-closed-after-preparation`，17:41 与 18:41 两次实测）。桥的规范：
   - 退出路径必须优雅：`closeSession → unsubscribe → （不再发新命令）→ ws.close() 等关闭握手完成（≥2s）→ 进程退出`；
   - launchd/守护必须用 SIGTERM 触发上述优雅路径，严禁 SIGKILL 兜底（KillMode=process + ExitTimeout 足够长）；开发期严禁在探针/桥运行中用进程组取消。
2. **绝对不能越过 capabilities 协商调用声明不支持的能力**。server hello 对 web 客户端声明 `localTerminal:false, nativeDialogs:false`——**terminal.create/write 等 terminal 通道调用是官方手机页不使用的路径**（验证轮调用后发生应用卡死/退出，虽无法完全定罪——同时发生了硬杀——但已从桥的设计中除名）。桥的命令执行一律走 agent 的 Bash 工具（toolCall 行，doc 10 已实测），文件操作走 agent 的 Read/Write/Edit 工具或 file 通道的只读方法。
3. **不要在 GUI 正常使用期间制造高频连接抖动**。terminal 反复连断会让 device 腿进入 stale-recovery 重连循环（GUI 日志噪音 + 远程控制状态闪烁）；桥应保持单条长连接 + 心跳，断线用指数退避重连。
4. （探针工程教训）**后台探针输出重定向到文件时 stdout 是块缓冲**——进程被杀时日志丢失，排查时不能依赖"日志为空=没执行"。

## 附一：实测记录（2026-09-27，真实 sid/hash + GUI 在线）

**分层验证时间线**（详见 `probe-*.log`）：

| 层 | 验证内容 | 结果 |
|---|---|---|
| 中继 | 随机 sid 收 auth_challenge（432ms/671ms）；真实凭证 matched（~1s）；wrong mid → waiting + 17s KICKED | ✅ |
| 中继 | `pair_status_query` 心跳（waiting 期也要发）+ pair_status_ack | ✅ |
| payload | bootstrap-request → workspaces/tasks（data 帧实测 99KB） | ✅ |
| payload | workspace-bridge-open（bridgeSessionId 合法即可 + 派生 workspaceKey）→ ready + Initialize 帧 | ✅ |
| rpc-frame | 分片/CRC32/ack（device 对未确认帧 ~8s 重放） | ✅ |
| Channel RPC | 裸 VQL；`zcode-agent.listSessions`（201）、`model-selection.getView`（真实 provider 清单） | ✅ |
| conversation | hello/serverHello（connectionId host-rpc-*）→ clientHello（strict） | ✅ |
| conversation | createSession envelope → `sess_…`；subscribe → ack{subscriptionId, mode:"snapshot", logEpoch} | ✅ |
| conversation | sendText（GLM-5.3-Flash）→ inputAccepted/startNow；closeSession（expectedPersistence:"immediate"） | ✅ |
| 事件流 | onDynamicConversationFrame（ctx=workspace）：wireV3 帧、row.appended/upserted（Write toolCall 流）、state.updated（token usage）、**权限 options（allowOnce/allowAlways/deny + response）** | ✅ |
| GUI 同步 | test_rc 工作区新建会话即时出现在 GUI 任务列表（workspace-list-updated 推送） | ✅ |

**隔离实验矩阵**（定位 mid 路由与帧上限误判）：V1 参数对齐→matched；V2 version 带后缀→matched；V3 加心跳→matched；V4 自造 mid→**waiting 不配对**；V5 mid=deviceMid→matched。E1-E3 逐一排除 requestId/version/workspaceKey。

**测试副作用**：`reference/test_rc` 累计留下约 10 个探针会话（初轮 + 验证轮 vdelta/vcmds×2/vperm/vattach/vfork），GUI 中可手动关闭；vperm 的 verify-perm.txt 已清理。

## 附二：测试夹具（桥开发用）

- `mock-relay.mjs`：本地中继（device/terminal 配对 + data 透传 + KICKED 语义）。
- `mock-device.mjs`：本地 device 腿 + ChannelServer + v4 conversation mock（createSession/sendText/订阅/事件推流）。
- `probe-v4.mjs`：terminal 侧 5 层协议完整参考实现（`RELAY_URL` 可指向 mock 或真实中继；场景 pair/bootstrap/rpc/conv/perm）。
- `probe-verify.mjs`：验证轮探针（八场景：权限应答闭环、fork CAS、内联附件、错误码矩阵、双终端互踢；同样支持 RELAY_URL）。


## 附三：证据等级审计 → 全量实测结果（2026-09-27 验证轮收尾）

验证轮（probe-verify.mjs，八场景 vdelta/vfrag/vcmds/vperm/vattach/vfork/vsvc/vidx/vrelay）全部完成，原 B/C 类逐项落定：

**原 B 类 4 个"首日抽验"项 → 全部实测通过**：
- ① `row.delta` 实测存在（path:"text" 追加 assistantText.text）；**但 GLM-5.3-Flash 实际主力是 `row.upserted` 全量替换**（一次 200 字回复：4 次 upsert + 1 次 delta）——桥的 delta 映射按"新文本−旧文本"差分实现，两路都兼容。行 kind 实测全集：`turnHeader / userInput / assistantText / toolCall`（reasoning/subagent 未出现于 flash-low 场景）。
- ② rpc-frame 多分片：**发送侧实测 ✓**（516B 信封自动 2 分片，device 正确处理并 ack）；接收侧 device 发送方向**单帧可达 6KB+**（1024 信封限制只约束 terminal→device 方向），桥接收端须兼容大单帧与分片两种。
- ③ 命令族实测：`stop ✓`（accepted，stop 后会话可续新 turn）、`compact ✓`（accepted）、**`forkAssistant ✓`——需 CAS 参数 `baseRevision`（state.updated 的 revision）+ `baseLogEpoch`（subscriptionId 去掉 `sub-` 前缀与 `-N` 后缀）**，纯聊天会话分叉成功且新会话历史完整（readSession 5 条消息）。queue 排队未复现（turn 边界时机，`sendQueuedNow` 等 5 个队列命令 schema 已还原，实现期对齐）。
- ④ 内联附件实测 ✓：`zcode-agent.sendPrompt({content, attachments:[{kind:"image", mimeType, dataBase64}]})`（注意通道是 zcode-agent 非 zcode-session）→ 真图辨色回答"红色"。

**其他 B 类落定**：
- 权限请求侧结构实测 ✓（完整 `pendingInteractions:[{interactionId:"perm_<uuid>", kind:"permission", anchorRowId, payload:{toolCallId, toolName, summary, detail(工具参数原文), freeText, fullAccessOption, options[allowOnce/allowAlways(type:addRules)/deny(完整拒绝话术)]}}]`）；应答 `resolveInteraction{interactionId, answer:{optionId:"allowOnce"}}` → accepted → 列表清空 → **文件真实落地**。
- 错误码实测：`AUTH_FAILED ✓`（错误 proof）、`WRONG_PARAM ✓`（缺 device_sid）；假 device 注册流 ✓（`device_register_init` 任意客户端可注册新 sid——安全面记录：注册无鉴权，凭证安全完全依赖 sid+hash 保密）。
- 服务通道：`file.readdir ✓`、`usage-stats.getEntitlementSnapshot ✓`（返回 not_configured——GUI 未配置该数据源，**桥的额度继续走 doc 10 HTTP 端点，D10 不变**）；`zcode-task.listGroupedTaskViewStructure` 通道连通但参数 schema 需实现期对齐（TypeError=参数不完整）。
- sessions-index 订阅实测 ✓（ack + `deliveryKind:"initial"` 全量 snapshot 帧，topic `sessions-index/<workspacePath>`）。
- 超限 rpc-frame 信封（~1.6KB）发送后 device **静默容忍**（无 ack/无降级/无断连；精确行为实现期对齐）。
- 未验证保留：HTTP token 入口（桥不使用）、饱和流控水位、identity 分支 workspaceKey（无 remote 工作区环境）、enc:v1 Keychain 解密（避免钥匙串弹窗）、手机端 suspend/recover 生命周期、INTERNAL 错误码。

**原 C 类全部落定/修正**：
- bridgeSessionId 风格：**实测无关**（`probe-<ts>` 风格 + 正确 workspaceKey → ready ✓）。
- "matched 后延迟 2s"：**实测推翻**（立即发 631ms 成功），正文已修正。
- 双终端互斥：**实锤**（后连踢先连、拉锯互踢），见 §10-1。
- "relay 丢弃未完成配对 data"：随延迟项一并失效（不再作为依据）。

**v4 通路整体结论**：核心链路与全部桥所需接口均有真实证据；桥实现不再存在协议未知数。三次 GUI 故障的教训固化为 §11 操作红线。
