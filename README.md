# chatgpt-remote-control-bridge（cgrcb）

把本机桥接到 codex 的 ChatGPT 远程控制后端（wham），让 ChatGPT 手机 App 把一个
**下游 serving-agent** 当成远程 computer instance 来使用。当前交付下游为 `sim`
（调试用：不接 LLM，按固定/程序化响应对答）。

- 上游（本仓库实现）：codex 同款 ChatGPT 登录、enroll/refresh、WSS 隧道、配对与吊销。
- 下游（serving-agent）：可插拔 agent 模块（`src/agents/registry.ts`），每实例独立
  installation_id / enrollment / 会话库，互不影响。
- 常驻：macOS launchd 登录自启 + 崩溃自动拉起；CLI `cgrcb` 统一管理。

> 平台：macOS（launchd）；Node.js ≥ 22。

## 安装与使用

### 1. 构建并全局安装

```bash
git clone <repo> && cd chatgpt-remote-control-bridge
npm install
npm run build            # 必须先构建：npm 不从源码自动产出 dist
npm install -g .         # 安装 cgrcb 命令（private:true 不阻止本地路径安装）
cgrcb --help
```

> 全局安装前**必须先 `npm run build`**：包只分发 `dist/`（见 `files`），
> `npm install -g .` 不会替你编译 TypeScript。

也可以不全局安装，直接用 `node dist/cli/main.js <命令>`。

### 2. 登录 ChatGPT（上游凭证）

```bash
cgrcb chatgpt login      # 打开浏览器完成 OAuth PKCE 登录
cgrcb chatgpt status
```

凭证存于 `~/.cgrcb/home/auth.json`（bridge 自有目录，**绝不读写 `~/.codex`**）。
所有下游实例共用这一次登录。

### 3. 安装并启动常驻服务（launchd）

```bash
cgrcb install            # 写 ~/Library/LaunchAgents/com.cgrcb.bridge.plist 并 bootstrap（幂等刷新）
cgrcb status             # launchd + daemon + 登录 + 各 agent 状态汇总
```

`install` 生成的 plist 用**绝对 node 解释器路径 + dist 入口绝对路径**作为
`ProgramArguments`（不依赖受限 PATH 下的 shebang），`RunAtLoad`+`KeepAlive` 保证
登录自启与崩溃拉起，日志写到 `~/.cgrcb/logs/`。

服务管理：

```bash
cgrcb start              # 启动（未加载先 bootstrap 再 kickstart）
cgrcb stop               # 停止（bootout）
cgrcb restart            # 重启
cgrcb uninstall          # 停止并删除 plist
```

### 4. 启用下游并配对手机

```bash
cgrcb serving-agent sim enable   # 上线实例 + 自动初始化会话库 + 打印配对码
```

在 ChatGPT 手机 App 中输入该配对码即可连接；看到初始会话「模拟会话：桥接链路验证」
后，所有问答都会持久化到 `~/.cgrcb/instances/sim/state.json`。

```bash
cgrcb serving-agent sim status   # 状态、配对码、已配对客户端（经 daemon 实时查询）
cgrcb serving-agent sim pair     # 追加配对码（支持多设备，无上限）
```

### 5. 关闭 / 重置 / 卸载

```bash
cgrcb serving-agent sim disable  # 下线实例并吊销该实例全部已配对客户端（会话库保留）
cgrcb serving-agent sim reset    # 仅把会话库重置为预设演示状态（不碰身份/配对）
cgrcb chatgpt reset              # 仅重置账号（删除登录凭证；≡ logout）；下游数据不动
cgrcb uninstall                  # 卸载服务（数据保留在 ~/.cgrcb）
```

reset/logout 在 daemon 运行时经 IPC 由 daemon 执行：停自动刷新 → 等待在途刷新收敛 →
持锁删除凭证；daemon 未运行时由 CLI 直接持锁删除。

## 命令参考

| 命令 | 说明 |
| --- | --- |
| `cgrcb install / uninstall / start / stop / restart` | launchd 服务生命周期 |
| `cgrcb status [--json]` | 服务与 daemon 汇总；daemon 未运行时降级显示静态信息 |
| `cgrcb daemon` | 前台运行 daemon（launchd 内部调用） |
| `cgrcb chatgpt login [--no-browser] [--json]` | 浏览器登录 |
| `cgrcb chatgpt status [--json]` | 登录状态 |
| `cgrcb chatgpt reset` / `logout` | 删除登录凭证（等价） |
| `cgrcb serving-agent <agent> init\|reset\|enable\|disable\|pair\|status [--json]` | 下游操作 |

退出码：`0` 成功、`1` 一般错误、`2` 用法错误；诊断走 stderr，stdout 只放结果。

## 数据目录（`~/.cgrcb`，可用 `CGRCB_HOME` 覆盖）

```
~/.cgrcb/
  config.json                 守护进程配置（各 agent 开关）
  home/auth.json              上游登录凭证
  instances/<agent>/          每实例目录：
      installation_id         上游身份（enroll/refresh/REST/WSS 同源）
      state.json              agent 自有状态（sim 会话库）
      enrollment.json         server_id/environment_id/token
      pairing.json            配对 pending
      lifecycle.json          {everEnrolled}
  daemon.sock                 本地 IPC socket
  daemon.sock.lock            单实例互斥锁（勿手写/勿删）
  logs/                       launchd stdout/stderr 日志
```

## 故障排查

- **`daemon 已在运行`**：`daemon.sock.lock` 表示已有 daemon 持有单实例锁。正常停止
  daemon 会自动释放；**不要手写或删除该锁**（内容为 `{pid,startedAt,owner}`，daemon
  存活时锁必须存在）。若确因异常残留（持有进程已死），daemon 启动时会自动回收陈旧锁。
- **`daemon.sock 路径过长`**：macOS unix socket 的 `sun_path` 上限约 100 字节。
  `CGRCB_HOME` 指到过深的目录会超限；请使用较短的路径。
- **launchd 拉起失败**：查看 `~/.cgrcb/logs/cgrcb.err.log`。plist 已固定绝对 node
  路径，故不受 launchd 受限 PATH 影响；若更换 node 安装位置，重新 `cgrcb install`。
- **daemon 未运行**：`serving-agent enable/disable/pair` 需要 daemon；`init/reset`
  支持离线（直接操作 `state.json`），`status` 降级显示静态信息。先 `cgrcb start`。
- **未登录**：`enable` 返回未登录提示，先 `cgrcb chatgpt login`。

## 开发

```bash
npm run typecheck
npm test                 # node:test + tsx，直跑 src，不依赖 build
npm run build            # tsc -p tsconfig.build.json（dist 白名单只含交付面）
```

研究工具（`src/wham/proxy.ts`、`probe-cli.ts`、`mockServer.ts`、`src/wham/cli.ts`、
旧 `src/cli.ts`）仅供开发，不进 dist 交付物。架构正式化记录见
`docs/research/08-formalization.md`。
