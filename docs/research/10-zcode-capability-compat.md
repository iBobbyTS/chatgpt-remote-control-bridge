# 10 · zcode app-server 能力兼容性报告（cgrcb 桥接面全覆盖）

日期：2026-09-27 ｜ 状态：已完成（真实 GLM-5.3-Flash 调用验证）｜ 前置：[09-zcode-model-capability.md](09-zcode-model-capability.md)

## TL;DR

1. **核心链路全部打通**：会话生命周期（list/create/resume/close）、turn 文本+图片输入、文本增量流（`text_delta` 真流式）、命令执行项（命令/stdout/exitCode/时长）、权限审批双向（`interaction/requestPermission` 三选项）、打断、compact、token 用量、断线事件重放（`web-remote-replayable`）、单进程并发多会话——均真实调用验证。
2. **三个硬缺口**：turn/steer 原生不支持（`-32010`）；thread/inject_items 无对应接口；OAuth account provider（含 `account:zai-start-plan`）**无法无头物化**（凭据 `enc:v1` Keychain 加密），须用个人 API-key 规则等价替代（`zai/GLM-5.3-Flash`，同 key 同模型）。
3. **五个部分兼容**：fork 需 workspace checkpoint；历史无 per-turn 分组/分页（桥侧组装）；命令 stdout 不增量（一次性 result）；goal 无 tokenBudget；plan 模式可设但不落 `settings.mode.current`。
4. 按既定决策：**思考过程（reasoning delta）不接入**，只接入 textdelta、命令执行等 codex 原生远程内容——zcode 有 `reasoning_delta` 流，直接丢弃即可，无阻碍。

## 探测环境

- zcode `0.16.9`（`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server`），ZCode Protocol v1（无 jsonrpc 信封、无 initialize、反向请求必须应答，详见 09）。
- Provider 注入：`ZCODE_DATA_BASE_DIR`（隔离数据目录）+ `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` + `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE` + `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 四件套；个人规则 = `zai-api` 模板 + coding-plan key，物化 `zai/GLM-5.3` 与 `zai/GLM-5.3-Flash`。
- 真实调用一律 `zai/GLM-5.3-Flash`（reasoningLevel=low），全部 turn 经 `v4/telemetry/event` 的 `turn.terminal` 判定成败。
- 证据：`.agent-work/tmp/zcode-capability-probe/probe-{models,lifecycle,resume,turn,perm,fork,attach,aux,concurrent,replay,replay2,mode,interrupt,steer}.log`（`.agent-work` 不入库，关键形状已摘录进本文）。

### account:zai-start-plan 结论

用户指定测试 ref `account:zai-start-plan/GLM-5.3-Flash`。实测（probe-models.log）：

- 裸 spawn / `ZCODE_DATA_BASE_DIR` 指向真实 v2 全量拷贝（含 credentials.json + coding-plan-cache.json）/ 四环境变量组合——OAuth account provider 一律不物化，registry 只出个人 API-key provider。
- 根因：credentials.json 里 `account-provider:coding-plan:…:api-key` 值为 `enc:v1:`（Electron safeStorage/macOS Keychain），无头 node 进程解密不了；个人规则引用 `account:` 前缀 providerId 或 account 模板（任意 group/access 组合，4 变体矩阵）被 registry 整体丢弃（连 thoughtLevel 都置空）。
- **等价替代**（本次全部验证所用）：`zai/GLM-5.3-Flash`，同一把 coding-plan key、同一 anthropic-messages 端点、同一模型。GUI 的 start-plan 与此路径在模型能力上等价（supportsImage 等由模板声明一致）。

## 兼容性总表

图例：✅ 完全兼容 ｜ 🟡 部分兼容（原因见备注）｜ ❌ 无法兼容 ｜ ⚪ 不由 zcode 承载（桥/agent 自实现，无兼容性问题，仅列出归属）

### A. 会话与线程生命周期

| codex 桥接面 | zcode 接口 | 结论 | 备注/证据 |
|---|---|---|---|
| thread/list | `session/list` → `{sessions[]}` | ✅ | 50 条实测；含已 close 会话，桥侧过滤 |
| thread/start | `session/create {mode, workspace{workspaceKey,workspacePath}, model}` | ✅ | **quirk：create.model 会静默丢弃 `options.reasoningLevel`**，session.model 只剩 ref，首 turn 报 `invalid_model_request`；create 后必须补 `session/setModel` |
| thread/resume | `session/resume {sessionId}` | ✅ | 跨进程上下文保持（暗号「蓝色灯塔」召回成功）；消息/设置/标题随快照返回 |
| thread/fork | `session/fork` | 🟡 | 需 workspace checkpoint：纯聊天线程（无文件改动）报 `-32603 No workspace checkpoint is available yet`；有 Write 后 fork 成功（`{forkedSessionId, targetCheckpointId}`，复制消息+还原文件）。codex 纯对话 fork 需桥侧降级（新会话+重放摘要） |
| thread/unsubscribe / 多端订阅 | 桥自实现 fan-out；zcode 侧一个 `session/subscribe` | ⚪ | AUD-011 语义：订阅/广播是桥的职责 |
| thread/name/set | 无手动改名接口；自动命名 `session.titleUpdated`（titleSource=first_input） | 🟡 | 自动命名可用（首 turn 后生成）；手机手动改名需桥侧自存覆盖显示 |
| thread/settings/update（模型/推理） | `session/setModel` / `session/setThoughtLevel` | ✅ | 09 已证三级模型控制；GLM 仅 low/high/max（`medium` 报 Unsupported reasoning effort） |
| collaborationMode（plan/default） | `session/setMode`（build/edit/plan/yolo） | 🟡 | edit/yolo/build 全生效；`plan` 被接受但不落 `settings.mode.current`（模型行为有 plan 约束：拒非只读、放行只读 echo）。映射建议 default↔build 固定，plan 映射待产品决策 |
| thread/queue/* | 无（活动期 send 直接 `-32010`） | ⚪→🟡 | zcode 无队列；桥侧排队（turn 空闲即 send），语义由桥保证 |
| thread/inject_items | 无对应接口 | ❌ | zcode 无「向历史注入消息」API；降级方案：作为普通用户消息发送（语义变化）或不支持 |

### B. Turn 流转与事件流（接入范围：textdelta + 命令等，reasoning 不接入）

| codex 桥接面 | zcode 接口 | 结论 | 备注/证据 |
|---|---|---|---|
| turn/start（文本） | `session/send {sessionId, content}` → `{accepted, stateRevision}` | ✅ | |
| turn/start（图片附件） | `attachments:[{kind:"image", mimeType, dataBase64}]` | ✅ | 真图验证：64×64 纯红 PNG → 模型答「红色」；用户消息落 parts `[text, file]` |
| turn/steer | 无 | ❌ | 活动期 send 报 `-32010 A prompt is already running`；桥侧只能降级为排队或 interrupt+resend（语义有差：steer 注入当前 turn） |
| turn/interrupt | `session/stop` | ✅ | `turn.terminal{status:"interrupted", errorCode:"USER_INTERRUPT"}`；部分文本保留；会话立即可续（后续 turn success） |
| item/agentMessage/delta | `session/event` `model.streaming{kind:"text_delta", delta, done, assistantMessageId}` | ✅ | 真增量流（实测 4 段 9/162/6/32 字符；replay2 中单 turn 63 个 streaming 事件） |
| reasoning delta（不接入） | `model.streaming` 有 reasoning 类 kind | ⚪ | 按决策直接丢弃，无技术阻碍 |
| 命令执行项（CommandExecutionItem） | `model.streaming kind=tool_input_start/delta/end`（命令参数流）+ `tool_call{input:{command,description}}`；`tool.updated kind=scheduled→started{readOnly,sideEffectScope}→result{content, perf{exitCode, runMs, outputBytes}}` | ✅ | `echo bridge-probe-42` 全链路：命令/输出/exitCode/时长/只读标记齐备；toolName="Bash" |
| item/commandExecution/outputDelta（stdout 实时滚屏） | 无增量 stdout（result 一次性给全） | 🟡 | 桥可在完成时一次性 outputDelta + item/completed；长命令执行期间手机端看不到滚屏 |
| 权限审批（手机 allow/deny） | 反向请求 `interaction/requestPermission` | ✅ | params：`{input{command,description}, reason, riskLevel, requestId, toolCallId, toolName, turnId, options[]}`；options = `allow_once` / `allow_always(allow_project，含 permissionUpdates 规则)` / `deny`；应答=回显所选 option 的 `response` 对象。allow 后 turn 继续 success；deny 后 turn 仍 success、模型收拒因并改道。同事件也在 `session/event type=permission.requested/resolved` 流里 |
| 审批触达时机 | `tool.updated started{readOnly:true}` 不触发；副作用工具（Write riskLevel=medium、curl riskLevel=high）触发 | ✅ | 只读命令免审批白名单与 codex 语义一致方向 |
| turn/started、turn/completed | `session/event` `turn.started{input, messageId, turnNumber}` / `turn.completed{response, tokenCount, usage, toolCallCount, durationMs, resultType}` + `v4/telemetry/event turn.terminal{status: success|failed|interrupted, errorCode, errorMessage}` | ✅ | 失败样例：`invalid_model_request` 带 code+message，可映射 codex turn failed/error |
| thread/compact/start | `session/compact {instructions}` | ✅ | 返回快照；完成后消息含 `semantics.kind=compact_summary`（user，parts=[text,compaction]）+ timeline compaction 事件 → 干净映射 codex ContextCompactionItem |
| thread/tokenUsage/updated | `session/usage {totalTokens, input/output/reasoning/cache 分项, modelRequestCount}` + `runtime.contextUsage{cache hitRate}` + 每 turn `turn.completed.usage` | ✅ | |
| thread/goal/set|get|clear | `session/goal {action: show|set|replace|pause|resume|clear, objective}` | 🟡 | 目标+用量+时长跟踪可用；**无 tokenBudget 参数**（zod 拒 unrecognized key），codex goal 的预算字段桥侧自管或丢弃；活动 turn 中 goal 管理报 `-32010` |
| 断线重连补投 | `session/events {sessionId}`（重放全部，带 seq 可自行过滤）+ `session/subscribe {deliveryKind:"web-remote-replayable"}` → `{eventSeq, events}` + `runtime.eventSeq/pendingRequestIds/stateRevision` | ✅ | deliveryKind 枚举即为此设计：`desktop-continuous | web-remote-replayable` |
| 历史 items（thread/items/list、thread/turns/list） | `session/messages {sessionId}` / `session/read` → `messages[]{info{role, model, finish, semantics, parentMessageId}, parts[]{type: text|file|step-start|step-finish|timeline…, text}}` | 🟡 | 数据全（含模型归因、finish、语义种类），但**消息上无 turnId、无分页参数**：per-turn 分组与分页由桥按 parentMessageId/时序组装 |
| 单进程并发多线程 | 多 session 并行 turn | ✅ | 双会话并行 send 双 success |
| model/list | `settings.model.available[]`（ref/levels/modalities/contextWindow） | ✅ | 桥转换为 codex 模型列表形状 |
| slashCommands / skills / todos | create/read 结果自带（`slashCommands[]`、`todos/todoGroups`） | ✅ | 形状可用；codex 侧 skills/list 桥可映射或占位 |

### C. 桥自实现面（与 zcode 无关，归属明确）

`initialize`（clientInfo/optOut）、`fs/*`（readDirectory/getMetadata/createDirectory/writeFile/readFile）、`command/exec*`、`process/spawn`、`thread/shellCommand`、`thread/backgroundTerminals/*`、`server/diagnostics`、`account/rateLimits|usage`、`remoteControl/status/read`、`config/*`、`configRequirements/read`、`attestation/generate`、心跳 pongStatus——这些是 codex 远程协议里由「被控端」自己实现的能力；sim 以仿真实现，zcode agent 按 AUD-011/COV-ZCODE 的权限设计自行实现（真实 fs/shell 或继续仿真），不依赖 zcode app-server。

## 关键协议事实（接桥必读）

1. **订阅读写**：`session/event` 不订阅不推送；`session/subscribe {sessionId, deliveryKind:"desktop-continuous", includeSnapshot:true}`（zcode-mcp 同款）。桥用 `web-remote-replayable` 支持重连。
2. **事件分类学**（实测全集）：`turn.started|completed`、`model.streaming`（kind: `text_delta` / `tool_input_start|delta|end` / `tool_call` / reasoning 类）、`tool.updated`（kind: `scheduled|started|result|batch`）、`session.updated`（messageCount/toolCount/iteration）、`session.titleUpdated`、`permission.requested|resolved`、`streamRecovery.updated`、`state.updated`（registry 级 patch）。
3. **反向请求必须应答**（15s 超时）：`session/requestRuntimePreferences`（scope=runtime-materialization，不答则 create 失败 -32022）、`interaction/requestOfficialMcpAuthHeaders`（答 `{}`）、`interaction/requestPermission`（回显 option.response）。
4. **错误码**：`-32010` 会话忙（steer/活动期 send/goal 管理）、`-32602` zod 参数错（错误信息含完整期望形状，可作形状发现）、`-32603` 内部错（fork 无 checkpoint 等）。
5. **create.model 丢 options**：必须 create→setModel 两步；或每次 send 带 `modelSelection`（注意其粘性会改 session.model，09 已证）。
6. MCP/插件在无头下照常加载（探到 `interaction/requestOfficialMcpAuthHeaders` 的 image-search 请求），桥答 `{}` 即可，不影响 turn。
7. **审批无人应答不自动拒绝**：实测（probe-waitperm.log）客户端不答 `interaction/requestPermission` 时，服务端以同一 requestId 约 9 秒一次持续重发（280 秒内 31 次），turn 一直挂起、无自动 deny、不产生回答。桥必须自带「无人应答」策略（超时 fail-closed deny 等）。
8. codex 手机端审批枚举为 `accept / acceptForSession / acceptWithExecpolicyModification / deny`（app-server-protocol schema），与会话级常准许对应 zcode 的 `allow_always(allow_project)` 可映射（注意：zcode allow_project 写持久项目规则，作用域大于 codex 的 session 级）。

## 附：周额度 / 5h 额度获取（account/rateLimits 背书）

**zcode app-server 协议不提供配额查询**：方法面（session/\*、provider/\*、offPeak/\* 等）无配额接口；zcode.cjs 中 quota 字样均为错误处理（quota_exceeded 分类）与 GUI 内部 entitlement 快照解析（codingPlanEntitlement，不对外）。

**可行路径 = UlanziDeckSwift 的直连方式（已实测）**：

- `GET https://api.z.ai/api/monitor/usage/quota/limit`，请求头 `Authorization: <coding-plan apiKey>`（本机即 `~/.zcode/v2/config.json` 的 `provider["builtin:zai-coding-plan"].options.apiKey`，与本文探测 GLM 所用同一把 key；URL = 该 provider baseURL 的 scheme+host + 固定路径）。
- 响应 `{code:200, success:true, data:{limits[], level}}`；`limits[]` 内 `type="CREDIT_LIMIT"`：`(unit=3,number=5)` = 5 小时窗、`(unit=6,number=1)` = 周窗（7 天）。字段含**绝对额度**（`usage` 上限 / `currentValue` 已用 / `remaining`）、`percentage`（已用百分比）、`nextResetTime`（unix 毫秒）、`level`（套餐档，实测 "max"）。
- 实测（2026-09-27）：5h 窗已用 6%（28000 额度用了 1778，2.5h 后重置）；周窗已用 5%（140000 用了 7720，155h 后重置）。
- 桥落点：zcode agent 的 `account/rateLimits/read` 用此端点实现（key 已在注入配置中）。**已确认决策（2026-09-27）**：不做定时刷新——仅手机请求 `/status`（即 `account/rateLimits/read`）时才调端点，结果缓存 1 分钟自动过期；请求参数参考 UlanziDeckSwift：10s 超时、`Cache-Control: no-cache`。

## 已确认产品决策（grill-me 访谈 2026-09-27）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 权限基线 | 映射手机 approvalPolicy（不固定 build） |
| D2 | 审批无人应答 | 无限等待（zcode 服务端本就不自动拒；手机可用 interrupt 解除） |
| D3 | turn/steer 降级 | 打断重发（session/stop + 立即 send 新输入） |
| D4 | 模型来源 | 读用户现有 provider_config 合并（+桥自动补 zai coding-plan 规则） |
| D5 | approvalPolicy 映射表 | never→yolo，其余（on-failure/on-request/unrecognized）→build；sandboxPolicy 仅展示不参与映射 |
| D6 | acceptForSession | 桥侧会话缓存模拟：同类审批（工具+命令匹配）自动答 allow_once，会话结束失效，不写 zcode 持久规则 |
| D7 | 历史列表 | 含 GUI 会话全部显示（会话库互通） |
| D8 | 工作目录 | 用手机 thread/start/resume 传的 cwd 作为 zcode workspace |
| D9 | 数据目录 | 共享真实 `~/.zcode/v2`（GUI 与桥同一会话库 sqlite + 状态；接受并发访问风险） |
| D10 | 额度查询 | 仅手机请求 /status 时调端点，缓存 1 分钟过期，不定期刷新 |

## 同步能力边界与官方 remote/v4 评估（2026-09-27）

- **共享 v2 ≠ 实时镜像**：桥与 GUI 是两个进程、各自持有会话运行时；一个进程内运行的 turn 不会向另一进程实时扇出事件。共享达到的是**会话库级互通**（thread/list 互见、resume 接管、历史/持久化一致），不是「同一会话双端实时同步」。跨进程读取 GUI 运行中会话的持久化事件（session/events 轮询）可行性未验证，只作后续研究方向。
- **官方 remote/v4**（`zcode.z.ai/remote/v4`）：三段全部闭源——云 relay（`wss://zcode.z.ai/ws`）、手机 Web UI、本地客户端（实现不在 zcode.cjs，在 Electron 壳 app.asar；zcode.cjs 仅暴露 `StartWebRemoteControl` 等 IPC 通道名表；开源 reference/ZCode 仓库零相关代码）。逆向成本高且 v3→v4 已迭代过一次。
- **结论（建议双轨）**：ChatGPT App 驱动走本桥（兼容面已按第 10 文档收口）；「GUI 与手机完全同步」用官方 v4 链接原样满足（零开发，今天可用）；不逆向 v4。

## 风险与后续

- 形状均为 0.16.9 实测，无官方 schema；升级 zcode 需回归本探测（脚本在 `.agent-work/tmp/zcode-capability-probe/probe.mjs`，场景：models/lifecycle/resume/turn/perm/fork/attach/aux/concurrent/replay/replay2/mode/interrupt/steer/waitperm）。
- steer 降级策略（排队 vs interrupt+resend）与 plan 模式映射是产品决策，建议进 COV-ZCODE 权限设计评审一起定。
- 命令 stdout 非增量：若手机端体验不可接受，需评估 zcode 后续是否提供输出流事件（当前版本无）。
