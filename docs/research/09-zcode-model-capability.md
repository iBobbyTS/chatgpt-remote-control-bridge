# 09 · zcode app-server 模型能力探测：三级模型控制与 Provider Registry 注入

日期：2026-09-27 · 状态：✅ 静态反解 + 本机动态探测 + 真实 glm-5.3 / glm-5.3-flash 调用验证

> 探测对象：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（`zcode 0.16.9`，
> ZCode Protocol v1）。动机：zcode agent 接入（COV-ZCODE）前的能力探测——旧项目
> （zcode-mcp / external-subagent）中 app-server 只能用 `~/.zcode/cli/config.json` 的
> `model.main` / `model.lite`，本文回答"app-server 能否设置模型"及完整调用形态。

## TL;DR

1. **协议原生支持三级模型控制**：`session/create` 初始模型、`session/setModel` 会话级切换、
   `session/send.modelSelection` 单轮覆盖（粘性——覆盖后 session.model 也变）。
   另有 `session/setThoughtLevel`（推理档位，按模型校验）与 `session/setMode`。
2. **"只能用 main/lite"是默认路径现象，不是协议限制**：裸 spawn 的 app-server 里 OAuth
   账号 provider（`account:zai-*`，GUI 会话用的那套）不物化，registry 只剩
   `~/.zcode/v2/provider_config.json` 里的个人 API-key provider（本机为 deepseek），
   此时 glm 系列全部报「Provider Registry 中不存在 Model」。
3. **打通路径 = spawn 时注入三个环境变量**（builtin/personal provider 配置文件 + 数据根），
   personal 规则文件按 `zai-api` 模板注册 coding-plan anthropic key 后：
   `settings.model.available = ["zai/GLM-5.3","zai/GLM-5.3-Flash"]`，setModel 全部成功，
   真实调用验证通过（turn.terminal success，消息元数据模型标注随切换变化）。
4. 老项目"zcode 拒绝模型选择"是它们的产品层 fail-closed 决策；其记录的默认模型
   `zai/glm-5.3` 来自当时的机器状态（v2 个人配置尚无 deepseek 条目），非协议行为差异。

## 协议面（模型相关）

### 传输帧（与 codex JSON-RPC 不同）

- 换行分隔 JSON，**无 jsonrpc 信封**：请求 `{id, method, params}`、响应 `{id, result}` /
  `{id, error}`、通知 `{method, params}`。带 `"jsonrpc"` 键直接报 `Invalid ZCode Protocol
  message`（zod strict union，@-32600）。
- **无 initialize 握手**：直接发请求即可（`initialize` 返回 Method not found）。
- **服务器反向请求必须应答**，否则挂起/超时：
  - `session/requestRuntimePreferences`（scope `runtime-materialization`，**15s 超时**，
    不答则 session/create 失败 -32022）。应答形状：
    `{nativeSearchEnhancementsEnabled, memoryEnabled=false, askUserQuestionAutoResolutionEnabled=true,
    modelContextBudgetStrategy:"preflight-v1"}`；
  - `interaction/requestOfficialMcpAuthHeaders`（官方插件 MCP 鉴权头，`{}` 即可放行）。
- `runtime/capabilities` 可探活（返回 `{independentPlanState:true}`）。

### 模型控制的三个层级

模型选择对象统一形状（zod strict）：

```json
{ "providerId": "zai", "modelId": "GLM-5.3", "options": { "reasoningLevel": "high" } }
```

| 层级 | 方法 | 参数要点 | 实测 |
| --- | --- | --- | --- |
| 会话初始 | `session/create` | `model` / `thoughtLevel` / `mode` / `toolAllowlist` / `toolDenylist` / `mcpServers` 均可选 | ✅ |
| 会话级切换 | `session/setModel` | `{sessionId, model, expectedRevision?, persistAsWorkspaceLastUsed=true}`；成功广播 model_changed | ✅ read 回读即新模型 |
| 单轮覆盖 | `session/send` | `{sessionId, content, modelSelection?, ...}` | ✅ **粘性**：turn 用覆盖模型，session.model 也随之变 |
| 推理档位 | `session/setThoughtLevel` | `{sessionId, thoughtLevel}` | ✅ GLM：low/high/max，**无 medium**（报 Unsupported reasoning effort） |

注意：
- 模型对象**必须带 `options.reasoningLevel`**（GLM 系列必填；漏了报
  「Reasoning level is required for zai/GLM-5.3」）。
- 模型清单**无需专用 list 方法**：`session/create` / `session/read` 结果的
  `settings.model.available[]` 直接给出全部可用模型（含 ref、contextWindow、reasoning
  levels、defaultLevel、输入输出模态），`settings.model.current/lastUsed` 给当前/最近。
- registry 是**白名单制**：模板没有的模型（如 GLM-5.1、glm-4.7）报
  「Provider Registry 中不存在 Model: zai/GLM-5.1」；provider 不存在同文案
  （对象参数时会打成 `[object Object]`，bundle 内已知瑕疵）。
- 同 session 并发 prompt 拒绝：-32010「A prompt is already running for this session」。

### session/create 结果骨架（模型相关摘录）

```json
{
  "session": { "sessionId": "sess_…", "mode": "build",
               "model": { "providerId": "zai", "modelId": "GLM-5.3" }, … },
  "settings": {
    "model": {
      "available": [ { "ref": { "providerId": "zai", "modelId": "GLM-5.3" },
                       "label": "GLM-5.3", "contextWindow": 1000000,
                       "reasoning": { "levels": [...], "defaultLevel": "max" }, … } ],
      "current": { "providerId": "zai", "modelId": "GLM-5.3", "options": { "reasoningLevel": "max" } },
      "lastUsed": { … } },
    "thoughtLevel": { "available": [...], "current": "max", "enabled": true }
  }
}
```

### 事件流

- `session/event`（通知）：`step-start` / `reasoning` / `text` / `step-finish` /
  `state.updated` / `timeline` —— 内容流。
- `v4/telemetry/event`（通知）：`turn.started` / `turn.terminal`（`status:"success"`、
  `durationMs`、`tokenCount`、`toolCallCount`）—— **turn 生命周期判定看这里**。
- `session/send` 响应仅 `{accepted:true, sessionId, stateRevision}`（受理而非完成）。
- 消息元数据（session/read 的 `messages[].info`）带 `model.providerId/modelId` 与
  `finish`——**模型切换生效与否以消息级标注为准**。

## Provider Registry 真相链（探测过程）

zcode 的 provider 配置有**两套体系**，这是全部困惑的根源：

| 体系 | 位置 | 用途 |
| --- | --- | --- |
| legacy CLI 面 | `~/.zcode/cli/config.json`（`provider.zai.models`、`model.main/lite`） | CLI headless（`zcode -p`）路径；**app-server 面不依赖它选模型** |
| GUI/app-server 面 | `~/.zcode/v2/`：`provider_config.json`（个人 provider 规则）、`credentials.json`（OAuth/账号凭证）、`setting.json`（family mode 等）、`coding-plan-cache.json`（套餐 entitlement）、`runtime/provider/…/zcode-builtin.json`（模板缓存） | GUI 会话与 app-server 的 registry 来源 |

探测逐轮事实：

1. **裸 spawn**（`node zcode.cjs app-server`，不设 env，真实 HOME）：create 不带 model 成功，
   但 `settings.model.available = ["deepseek/deepseek-flash"]`（v2 个人 provider），
   `zai/glm-5.3`、`zai/glm-5.3-flash`、`account:zai-individual-coding-plan/GLM-5.3` 全部
   「不存在 Model」→ **OAuth 账号 provider 在无头进程不物化**（GUI 里它才是正主，
   本会话即 `account:zai-individual-coding-plan/GLM-5.3`）。
   `~/.zcode/cli/config.json` 里的 glm-5.1/glm-4.7 条目是残留（GUI 实配只有 5.3/Flash），
   也不会进 registry。
2. **HOME 重定向实验**（拷贝 v2 状态到临时 HOME，改 `provider_config.json` 加 zai-api
   个人规则）：失败。换 providerId（myzai）、去掉 setting.json、access 类型换普通
   `api-key` 三种变体均不物化——同文件内 deepseek 规则始终正常，说明文件被读但 zai
   规则在该组装路径被丢弃（与 builtin 模板缓存/family 判定有关，未再深挖）。
3. **env 注入路径**（bundle 反解发现 `prepareCliProviderRuntimeEnv`，`app-server`
   子命令在其白名单内）：

   ```
   ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=<builtin 模板文件>
   ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE=<同上（兜底）>
   ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=<bridge 自管个人规则>
   ZCODE_DATA_BASE_DIR=<隔离数据根（db/凭证）>
   ```

   builtin 用 App 内置 `/Applications/ZCode.app/Contents/Resources/config/provider/
   zcode-builtin.json`；personal 自建（`zai-api` 模板 + coding-plan anthropic key，
   key 即 legacy config 里那把）：

   ```json
   { "schemaVersion": 1, "config": {
       "providerOrder": ["zai"],
       "providerConfigRules": { "providerRules": [ {
           "providerId": "zai", "templateId": "zai-api", "providerName": "Z.ai Coding Plan",
           "config": { "group": "standard-personal",
                       "access": { "type": "zhipu-coding-plan-api-key", "apiKey": "…" },
                       "personalModelIds": [], "modelOrder": ["GLM-5.3", "GLM-5.3-Flash"] } } ] },
       "modelConfigRules": { "providerModelRules": [], "manualProviderModelRules": [] } } }
   ```

   结果：`available = ["zai/GLM-5.3","zai/GLM-5.3-Flash"]`，默认取 providerOrder[0]。

4. **真实验证**（真实 glm-5.3 / glm-5.3-flash 调用）：
   - setModel `zai/GLM-5.3`（reasoningLevel high）→ 成功；发「只回复三个字符：M3」→
     `turn.terminal success`（6.3s，22493 tokens，toolCallCount 0）。
   - setModel `zai/GLM-5.3-Flash`（high）→ 成功；同上 prompt → success（8.6s，22372
     tokens）；**read 回读消息元数据模型标注从 GLM-5.3 块变为 GLM-5.3-Flash 块**。
   - per-turn 覆盖隔离：会话级固定 GLM-5.3，`session/send` 带
     `modelSelection=GLM-5.3-Flash` → 该 turn 消息标注 Flash，但 turn 后
     `session.model` 也停在 Flash（**覆盖是粘性的，非临时**）。

## bridge（cgrcb）接入映射

| 手机端（codex 语义） | zcode 映射 |
| --- | --- |
| `model/list` | `session/create` / `session/read` 结果的 `settings.model.available` |
| `thread/model/set` | `session/setModel`（必须带 reasoningLevel；GLM 档位 low/high/max） |
| 模型 slug | `providerId/modelId` 串（如 `zai/GLM-5.3`）直接对齐 |
| 权限/审批类语义 | `mode`（create/setMode）+ 反向 `interaction/requestPermission`；按 AUD-011 边界，解释权归 agent |
| turn 完成判定 | `v4/telemetry/event` 的 `turn.terminal`（内容流走 `session/event`） |

接入要点：

- spawn zcode agent 进程时**注入上节三个 env**，personal 规则文件由 bridge 生成管理
  （从用户配置取 key），不碰用户 `~/.zcode/v2` 实文件；`ZCODE_DATA_BASE_DIR` 指到
  `~/.cgrcb/instances/zcode/` 之类的隔离目录。
- 模型控制因此**完全可开放给手机端**（不再局限于 main/lite）；但要向 available 清单
  对齐（白名单），zai-api 模板只有 GLM-5.3 / GLM-5.3-Flash，需要更多模型改用
  `zai-standard-api` 模板（openai-chat-completions 端点 `api.z.ai/api/paas/v4`，
  coding-plan key 兼容性未测）。
- 反向请求应答器是 app-server 客户端的必备组件（requestRuntimePreferences 15s
  超时 + requestOfficialMcpAuthHeaders）。

## 风险

- provider 配置 schema（`provider_config.json` / 三个 env 变量名）是**无公开文档的内部
  接口**（与 external-subagent 文档对 `plugins.dirs` 的告诫同级）；ZCode 升级可能变动，
  升级后应回归本文探测链路（脚本见下）。
- 裸 spawn 下 OAuth 账号 provider 不物化的根因未深挖（止步于"env 注入可绕开"）；
  若未来 zcode 支持 CLI 态账号 provider，可再评估直接复用 GUI 凭证。
- `[object Object]` 错误文案、modelSelection 粘性行为均为 0.16.9 实测事实，升级需复核。

## 证据与复现

- 探测脚本（全矩阵）：`.agent-work/tmp/zcode-model-probe/probe.mjs`
  （env 注入运行：设 `ZCODE_*` 三变量 + `ZCODE_DATA_BASE_DIR` 后直接跑）。
- per-turn 覆盖隔离：`.agent-work/tmp/zcode-model-probe/override.mjs`。
- 真实 glm 调用完整 transcript：`.agent-work/tmp/zcode-model-probe/probe-run-exp1.log`
  （`turn.terminal success` ×3、available/current 模型清单、消息级模型标注）。
- 静态反解依据：zcode.cjs 内 `session/setModel` 分发器与 zod schema
  （`vGt`/`Pu`/`nGt`/`fGt`）、`prepareCliProviderRuntimeEnv`（`dQi`）、
  `resolveNodeProviderRuntimePaths`（`ymr`）、Provider Registry 组装（`Ykt`）。
- 对照项目（用户旧项目）：`~/Projects/zcode-mcp`（external-subagent 原型）、
  `~/Projects/external-subagent`（zcode 兼容文档 `docs/compatibility/zcode.md`、
  fail-closed 模型策略）。
