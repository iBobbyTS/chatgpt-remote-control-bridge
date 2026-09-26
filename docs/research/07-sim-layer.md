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

## 工作文件夹选择：真实流程、默认目录机制与「加载失败」根因（2026-09-25 深夜二）

原始抓包（`.agent-work/tmp/wham-probe/real-*.jsonl`，双向帧）完整记录了一次
真实的手动选目录流程（19:22:52–19:23:08Z，选中 `~/AUAV`）：

1. `process/spawn` `/bin/sh -lc 'cd "$HOME" && pwd -P'`（cwd `/`）→ 手机靠
   **stdout** 拿 HOME 物理路径（真实应答 `/Users/ibobby\n`，~15ms）。
2. `fs/getMetadata {path}` → `{isDirectory,isFile,isSymlink,createdAtMs,modifiedAtMs}`；
   `fs/readDirectory {path}` → `{entries:[{fileName,isDirectory,isFile}]}`（含点文件）。
3. 选中目录后再来一轮 getMetadata+readDirectory，随后 `process/spawn` git 分支
   探测脚本（`CODEX_DRAFT_OUTPUT_*`，draft/worktree 分支选择用）——**非阻塞**：
   真实应答即 exit 128 + `fatal: not a git repository …` stderr，手机照常继续。
4. `thread/start {cwd:<选中目录>, threadSource:"user"}`（+ 同 cwd 的 ephemeral
   起名线程）。

**默认文件夹的决定机制**（手机端逻辑，全部在远端脚本内计算）：不手动选目录时，
手机直接下发 mkdir 脚本，路径 = `$HOME/Documents/Codex/<远端 date +%Y-%m-%d>/<任务名 slug>`
（slug 由任务名生成，重名加 `-N` 后缀，唯一性循环上限 1000），以 stdout 路径作
thread/start 的 cwd——服务端没有任何「默认目录」接口。模拟层 `emulateTaskDirMkdir`
已按此模拟（覆盖层，不落盘）。

「远程文件夹加载失败」根因：模拟层 `processSpawn` 对未识别脚本一律回
**空 stdout / exit 0**——第 1 步 `pwd -P` 拿到空路径，手机选择器直接失败中止，
连 fs/* 请求都不发（当晚 daemon 日志：122 次 spawn 全 ✓ 但零 fs 调用）。

→ 修复（2026-09-25 深夜二）：`processSpawn` 新增两个识别分支——
`cd "$HOME" && pwd -P` → stdout=realpath(HOME)；`CODEX_DRAFT_OUTPUT_CURRENT`
脚本 → 按真实「非 git 目录」形状（exit 128 + fatal stderr；git 仓库目录同样
按此应答，draft 分支列表不可用，不影响选目录）。另对未识别的非 diff 脚本留
日志（此前日志只记方法名不记参数，真机排障全靠猜）。回归测试一道（picker 全
链路形状断言，stash 可证伪）。fs/getMetadata/readDirectory 形状经比对已一致，未改。

选择器入口修通后暴露第二层问题：目录列表报「无法解码Codex响应」，仅 `/`
能显示（点 2 次上级才成功）。根因：`fsGetMetadata` 直接返回 Node stat 的
`birthtimeMs/mtimeMs`——APFS 纳秒精度带**小数毫秒**（如
`1747760284363.8718`）；真实 codex（Rust）返回**整毫秒**，手机 Swift 按整数
解码，遇到小数点即失败。`/` 的时间戳恰为整秒（…5000）所以唯一能解码。
→ 修复（2026-09-25 深夜三）：两字段 `Math.round()` 取整；picker 回归测试加
整毫秒断言（$HOME 的 stat 即小数毫秒，本机可证伪）。

### 新线程发消息报「无法解码Codex响应」（2026-09-25 深夜四）

文件夹与整毫秒修通后，用户新建线程发普通消息必报「无法解码Codex响应」。
日志特征：发送链路停在 `config/read → configRequirements/read →
collaborationMode/list → (thread/start) → process/spawn` 之后，`turn/start`
从未出现；且隧道日志**零错误行**（`✗` 只记到达后失败的方法）——即手机在
发出 turn/start 之前就放弃了。

根因：真实 codex 的 `thread/start` 响应有 **14 个顶层键**（抓包
2026-09-25T18:38:02Z：thread + model/modelProvider/serviceTier/
disabledPluginIds/cwd/runtimeWorkspaceRoots/instructionSources/approvalPolicy/
approvalsReviewer/sandbox/activePermissionProfile/reasoningEffort/
multiAgentMode），模拟层只回 `{thread}`。手机 Swift 把这些会话上下文当必填
字段，解码失败即中止发送。旧流程（打开预置线程）走 `thread/resume`，其响应
本就带全键，所以此前从未暴露——`thread/start` 是发消息链路里唯一没被真机
验证过形状的方法。

→ 修复：抽 `threadContext()` 共用构造器（`thread/resume` 原有键集为蓝本），
`thread/start` 返回全套上下文；回归测试断言响应键集与真实抓包一致（14 键
deepEqual + sandbox/approvalPolicy 抽查），stash 证伪通过。

## 特殊指令：help / test steer / test queue（2026-09-25 深夜五）

供真机验证 steer / queue 链路的辅助指令（trim + 大小写不敏感完全匹配，
`specialCommandOf()`）：

- `help` → 帮助文本（buildReply 分支，单条 agentMessage）。
- `test steer` / `test queue` → 脚本化 turn（`runScriptedTurn`）：3 条
  agentMessage，相邻两条之间各执行一次模拟命令 **wait 15 seconds**——
  真实等待 `commandWaitMs`（默认 15000ms），纯 setTimeout 不经 shell，但按
  真实 `commandExecution` 条目形状（抓包 2026-09-25T19:21:34Z）下发
  item/started → outputDelta → item/completed（exitCode 0、durationMs 实测
  值），手机端按普通命令调用渲染。
- 每次等待结束后**先处理等待期间到达的 steer 再发下一条消息**：对齐真实
  codex（steered userMessage 在当前命令完成后出现在同一 turn 内，抓包
  19:21:32 steer → 19:21:35 userMessage 插入）。queue 消息走既有
  `thread/queue/add` → `consumeQueue` 自动接跑，无需新逻辑。
- 回归测试断言完整条目顺序（userMessage → msg1 → wait → steer 注入+回复
  → msg2 → wait → msg3）、2 条命令条目的 exitCode/durationMs，以及
  queue 排队消息在 turn/completed 后自动开跑；stash 证伪通过。

### turn 结束后的 steer：对齐 codex 报错语义（2026-09-25 深夜六）

核对 vendored 源码 `app-server/src/request_processors/turn_processor.rs`
`turn_steer_inner`：无活动 turn 的 steer（NoActiveTurn/NotIdle 等）返回
`invalid_request(-32600) "no active turn to steer"`，**并不开新 turn**。
模拟层原先对迟到 steer 冷启动新 turn，已对齐为同码同文案报错（其余分支
如 expectedTurnId 校验不在范围）。回归测试断言错误封包 + 无 turn/started +
turns 数不变，stash 证伪通过。

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

## 对齐 codex 可达功能（goal/compact/plan/status/side/branch/skill）（2026-09-25）

本节记录模拟层对 codex app-server 7 族方法的形状对齐与验证钩子。所有形状出处以
vendored 源码 `reference/codex/codex-rs` 为准。

### A. goal（thread/goal/set|get|clear）

- 形状：`ThreadGoalStatus`/`ThreadGoal` v2/thread.rs:800-840（Unix 秒）；set 参数
  单层 objective + 缺省 status + **双层** tokenBudget（v2/thread.rs:847-871）；get
  `{goal|null}`（:873）；clear `{cleared}`（:887）。通知 thread/goal/updated
  `{threadId, turnId:string|null, goal}`（:2008）、thread/goal/cleared `{threadId}`（:2017）。
- 钩子语义：set 后持久化；**每个 turn 结束清除 goal**（对齐抓包真实会话每轮发
  cleared）；resume **响应先行**，随后以**宏任务**补发快照（有→updated、无→cleared，
  对齐 thread_processor.rs:4181-4187 `emit_resume_goal_snapshot`）。禁用 emitSoon
  微任务（appServer.ts:674 记录的响应先行陷阱）。
- 真机复测：goal 面板设置 objective+budget → 发一条消息 → 应收到 thread/goal/cleared
  且 get 为 null。

### B. compact（thread/compact/start）

- 形状：`{threadId}` → `{}`（v2/thread.rs:1148-1156）；`contextCompaction` item
  v2/item.rs:425-427。core 语义：先 abort_all_tasks(Replaced) 打断活动 turn（无 busy
  报错），再 spawn CompactTask（core/src/session/handlers.rs:244-251）。
- 钩子语义：compactWaitMs（默认 5s）后 item/completed + turn/completed，
  `state.justCompacted=true` → **下一条普通 turn** 回复首行「刚刚经历过compact」，
  用后即清。活动期 compact 打断原 turn（interrupted），**不触发** consumeQueue；
  compact 自身收尾链恢复队列消费（MB3：consumeQueue 回调若遇活动 turn 则把消息放回
  队首，避免覆盖 state.sim）。双入口拒绝：compact 中 turn/steer → -32600
  "cannot steer a compact turn"（turn_processor.rs:1101-1111）；turn/start → -32603
  `failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }`
  （turn_input.rs:660-680 → turn_processor.rs:675-684 的 `{reason:?}` 文本）。
- 真机复测：点 compact 按钮 → 约 5 秒 → 下一条回复首行带标记；下一条恢复普通回复。

### C. plan（collaborationMode 闭环）

- 形状：`CollaborationMode` = `{mode, settings:{model, reasoning_effort,
  developer_instructions}}`，**wire 为 snake_case**（config_types.rs:708-783；:780
  Settings 无 camelCase 重命名）。turn/start.collaborationMode（v2/turn.rs:263-267）
  与 thread/settings/update.collaborationMode（v2/thread.rs:281-285）→ 存线程；
  ThreadSettings.collaboration_mode 非 optional（v2/thread.rs:304-335）；
  thread/resume.collaborationMode 返回实值（v2/thread.rs:467）。
- 钩子语义：mode==="plan" 的普通 turn 回复前缀「【Plan 模式（模拟）】」；流式完成后
  emit turn/plan/updated（v2/turn.rs:568-573）与 item/plan/delta（common.rs:1962 →
  v2/item.rs:1444-1454 `{threadId, turnId, itemId, delta}`）。`TurnPlanStepStatus`
  实际枚举 v2/turn.rs:583-590：**pending | inProgress | completed**（模拟用
  completed/pending 子集；未用 inProgress）。
- 真机复测：切 Plan 模式 → 发消息 → 回复带前缀且收到 plan 通知；切回 Default 不再带。

### D. status（server/diagnostics、remoteControl/status/read、memory/status）

- 形状：server/diagnostics `{process:{id, residentMemoryBytes, physicalFootprintBytes},
  gauges:[]}`（v2/diagnostics.rs:14-38）；remoteControl/status/read `{status,
  serverName, installationId, environmentId}`（v2/remote_control.rs:60-66）；memory/status
  `{v2ConsolidatedThreads, v2Ready}`（v2/memory.rs:20-23）。connected/disabled 复用
  initialize 注入的 getServerInfo（隧道身份）。
- 真机复测：设置页/诊断入口读取，不应出现解码失败。

### E. side（thread/shellCommand + backgroundTerminals）

- 形状：shellCommand `{threadId, command, timeoutMs?}` → `{}` 立即，空命令
  "command must not be empty"（v2/thread.rs:1160-1178）；后台终端 list
  `{data:[{itemId, processId, command, cwd, osPid, cpuPercent, rssKb}], nextCursor}`
  （v2/thread.rs:1209-1243，统计字段模拟为 null）；terminate `{terminated}`（:1245-1253，
  processId parse 整数，非法 -32600）；clean `{}`（:1197）。
- 钩子语义：命令完成后登记 backgroundTerminals（processId 用 makeCommandExecution
  的模拟进程号）；无活动 turn 时创建轻量 shell turn（kind normal，全序
  status active/turn/started…turn/completed），有活动 turn 时条目直接挂当前 turn。
- 真机复测：发送 shell 命令 → 出现 commandExecution 条目 → 后台终端列表可见 /
  terminate / clean。

### F. branch（thread/metadata/update + thread/fork）

- 形状：ThreadMetadataUpdateParams `{threadId, projectId?, gitInfo?,
  daybreakEnabled?}`（v2/thread.rs:1008-1029）；gitInfo sha/branch/originUrl 均**双层**
  Option（:1031-1064）；响应 `{thread}`（:1067）。错误文案对齐 thread_processor.rs:1914-2050：
  全缺 → "thread metadata update must include at least one field"；gitInfo 全缺 →
  "gitInfo must include at least one field"；projectId 非空 → "project not found: {id}"
  （sim 无 projects）。ThreadForkParams/Response（:544-678，ForkResponse 无
  collaborationMode）；forkedFromId；thread/started 通知。
- 钩子语义：gitInfo 双层（缺省=不变、null=清除、非空串=设置）；fork 继承
  name/cwd/model/reasoningEffort/gitInfo/collaborationMode/projectId，lastTurnId 截断
  历史（含该 turn），ephemeral fork 不进列表。
- 真机复测：分支/元数据设置 → resume 回读；fork 后新会话历史截断正确。

### G. skill（extraRoots/set、config/write、plugin/skill/read、$技能名）

- 形状：skills/extraRoots/set `{}`（v2/plugin.rs:40-49）；skills/config/write
  path/name 恰一，否则 -32602 "skills/config/write requires exactly one of path or
  name"（v2/plugin.rs:933-950；catalog_processor.rs:699-700）→ `{effectiveEnabled}`；
  plugin/skill/read → `{contents}`（v2/plugin.rs:268-281）。
- 钩子语义：消息含 `$名`（名 ∈ data.ts SKILLS）→ 回复首部一行「已加载技能 $名（模拟）。」。
- 真机复测：输入含 `$bridge-sim-demo` → 回复确认加载；技能开关写入返回 effectiveEnabled。

### 已知偏差（模拟近似，非协议错误）

- turn/start 遇 compact 的文案按 Debug 形状近似：真实为
  `failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }`（Rust
  Debug 输出，turn_processor.rs:675-684），非稳定 wire 文案，仅关键字对齐。
- item/plan/delta 属 experimental（源码注释：客户端不应假设 delta 拼接等于 completed
  plan item 内容），模拟发 1-2 条与 turn/plan/updated 内容一致的分片。
- metadata/update 的 sha/branch/originUrl 空字符串报 -32600（消息形如
  "gitInfo.branch must not be empty"）为模拟近似；真实 codex 空串应视为非法替换但
  具体错误文案未逐一核对。originUrl 不做远端消毒。
- backgroundTerminals/* 同时接受带 `thread/` 前缀的权威方法名与裸名别名。
- projectId 空字符串按清除处理（对齐 v2 注释"use an empty string to clear it"）。

## 2026-09-26 真机 queue 复测截断：根因与修复（流生命周期）

### 症状与证据链

真机 `test queue` 排队一条消息后，后续每条消息"不完整、截断位置随机"（如 3/3 停在
"若有排队消息它"）；服务器侧 state.json 文本完整；daemon 无 pending 溢出 WARN。
9/25 真机抓包（.agent-work/tmp/sim/frames-*.jsonl）证实：wham 与手机**逐帧 ack（含
pong，跳 seq 累积确认）**、手机流短命（每流 6~71 帧）、`client_closed` 频繁、**尾部
残留为 0**（ack 追平到最大 seq）。今晨日志显示手机反复 initialize 重连，wss 多次
1012 断开——每代流留在 streams 里。

### 根因

fanOut 向 streams 里**所有**（含已死/僵尸）流广播通知副本；僵尸流永不 ack，其副本
持续占据全局 128 未 ack 缓冲 → 活跃流 delta 帧被背压滞留 → 手机拼接出随机前缀。
渐进形态与转录吻合（1/3 完整、2/3 丢尾句、3/3 丢更多）。无 pending 溢出 WARN 是
因为每流 pending 仅几十帧（远小于 256）。

### codex 对应（client_tracker.rs / websocket.rs）

- 只有 ClientMessage/Initialize **注册连接**（`clients.insert`），此后才接收通知；
  ping/ack 不注册（Ping 对未注册 client 只回一次性 Pong Unknown，client_tracker.rs
  :222-242）。
- 空闲回收：`REMOTE_CONTROL_CLIENT_IDLE_TIMEOUT=10min` + 30s 扫描
  `close_expired_clients`（:27-28/:295-310，websocket.rs:1155 消费）。
- 通知出站只经活跃连接的 writer（连接关闭/过期即无新增帧）。
- 背压=停读上游 channel（websocket.rs:1010-1019），不丢不截。

### 修复（src/wham/tunnel.ts）

- StreamState 增 `registered`（client_message/分片重组到达即注册）与
  `lastInboundAt`（入站续命；ping 只给已注册流续命）。
- fanOut 只发注册流（ping/ack-only 流不收副本）。
- `sweepIdleStreams`（挂 ping 定时器）：空闲 ≥10min 整流回收（删流/归还容量/
  forgetClient，对齐 codex）；全局背压且有积压流静默 ≥60s 时**加速回收**（自设止损：
  防僵尸流饿死活跃流；活跃流有 ≤10s ping 续命不会误伤），回收后立即跨流排空。
- daemon 帧级 jsonl 日志默认落实例目录 `frames.jsonl`（本次定位受限于无帧记录）。
- 测试：T9（僵尸流饿死复现+修复，旧实现反向证伪失败确认）、T10（ping-only 不
  fan-out）、T11（空闲回收闭环）；全量 173/173。

### 真机复测

重跑 `test queue`：排队后手机消息应完整（即便中途锁屏/切换致 wss 断代，最长 60s
自愈）；`~/.cgrcb/instances/sim/frames.jsonl` 可核对双向帧与 ack。

## 2026-09-26 新版 ChatGPT 1.2026.258：command/exec 缺失 →「Codex 服务器返回了错误」

**现象**：手机端意外升级到 1.2026.258 后，hi / test queue 均弹「Codex 服务器返回了错误」，
frames.jsonl 显示每 30 秒一次 initialize 会话重建循环（17:12-17:14 实录）。

**根因**（非上轮改动）：新版把发消息前的一次性命令探测从 process/spawn 迁移到
**command/exec**（app-server-protocol v2/command_exec.rs）：真机在 17:12:38/17:13:01 两次
调用 `["/bin/sh","-c","printf '\\0'; exec \"$@\"","codex-read-only","/bin/sh","-lc","cd \"$HOME\" && pwd -P"]`
（streamStdoutStderr:true + processId + outputBytesCap:4097 + sandboxPolicy readOnly），
sim 未实现该方法回 -32601，手机即报错并重建会话。17:00 旧版 1.2026.251 同类探测仍走
process/spawn（全部成功），证明是新版协议差异。

**契约要点**（对齐 codex）：
- 最终结果直接作为 RPC 响应 `{exitCode, stdout, stderr}`（不同于 process/spawn 的
  `{}` + process/exited 通知）；流式（streamStdoutStderr/tty，必须带 processId）时输出经
  **连接级** `command/exec/outputDelta` 通知（base64、stream: stdout|stderr、capReached）
  下发，最终响应 stdout/stderr 为空——对应 codex `send_server_notification_to_connection_and_wait`。
- 校验顺序：先「流式必须带 processId」（-32600），后「command must not be empty」（-32600）；
  outputBytesCap 按字节截断；write 缺 deltaBase64 且未 closeStdin → -32602；
  write/terminate/resize 无活动会话 → -32600 `no active command/exec for process id "<id>"`。
- codex-read-only 外壳先 `printf '\0'` 再 exec 内层脚本——应答 stdout 保持 `\0` 前缀，
  与真实 codex 执行输出逐字节一致。

**修复**（commit 75009e6 一批）：
- `AgentNotification`/`SimNotification` 增加可选 `target`（连接级定向），tunnel fanOut
  只投给目标注册流；
- sim 实现 `command/exec`（+write/terminate/resize），仿真引擎与 process/spawn 共用
  （`emulateShellScript` 提取），HOME 探测回 `\0 + realpath($HOME)`；
- 测试：sim 3 个（流式/缓冲+cap/校验与错误文案）+ wham T12（target 定向路由），全量 179/179。

### 追记：第二层「Codex 执行失败」（同日 17:31）

command/exec 打通后，手机新会话卡在下一步：**任务目录创建脚本**改走
`codex-workspace-write` 包装，且根目录不再硬编码 `Documents/Codex` 而是
`root="$CODEX_PROJECTLESS_ROOT"`（env 注入，base=消息文本，应答 printf candidate）。
两处叠加：包装解包只认了 `codex-read-only`；`emulateTaskDirMkdir` 匹配不上新脚本
→ 回空 stdout，手机拿不到新任务目录路径 → 弹「Codex 执行失败」。

修复（commit 与 75009e6 批次相邻）：包装解包改为结构判定（`exec "$@"` 外壳 +
`-lc` 内层，任意 codex-* arg0）；任务目录脚本支持 env 根目录（env 经
processSpawn/commandExec 下传 emulateShellScript）；测试新增 workspace-write
任务目录原样脚本用例，全量 180/180。

## 2026-09-25 test steer 停止规则：steer「stop」步骤边界终止脚本

需求：`test steer` 脚本（3 条消息 + 2 次 15 秒模拟等待）进行中，若 steer 输入文本为
`stop`（trim + 大小写不敏感），当前工具或消息步骤一结束就终止剩余脚本——后续消息与
第二次等待不再执行；全部待处理 steer 输入仍落为 userMessage item（保持手机端对账），
但只回一条固定消息 `（steer注入）已按照steer规则停止原本的任务。`，随后 turn 以
completed 收尾并照常消费 thread 队列（排队消息不受影响）。

实现：`SimTurnRuntime.steerStopRequested` 标记（`turn/steer` 与活动期 `turn/start` 两处
入队统一走 `pushSteerInput`，文本为 stop 时置位）；`processSteers` 顶部优先分流到
`handleSteerStop`（不逐条回复，done 链到此终止）；`runScriptedTurn.step` 在每条消息流
结束处增加检查点——消息期间收到 stop 则不进入下一次 15 秒等待。普通 turn / 独立
shell turn 的 steer 排水链共用该入口，`stop` 文本同样按停止语义收尾。测试新增 sim
用例（等待窗口内 steer " Stop " → 仅 1 次 wait + 单条停止消息），全量 181/181。

## 2026-09-26 goal 续跑：thread/goal/set active 自动开跑 turn（continue_if_idle 对齐）

真机复现（ChatGPT iOS 1.2026.258）：会话内「启用 goal」→ 手机发 `thread/goal/set`
（status active + objective）后**一直等不到任何回复**；约 30 秒自动刷新后，用户发出
的那条目标消息气泡消失。frames.jsonl 佐证：goal/set 响应与 `thread/goal/updated` 均正常，
但手机此后**再未发出 turn/start**——目标气泡是纯手机本地 UI，锚定在「goal 激活后
agent 侧自动开跑的续跑 turn」上；sim 只存了 goal 不开跑，刷新对账时服务器侧无任何
对应条目，气泡即被清掉。

codex 参考语义（`reference/codex/codex-rs`）：

- `thread_goal_processor.rs:141-243`：set 响应先行，随后 `thread/goal/updated`
  {turnId:null}；`apply_runtime_effects` → status active 时走 `continue_if_idle`。
- `ext/goal/src/runtime.rs:425-523` `continue_if_idle`：线程空闲则
  `start_turn_if_idle`（turn_trigger "goal"），输入为隐藏内部上下文
  （steering.rs `continuation_steering_item` → ContextualUserFragment，**不下发
  客户端**，故续跑 turn 无 userMessage item）；`extension.rs on_thread_idle` 在
  每次线程转空闲时重复触发，循环由 LLM 调 `update_goal(complete|paused|blocked)`
  （tool.rs handle_update）终止。
- `extension.rs on_turn_stop` → `account_active_goal_progress`：active goal 随
  turn 累加 tokensUsed/timeUsedSeconds 并广播 `thread/goal/updated`{turnId:本turn}；
  `thread/goal/cleared` **只**来自 `thread/goal/clear` RPC
  （thread_goal_processor.rs:294-299）。
- `api.rs set_thread_goal`：objective 做 trim；携带 objective 且线程 preview 为空时
  用 objective 填充（tool.rs:473 `fill_empty_thread_preview_if_possible`）。

sim 实现（无模型，循环有界）：`goalSet` 结果为 active 且空闲 →
`continueGoalIfIdle`（consumeQueue 队列耗尽处同触发，对齐 on_thread_idle；回调内
重查忙/队列/goal 状态防竞态）→ `beginGoalTurn`（kind "goal"，可 steer 含 stop
规则，无 userMessage item，回一条 `（goal）已接收目标：「…」` 消息）→
`finishSimTurn` 计量：active goal 每 turn 累加 1234 token（与 tokenUsage 通知的
total 一致）+ 实耗秒数，goal turn 结束标记 **complete**（代替 LLM 的
update_goal(complete)，一次激活至多续跑一轮）；turn 结束不再发 cleared（旧
「每 turn 清除 goal」行为废止）。goalSet 补 objective trim 与空 preview 填充。

测试：S03-A goal 用例重写（空闲 set → 自动 turn/started 无 items → 无 userMessage
item → 计量 updated{turnId} + complete + tokensUsed 1234 → 无 cleared →
budget/objective 保持 → clear true/false）；新增忙时用例（test queue 等待窗口内
set active → 用户 turn 结束计量仍 active → 自动续跑 goal turn → complete，共 2 轮
计量 2468，bounded 断言无第三轮）；resume 快照用例改 `status:"paused"` 消除自动
续跑与 envelope 时序的竞态。全量 182/182。

### 追记：目标模拟脚本改为「首轮 3 条 → blocked，再启 1 条 → complete」（同日）

用户规则更新：goal 激活后的续跑 turn 不再一次输出即 complete，而是——首轮激活输出
3 条文本后把 goal 标记 **blocked**；用户从 blocked 再次启动（`thread/goal/set`
status active）后续跑轮输出 1 条后标记 **complete**。

实现：轮种在 goalSet 结果为 active 时按**先前状态**判定（`existing?.status ===
"blocked"` → 续跑轮，其余（新目标 / paused / complete / active 重设）→ 首轮），存
内存态 `ThreadState.goalRunResume`（不持久化——goal 的持久化状态本身足以在重启后
恢复判定）；`SimTurnRuntime.goalEndStatus`（blocked/complete）由 `beginGoalTurn`
按轮种写入，`finishSimTurn` 计量后统一应用；首轮 3 条消息在消息边界排水 steer
（同 runScriptedTurn，stop 规则生效——中途停止按首轮终态 blocked 收尾）。计量仍
每 goal turn 1234 token。真机推论：blocked 后手机 goal 卡片应出现「继续/重试」
入口，点击即走续跑轮。

### 追记：goal turn 每轮插入模拟 wait（第 2 轮 30 秒，其余 10 秒）（同日）

用户规则再更新：每个 goal turn 开始先插入**一个**模拟 wait 命令执行——第 2 个
goal turn 为 `wait 30 seconds`，其余（第 1、3、4…个）为 `wait 10 seconds`，然后
才输出该轮消息。

实现：`simulateCommandWait` 参数化（`opts.command` / `opts.waitMs`，默认仍为
"wait 15 seconds" + commandWaitMs，test steer 行为不变）；`beginGoalTurn` 开跑时
递增内存态 `ThreadState.goalTurnCount`（新 goal 的 set 与 goal/clear 归零），
按轮次取 wait 秒数，真实时长 = 秒数 × commandWaitMs/15（部署默认 15s 比例 →
10s/30s 实际等待；测试设小 commandWaitMs 等比加速）。等待结束排水 steer（stop
规则在等待边界生效，中途停止按该轮终态 blocked/complete 收尾）。两个 goal 回归
测试补 wait 条目断言（每轮恰 1 个、10/30 秒标签、与 test queue 用户 turn 的
wait 按 turnId 区分），全量 182/182。

### 追记：goal 生命周期改为 4 个链式 goal turn（澄清）（同日）

用户澄清上一轮需求：不是「每轮 3 条消息挤在一个 turn 里」，而是——**整个目标生命
周期共 4 个 goal turn，每个 turn = 1 个模拟 wait + 1 条 agentMessage**：

- 首轮阶段（激活）：goal turn 1（wait 10s，输出 1/3）→ 结束保持 active → 经
  on_thread_idle 链式自动续跑 → goal turn 2（wait **30s**，输出 2/3，即 blocked
  前那个）→ goal turn 3（wait 10s，输出 3/3）→ 标记 **blocked**；
- 再启阶段（blocked → active）：goal turn 4（wait 10s，1 条输出）→ **complete**。

实现：`ThreadState.goalPhaseIndex`（阶段内轮序，每次 goalSet active 归零）；
`goalEndStatus` 语义扩展——null=保持 active（finishSimTurn 只在非空时写终态，
计量照常发 thread/goal/updated{turnId}）；阶段内前 2 轮 goalEndStatus=null，
链式续跑复用既有 consumeQueue → continueGoalIfIdle 路径（对齐 codex on_thread_idle
循环，goal 不因 turn 结束而停）。wait 规则不变：goalTurnCount 第 2 个 = 30 秒，
其余 10 秒——在 4-turn 结构下即 blocked 前那一轮。计量每 goal turn 1234：blocked
时 3702（3 turn），complete 时 4936（4 turn）。steer/stop 只终止当前 goal turn，
goal 仍 active 时继续续跑（对齐 codex：turn 停 ≠ goal 停）。测试重写为
waitForGoalTurn 辅助 + 4 turn 链式断言，全量 182/182。
