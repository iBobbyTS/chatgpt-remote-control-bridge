# 08 · 正式化架构：cgrcb CLI + launchd 常驻服务

日期：2026-09-25 · 状态：✅ 已实现（S05）

本文记录研究脚本正式化为可安装、常驻服务后的架构（S01–S05 收口）。研究阶段背景见
docs/01–07；模拟层从研究入口 `src/sim/*` 迁入下游机制 `src/agents/sim/*`。

## 分层

```
手机 ChatGPT App ── wham 后端(chatgpt.com) ──WSS──▶ WhamTunnel（每实例一条）
                                                      │ JSON-RPC 信封
                                                      ▼
                                              AgentApp（下游实现）
                                        sim = 固定/程序化响应（不接 LLM）

cgrcb CLI ──▶ CgrcbDaemon ──▶ registry 延迟工厂 ──▶ AgentModule.createInstance
   │              │
   │              ├─ IPC(daemon.sock)  ← status/enable/disable/pair/agent-*/auth-reset
   └── launchd ───┘  com.cgrcb.bridge（登录自启 + KeepAlive）
```

- **上游模块**：`src/auth`（ChatGPT 登录/刷新/凭证）、`src/wham`（enroll/refresh、
  WSS 隧道、REST 客户端）。所有实例共用一次登录（`~/.cgrcb/home`）。
- **下游注册表**：`src/agents/registry.ts` 不静态 import 具体 agent；agent 模块自注册
  （sim：`src/agents/sim/index.ts`）。daemon 启动路径经注入点
  `registerAgents: () => import("../agents/sim/index.ts")` 触发注册。
- **守护进程**：`src/daemon/daemon.ts` 逐 enabled agent 建实例、单实例故障隔离 + 退避重启、
  SIGTERM/SIGINT 优雅停；`src/daemon/ipc.ts` unix socket 单行 JSON 协议 + 单实例锁。
- **CLI**：`src/cli/main.ts`（零依赖手写路由）——顶层服务管理 / `chatgpt` 上游 /
  `serving-agent <agent>` 下游。
- **常驻**：`src/daemon/launchd.ts` 生成 `~/Library/LaunchAgents/com.cgrcb.bridge.plist`
  （绝对 node + dist 入口 `ProgramArguments`、RunAtLoad/KeepAlive、日志到 `logs/`），
  launchctl 命令序列为纯函数（可单测）。

## 数据布局（`CGRCB_HOME` 覆盖，默认 `~/.cgrcb`）

见根 README「数据目录」；关键文件：`config.json`、`home/auth.json`、
`instances/<agent>/{installation_id,state.json,enrollment.json,pairing.json,lifecycle.json}`、
`daemon.sock`(+`.lock`)、`logs/`。

## 关键语义（正式化新增）

- **开关语义**：enable = 建实例 + 幂等自动播种 + 自动配对；disable = 停发码 → 停隧道 →
  定位 environment_id → 账号鉴权吊销全部 clients（复核收敛≤3 轮）；无从定位时按
  lifecycle.json 判定，绝不 fresh-enroll 伪造成功。
- **三层 reset**：`chatgpt reset`（账号凭证）、`sim reset`（会话库预设态）、实例身份/配对
  互不越界。
- **跨进程 auth 提交锁**（`src/auth/store.ts`）：`O_EXCL` 锁文件 `auth.lock`（pid + 心跳 mtime）。
  陈旧回收与释放采用 **rename-steal**：`rename(lock, lock.reclaim-<uniq>)` 原子抢占，成功者
  重读偷得文件确认确属陈旧（死 pid/心跳过期）才删，实为活锁则还原重试；释放同协议
  （偷到且 owner 匹配才删），无 read→rm TOCTOU。持有者侧 `guard.assertOwner()` 在提交前
  重读校验，失主即**中止提交**（刷新丢弃 lock-lost、删除报错可重试），静默破坏变可检测安全失败。
  登录写入、reset 删除、刷新提交三类共用；网络刷新在锁外、仅提交段持锁并重读校验——已删除/
  已替换（新登录）/失锁则丢弃写回。daemon 的 `auth-reset` 先停 autoRefresh → flush 在途刷新 →
  持锁删除（finally 恢复巡检）。
- **构建/交付**：`tsconfig.build.json` emit（`rewriteRelativeImportExtensions` 处理 `.ts`
  导入说明符；blueprint JSON 随 tsc 复制到 dist）；`bin.cgrcb → dist/cli/main.js`；
  dist 白名单只含交付面，研究工具（wham proxy/probe-cli/mockServer/cli、旧 auth CLI）排除。

## 验证

`npm run typecheck && npm test && npm run build` 全绿；launchd 行为以 plist 快照 +
launchctl 命令序列单测覆盖，真机手动验证见 HANDOFF AC5 记录。
