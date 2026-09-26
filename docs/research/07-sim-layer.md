# 07 · 模拟层：桥扮演 codex 被控端（固定响应，不接 LLM）

日期：2026-09-25 · 状态：✅ 已接真实 wham 后端并验证

> **已于正式化移除（S05）**：本文描述的 `src/sim/*` 入口（`SimWhamServer` / `src/sim/cli.ts`）
> 与 `npm run sim` 脚本在正式化后已删除；模拟层迁入 `src/agents/sim/*`，由 daemon 经注册表
> 创建实例、`cgrcb serving-agent sim` 管理。下文保留研究阶段记录（入口名/命令已失效）。
> 正式化架构见 [08-formalization.md](08-formalization.md)。

## 定位

```
手机 ChatGPT App ── wham 后端(chatgpt.com) ──WSS──▶ SimWhamServer（本仓库 src/sim/）
                                                    └─ 对手机/后端请求返回固定/程序生成响应
```

模拟层完全替代 codex daemon：不装 codex、不调 LLM，所有 JSON-RPC 方法返回
蓝本取自真实抓包（`catalog*.json`，见 docs/06）的固定/模拟数据。
它是后续 ZCode 驱动层的直接骨架（方法分发 + 信封层不变，只换 handler 实现）。

## 运行

> 已于正式化移除：`npm run sim` / `src/sim/cli.ts` 不再存在。现用
> `cgrcb serving-agent sim enable`（daemon 在线时自动 init + 打印配对码）。

```bash
npm run sim                    # enroll → WSS → 打印配对码 → 轮询 claim → 持续服务
npm run sim -- --no-pair       # 已配对过，直接服务
npm run sim -- --name "名字"   # 手机上显示的服务器名（默认 <主机名> (bridge-sim)）
```

- 认证：复用 bridge 自己的 codex-home（`npm run auth -- login`），绝不读 ~/.codex。
- 帧日志：`.agent-work/tmp/sim/frames-<ts>.jsonl`（双向）。

## 实现结构

| 文件 | 职责 |
|---|---|
| `src/wham/rest.ts` | curl 子进程 REST（CF 拦 undici 指纹，docs/05） |
| `src/wham/client.ts` | enroll/refresh/pair/pairStatus（baseUrl 语义=origin；WS URL 派生） |
| `src/sim/ids.ts` | UUIDv7（thread/turn id）、`msg_` 前缀 item id |
| `src/sim/data.ts` | 固定数据蓝本：模型/技能/配置/两个预置会话/Thread·Item·Turn 类型 |
| `src/sim/appServer.ts` | SimApp：28 方法分发 + turn 事件流模拟 + 虚拟 FS + 队列/steer/interrupt |
| `src/sim/server.ts` | SimWhamServer：enroll 生命周期、WSS 拨出、信封层、通知 fan-out、重连 |
| `src/sim/cli.ts` | CLI：登录检查 → enroll → WSS → 配对码 → 轮询 claim |

## 协议要点（信封层）

- 拨出 `wss://chatgpt.com/backend-api/wham/remote/control/server`，握手头对齐
  websocket.rs：`x-codex-server-id` / `x-codex-name`(base64) / `x-codex-protocol-version=3` /
  `authorization: Bearer <remote_control_token>`（enroll 发放，非账号 token）/
  `x-codex-installation-id`。
- 出站 ServerEnvelope：`server_message`/`pong`，seq_id 按 (client_id, stream_id) 从 1 递增；
  codex 从不回 Ack（protocol.rs `ServerEvent::Ack` 是 dead_code）——模拟层同样不回。
- 入站 ClientEnvelope：`client_message`（JSON-RPC，camelCase 参数）、
  `client_message_chunk`（base64 分段重组）、`ack`、`ping`（→回 pong，status=
  有活动 turn 时 active）、`client_closed`（清 stream 状态）。
- WS 协议层每 10s ping 后端；45s 无 pong 主动断开重连；断线延迟重连，
  remote_control_token 临期（<60s）则先重新 enroll。
- 通知 fan-out：发给全部已 initialize 的 (client, stream)，跳过
  `capabilities.optOutNotificationMethods` 与 `thread/unsubscribe` 的线程。
- 响应/通知 message 无 `jsonrpc` 字段（codex untagged OutgoingMessage）；
  通知带 `emittedAtMs`。
- REST 路径已含 `/backend-api` 前缀 → baseUrl 传 origin（兼容误传 codex 风格 base）。
- pair 与 pair/status 都用 remote_control_token 做 Bearer；pair/status 只传
  恰好一个 code（后端 400 "Provide exactly one remote-control pairing code"）。
- enroll 的 server_id 按 installation_id 稳定复用（重启不变，配对关系保持）。

## 方法与模拟行为

全部 28 个真实观测方法已实现（未实现的方法回 -32601）。要点：

- `initialize` → `{userAgent, codexHome, platformFamily, platformOs}`；记录
  clientInfo/optOut；随后广播 `account/updated`、`remoteControl/status/changed`。
- `thread/list` → 固定列表（2 个预置会话：一个带 1 轮完整历史、一个空白），
  分页形状 `{data, nextCursor, backwardsCursor}`。
- `thread/start` → 创建线程（UUIDv7），广播 `thread/started`。
- `thread/resume` → 完整 resume 形状（settings/sandbox/collaborationMode/cursor 等），
  支持覆盖 cwd。
- `turn/start` → 立即回 `{turn:{status:"inProgress"}}`，随后按真实时序广播通知：
  `thread/status/changed(active)` → `turn/started` → `item/started|completed(userMessage)`
  → `item/started(agentMessage)` → `item/agentMessage/delta ×N`（固定回复逐段流式，
  回复含用户消息回显）→ `item/completed(agentMessage)` → `thread/tokenUsage/updated`
  → `thread/goal/cleared` → `thread/status/changed(idle)` → `turn/completed(completed)`。
- `turn/interrupt` → 取消计时器，`turn/completed(status:"interrupted")`。
- `turn/steer` → 回 `{turnId}`；steer 文本在当前 turn 内追加 userMessage+agentMessage。
- `thread/queue/add|list|delete` → 内存队列；turn 结束自动消费（`thread/queue/changed`）。
- `thread/turns/list` / `thread/items/list` → 全量历史（分页形状，cursor=null）。
- `fs/readDirectory|getMetadata` → 真实本地 FS 只读 + 内存覆盖层合并；
  `fs/createDirectory`、`process/spawn(mkdir)` → 只写覆盖层（不落盘、不执行命令），
  手机新建任务目录流程可完整走通。
- `process/spawn` → 回 `{}` + `process/exited`（exitCode 0，回显 processHandle）。
- `config/read|batchWrite`、`configRequirements/read`、`model/list`、
  `collaborationMode/list`、`skills/list`、`plugin/installed`、`threadSection/list`、
  `thread/goal/get`、`thread/settings/update`、`thread/compact/start`、
  `thread/unsubscribe`、`attestation/generate` → 固定/形状对齐响应。

## 测试

- `test/sim.test.ts`（3 个回环测试）：SimWhamServer ↔ MockWhamServer（扮演 wham 后端
  + 手机端），覆盖 initialize/thread/list/thread/start/turn 事件流（delta 拼接=完整
  文本、seq 严格递增）、interrupt/queue 自动消费、虚拟 FS + process/spawn 覆盖层。
- 全套 24 测试通过；`tsc --noEmit` 干净。

## 真实后端验证（2026-09-25）

- enroll 200（curl）：server_id=`srv_e_6ab6d2580c64…`（多进程重启保持不变）。
- WSS 隧道建立；后端 ping ↔ sim pong 保活正常。
- slingshot 后端客户端（`__slingshot_backend_initialize__`）下发 `initialize`，
  模拟层应答被后端接受（ack 收到）。
- 手机配对成功（配对绑定 installation_id，进程重启后自动重连，无需重新配对）。

## 首轮手机实测暴露的问题与修复（2026-09-25 晚）

手机配对后的实测发现四个问题，全部修复并有回归测试（25 项全绿）：

1. **新建任务报「无法加载任务设置」**：手机设置页对 `config/read` 结果做严格解码，
   真实响应是 `{config: 104 键, origins: {...}}` 双顶层键；模拟层只回了精简 config。
   → 修复：完整蓝本嵌入 `src/sim/blueprint-config-read.json`（真实抓包原样）。
2. **用户消息重复渲染（2 个 hi）**：真实 `turn/completed` 的 `turn.items` 只带
   agentMessage 摘要项；模拟层带了 userMessage+agentMessage，手机 upsert 后重复。
   → 修复：turn/completed items 只含 agentMessage。
3. **约 20 秒后消息全部消失**：手机重进会话时不直接拉历史，而是依赖
   `thread/resume` 返回的 `turnsBackwardsCursor`/`itemsBackwardsCursor`（非空才调
   turns/items list）；模拟层返回 null 被当成"无历史"。
   → 修复：resume 与 turns/items list 都返回 codex 同形状的非空 cursor。
4. **进程重启后旧会话 "thread not found"**：手机缓存 thread id，模拟层线程状态
   仅在内存，重启后 id 全变。
   → 修复：线程状态原子持久化到 `<codexHome>/sim-state.json`，启动时恢复。

另确认：手机新建任务靠 `process/spawn` 跑 mkdir 脚本并**解析 stdout 得到任务目录**——
模拟层识别该脚本模式（`Documents/Codex` + `base="<名>"`），在覆盖层创建目录并回显路径。
手机每 ~30s 的 process/spawn 是 git workspace-diff 快照，与任务无关。

5. **历史消息顺序颠倒**：手机 `thread/items/list` 带 `sortDirection:"desc"`（真实
   codex 返回按时间倒序、最新在前），手机按该契约翻转渲染；模拟层返回了正序，
   导致 [用户消息, 回复] 显示成 [回复, 用户消息]。
   → 修复：items/list 尊重 sortDirection（默认 desc），与 turns/list 一致。

## 二轮手机实测：用户消息双渲染的第二条路径（2026-09-25 深夜，正式化后）

现象：配对成功后在「模拟会话：桥接链路验证」发 "hi"，实时视图出现 2 个 hi，
手机自动刷新（thread/items/list 全量重建）后恢复 1 个。持久层自始至终只有 1 份
（state.json 仅 1 条 userMessage），纯实时渲染路径问题。

根因（区别于上文问题 2 的 turn/completed 路径）：模拟层在 `turn/start` 派发内
**同步**发射 `thread/status/changed`/`turn/started`/userMessage 的
`item/started`/`item/completed`，而隧道把 JSON-RPC 响应写在 handleRequest 之后——
通知先于响应上线。真实 codex（catalog3 winnerTurn 抓包）中响应先回，userMessage
item 事件比 `turn/started` 晚 ~620ms；手机依赖该次序把本地回显（键 =
clientUserMessageId）与服务器 item（item.clientId 对账）合并，顺序颠倒即双渲染。

→ 修复：`beginSimTurn` 的通知序列推迟一个宏任务（setTimeout 0，微任务不可保证）
发射，状态写入保持同步；`turn/started` 显式带空 items（真实形状，userMessage
只经 item 事件下发）。回归测试两道：应用层「turn/start 派发期间零通知」+
隧道线上时序「响应信封先于全部 turn 通知」（mockServer 增 receivedEnvelopeLog）。

## 对齐 codex 线程生命周期（源码实证）

codex 中不存在"零 turn 却长期列出的线程"（`thread/list` 只读磁盘 rollout；
`thread/start` 仅在内存 stage pending metadata，无 rollout 的线程 shutdown 时被
丢弃，live_writer.rs:192）。据此调整模拟层：

- 预置会话只保留带历史的一个；不再预置空白会话。
- `thread/list` 过滤 ephemeral 线程与零 turn 线程。
- `thread/start {ephemeral:true}`（手机"起名线程"，threadSource:"thread_title"）
  仅存内存：不落盘、不进列表；跑过 turn 也不进。
- 持久化快照排除 ephemeral；加载时丢弃零 turn 线程（等价 shutdown 清理）。
- 起名线程的 turn 回复特殊化：从输入的 `User prompt:` 段提取用户首条消息，
  生成 ≤36 字符单行标题（真实 codex 由 LLM 生成，手机用作任务名）。

## 已知边界（后续接入真实驱动时处理）

- 出站不做分片（真实观测 11.4KB 单帧直发被接受；模拟回复远小于此）。
- 未实现出站重传（未 ack 的 server_message 不缓存重发；codex 侧有 outbound_buffer）。
- `subscribe_cursor` 未使用（重连后从头开始，不回放错过的通知）。
- attestation 由手机端对 codex 的请求改为可选——模拟层收到即回模拟 token。
