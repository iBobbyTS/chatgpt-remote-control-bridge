# 06 · 手机端场景与方法映射（实证版）

日期：2026-09-25 · 方法：反向代理（`src/wham/proxy.ts`）插在 codex daemon 与 chatgpt.com 之间，
12 个场景全部实测，帧日志 `.agent-work/tmp/wham-probe/real-2026-09-25T19-05-28-577Z.jsonl`
（5994 帧：2953 手机→codex / 2642 codex→手机 / 133×3 REST）。

手机客户端身份：`clientInfo = {name:"codex_chatgpt_ios_remote", version:"1.2026.251"}`；
wham 后端自身以 `{name:"codex-backend", title:"Codex Remote Control"}`（id 前缀 `__slingshot_backend_*`）先注册为常驻客户端。

## 场景 → 实测方法序列

### 普通聊天

**1. 新聊天发消息**（S1）
```
initialize（手机客户端）
process/spawn  /bin/sh -c 'mkdir -p ~/Documents/Codex/<date>/<任务名>'   ← 手机端直接建任务目录
thread/start   {cwd:任务目录, threadSource:"user", model, historyMode:"paginated",
                sandbox:"danger-full-access", approvalPolicy:"never", config:{...}, dynamicTools:[]}
turn/start     {threadId, input:[{type:"text",text,}], clientUserMessageId:<UUID>,
                turnTrigger:"remote_ios", summary:"detailed", effort, cwd, model}
  ├─ 并行子会话（自动生成标题）：
  │   thread/start {threadSource:"thread_title", ephemeral:true, sandbox:"read-only",
  │                 approvalPolicy:"never", model:"gpt-5.4-mini"}
  │   turn/start   {input:"You are a helpful assistant… provide a short title…", effort:"low"}
  │   thread/unsubscribe
  └─ 通知流：thread/started, item/started|completed(userMessage), turn/started|completed,
             thread/status/changed, thread/tokenUsage/updated, agentMessage item
process/spawn ×N  （git/workspace diff 收集，`GIT_OPTIONAL_LOCKS=0`，20s 超时，输出 "notGitRepository\0"）
```

**2. 已有聊天发消息**（S2）：`thread/resume {threadId, config, cwd}` → `turn/start`（同 threadId，无新 thread/start）

**3. 打断**（S3）：`turn/interrupt {threadId, turnId}` —— 立即生效，turn 以 aborted 状态收尾。
打断后继续（用户实测 continue）：就是普通 `turn/start`（input="S3: continue"），无特殊方法。

**4. queue（工作中排队）**（S4）：工作中发消息 →
```
thread/settings/update {model, effort, serviceTier, collaborationMode, summary}
thread/queue/add {threadId, input:[{type:"text",text}], clientUserMessageId}
thread/queue/list ×N（UI 刷新）
```
**没有** `thread/queue/start`：turn 结束后 codex 自动消费队列并开启新 turn（S4-q 未出现独立 turn/start）。

**5. steer（工作中插入）**（S5）：
```
turn/steer {expectedTurnId, threadId, input:[{type:"text", text, text_elements:[]}]}
```
仅 3 个字段；expectedTurnId 防止 steer 到已结束的 turn。

**6. 历史加载**（杀 App 重开 / 刷新，S6/S9）：
```
initialize → thread/list {sortKey:"recency_at"|"updated_at", limit:25|50, sortDirection:"desc",
                          sourceKinds:[], useStateDbOnly:true, modelProviders:[], archived:false}
           → thread/list {sortKey:"section_position", sectionId, limit:100}（Pinned 分区）
           → threadSection/list {limit:100}
           → thread/turns/list {threadId, itemsView:"notLoaded", cursor:{rolloutOrdinal…}, limit}
           → thread/items/list {threadId, cursor, sortDirection:"desc"}
           → skills/list {} / plugin/installed {} / collaborationMode/list / model/list / config/read
```

### 基于项目

**7. 浏览目录并选工作区**（S7）：
```
process/spawn  /bin/sh -c 'cd "$HOME" && pwd -P'         ← 先解析家目录
fs/getMetadata {path:"/Users/ibobby"}
fs/readDirectory {path:"/Users/ibobby"}                   ← 逐级浏览
fs/getMetadata {path:"/Users/ibobby/AUAV"}
fs/readDirectory {path:"/Users/ibobby/AUAV"}
skills/list {cwds:["/Users/ibobby/AUAV"]}                 ← 切目录后重取技能
thread/start {cwd:"/Users/ibobby/AUAV", threadSource:"user"}
```

**8. 工作区里发消息**（S8）：同场景 2（thread/start 已做，之后 turn/start）。

**9. 刷新看列表**（S9）：同场景 6（thread/list 两个排序 + threadSection/list）。

### 附加场景

**10. 计划模式与批准**：turn/start 的 `collaborationMode.mode:"plan"`（正常为 `"default"`）；
批准执行 = 普通的 `turn/start {input:"Implement the proposed plan.", collaborationMode:{mode:"default"}}` —— 无专门"批准"方法。

**11. `$`（skill 枚举）**：纯客户端行为，只触发 `skills/list`（带 cwd 参数），不产生 turn。

**12. 压缩上下文**：`thread/compact/start {threadId}`。

## 方法频次（本会话实测）

| 方法 | 次数 | 说明 |
|---|---|---|
| process/spawn | ~130 | 手机端直接在本机跑 bash（建目录/git 收集/diff），最高频 |
| thread/list | ~40 | 各种排序组合（recency_at/updated_at/section_position/created_at） |
| initialize | 3 | App 重开/重连时 |
| turn/start | 12 | 含标题生成子会话 |
| thread/resume | ~15 | 打开已有会话/通知订阅（`excludeTurns:true`） |
| thread/queue/list · threadSection/list · skills/list | 各 ~10 | UI 刷新 |
| process 通知（process/exited 等） | 大量 | codex→手机 |
| 其余 | 见帧日志 | |

## 关键协议要点（bridge 实现规格）

1. **initialize 双客户端**：wham 后端（slingshot）+ 手机各自 initialize；id 可为保留前缀（`__slingshot_backend_*`）或 UUID。
2. **turn/start 必带**：`turnTrigger:"remote_ios"`、`clientUserMessageId`（UUID，与 item 通知中的 clientId 对应）、`summary:"detailed"`。
3. **标题自动生成**：每个新 thread 配一个 ephemeral 子会话（`threadSource:"thread_title"`、gpt-5.4-mini、outputSchema 限 title 36 字符）。
4. **手机会改本机配置**：`config/batchWrite`（model、model_reasoning_effort、approval_policy）——切任务设置时直接写 config.toml。
5. **queue 语义**：只入队（`thread/queue/add`），消费由被控端自动完成；`thread/settings/update` 在入队前同步当前设置。
6. **文件浏览**：`fs/getMetadata` + `fs/readDirectory`（无专门目录树 API）。
7. **LLM 流量与控制面分离**：workspace routing 校验通过后，responses 流量直连 chatgpt.com（不经过 wham WS）。bridge 只需实现控制面。
8. **workspace routing 陷阱**：accounts/check 返回 `workspace_backend_origin:"NO_CONSTRAINT"` 时，codex 兜底校验本地 `chatgpt_base_url` 必须 HTTPS —— 本地 mock/代理必须改写该字段为合法 origin。

## ZCode 映射（更新）

| codex 方法 | ZCode 侧 | 备注 |
|---|---|---|
| initialize | bridge 常量响应（userAgent/codexHome/platform） | |
| thread/start / resume | createSession / resumeSession | cwd、model、sandbox 需映射 |
| turn/start | v4 conversation sendText | clientUserMessageId ↔ clientId |
| turn/interrupt | v4 中断通道 | |
| turn/steer | v4 steer 或 插队消息 | ZCode 无原生 steer 需评估 |
| thread/queue/add | bridge 自实现队列 | codex 自动消费 |
| thread/list / turns/list / items/list | ZCode 会话列表/历史 | 分页 cursor 语义需适配 |
| fs/readDirectory / getMetadata | bridge 本机直读 | |
| process/spawn | bridge 实现（带 sandbox 策略） | 手机端大量依赖 |
| thread/compact/start | ZCode compact | |
| collaborationMode(plan/default) | ZCode permission mode 映射 | |
| config/read / batchWrite | bridge 管理（不透传 ZCode） | |
| skills/list / plugin/installed / model/list / collaborationMode/list | bridge 聚合 | |
