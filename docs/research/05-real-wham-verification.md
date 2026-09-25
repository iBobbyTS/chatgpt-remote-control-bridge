# 05 · 真实 wham 后端验证（端到端闭环）

日期：2026-09-25 · 延续 [04-codex-probe-results.md](04-codex-probe-results.md)

## 结论：**"借用 codex 服务器远程控制本地"全链路打通 ✅**

手机 ChatGPT App → chatgpt.com wham → 本机 codex daemon（**bridge 自己登录的凭证**）→
真实 LLM → 回复回到手机。

实测证据（手机发送 "hi" 任务，本机 rollout
`~/.cache/cgc-bridge/sessions/2026/09/25/rollout-2026-09-25T12-26-12-*.jsonl`）：

- `session_meta`：`source=vscode`，`cwd=/Users/ibobby/Documents/Codex/2026-09-25/hi`
- 用户消息：`"hi"`；助手回复：`"Hi! What would you like to work on?"`
- `token_usage`：input 14370（cached 11008）——真实模型调用

## 各环节验证状态

| 环节 | 结果 | 说明 |
|---|---|---|
| bridge OAuth 登录（`src/auth/`） | ✅ | 浏览器登录 chatgpt 账号，凭证落 `var/codex-home` |
| 凭证被真实 wham 接受 | ✅ | curl 直接 enroll 返回 200，发放 server_id/environment_id/remote_control_token |
| free 计划资格 | ✅ | 免费计划可 enroll/pair/远控（无需 Plus/Pro） |
| codex daemon + bridge 凭证 → 真实 wham | ✅ | `remote-control start` 返回 `status:"connected"` |
| 手机配对 | ✅ | `remote-control pair` 产出短码（如 `39FH-VS7H`），手机输入后设备出现在 App |
| 手机 → 本机任务 | ✅ | "hi" 任务在本机创建会话并执行，回复回传手机 |

## 关键情报

1. **Cloudflare 拦 Node fetch（undici）TLS 指纹**：同一 token + 同一 UA，
   Node fetch 得到 CF JS challenge（403 "Enable JavaScript and cookies"），
   curl 200 通过。→ **bridge 的 REST 层（enroll/refresh/pair）必须走 curl 子进程**
   （或研究 undici 指纹伪装）。WS 出站是否被拦待测。
2. **手机端身份是 `vscode`**：rollout `session_meta.source=vscode`——手机 App 通过
   wham 下发的 clientInfo 伪装为 VS Code 客户端（`codex_vscode`）。
   bridge 模拟手机方向时不必伪装 vscode；伪装"被控端"时 clientInfo.name 影响不大。
3. **手机新建任务的目录约定**：`~/Documents/Codex/<yyyy-MM-dd>/<任务名>` 作为 cwd。
4. `codex remote-control pair` 短码有效期约 10 分钟（expiresAt unix 秒）。

## 复现步骤

```bash
# 1. 登录（bridge 自己的凭证，不碰 ~/.codex）
npm run auth -- login

# 2. 用短路径 CODEX_HOME 连真实 wham（首次复制凭证）
mkdir -p ~/.cache/cgc-bridge && cp var/codex-home/auth.json ~/.cache/cgc-bridge/
CODEX_HOME=~/.cache/cgc-bridge codex remote-control start --json   # connected
CODEX_HOME=~/.cache/cgc-bridge codex remote-control pair --json    # 手机输入短码

# 3. 手机 ChatGPT App → Codex → 新任务
```

注意：项目内路径做 CODEX_HOME 会因 unix socket 超 SUN_LEN(104) 失败，必须用短路径。

## 下一步

1. **捕获手机下发的真实方法序列**：本地 WS 反向代理（daemon 的
   `chatgpt_base_url` 指向本地，WS 帧逐条转发到真实 wham 并落盘）——拿到
   initialize/thread/start/turn/start 之外手机实际使用的完整方法集与参数，
   作为 bridge 适配 ZCode 的最终规格。
2. bridge 的 wham 客户端补 WS 出站（先验证 Node ws/wss 是否被 CF 拦，
   被拦则用 curl 子进程或 Rust helper）。
3. 之后按 [03-bridge-path-evaluation.md](03-bridge-path-evaluation.md) 接 ZCode 驱动层。
