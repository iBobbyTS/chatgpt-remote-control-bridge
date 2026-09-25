# Bridge 集成路径评估

> 目标架构：ChatGPT 手机 App →（借用 codex 的 wham 服务器）→ 本地 bridge（伪装 codex 环境）→ ZCode
> 候选路径：① 通过 ZCode 的 app-server/CLI；② 通过 ZCode 自己的手机远控功能（`zcode.z.ai/remote/v4`，本地起服务逆向其 API 再转发到 codex 后端）

## 结论

- **路径 1 ✅ 推荐**：ZCode 的 headless 形态（`@zcode/server` / CLI）全部开源、官方支持、协议零逆向。
- **路径 2 ❌ 否决**：手机远控的关键三件（云端 relay、手机 Web UI、本地 relay 客户端）闭源；`hash` 签名算法需反编译；v3→v4 已证明协议随版本变动；且依赖 zcode.z.ai 在线 + 桌面版 ZCode 常驻运行。相对路径 1 没有任何本地权限优势。

## 推荐架构（三明治）

```
ChatGPT 手机 App
   ⇅ （ChatGPT App ⇄ chatgpt.com wham 服务，原样借用，不动）
bridge 进程（伪装成 codex 环境）
   ├─ 上行：wham 客户端
   │    enroll / pair / pair-status / refresh + wss 隧道
   │    可靠性照抄 codex-rs/app-server-transport/src/transport/remote_control/：
   │    seq_id-ack、cursor 断线续传、base64 分片、ping/pong、retry-after
   ├─ 中间：codex app-server JSON-RPC 适配层（实现手机实际调用的方法子集）
   │    方法全集见 codex-rs/app-server-protocol/src/protocol/common.rs（thread/* 系列）
   └─ 下行：ZCode 驱动层
        @zcode/rpc ChannelClient → zcode-server(localhost:3030)/ws（web-remote-replayable）
        → IZCodeAgentService：helloConversationV4 → initializeConversationV4
          → subscribeConversationV4 + sendText 命令
```

上行实现二选一：

- **TS 重写** wham 客户端（协议在开源 Rust 代码中完全可见，语义可照抄）；
- 或**复用 Rust**：`app-server-transport` crate 独立可编译，fork codex 加一个"proxy 模式"，把隧道里的 JSON-RPC 帧转发给 TS bridge 而不是内部 core——省去重写重连/分片/ack 逻辑，代价是要跟 codex 版本。

## 映射关系（适配层设计要点）

| codex 概念 | ZCode 对应 | 备注 |
| --- | --- | --- |
| `thread/start` / `thread/resume` | `createSession` / `resumeSession` | thread id ↔ sessionId 映射表 |
| `sendUserTurn`（用户输入） | v4 `sendText` 命令 | |
| turn item 事件流（item/started、delta、completed…） | v4 conversation rows/snapshot/delta 帧 | 事件模型差异大，是主要工作量 |
| `thread/list` / `thread/read` / `thread/items/list` | `listSessions` / `readSession` / v4 rows range | 手机 UI 历史列表 |
| `interrupt` | v4 interrupt 命令 | |
| 审批请求（applyPatch/execCommand approval，手机弹卡片） | headless permission broker 策略 | **语义差异最大**：codex 手机端期望服务端发起审批请求并等待应答；ZCode headless 默认策略自动决定。需让 ZCode 产生审批事件并映射为 codex 的 server→client 请求，否则手机上的 approve 按钮会落空 |
| `initialize`（clientInfo/capabilities） | `helloConversationV4` / `initializeConversationV4` | clientHello metadata 不能覆盖 connection mode/profile |

## 主要风险

1. **OpenAI ToS / 账号风险**：伪装 codex 客户端连 chatgpt.com 后端属于违反 ToS 的行为，存在账号处置风险。建议小号先行；wham 服务端可能校验客户端版本指纹（`installation_id`、build_info 等）。
2. **手机方法集未知**：协议全集很大，手机实际调用序列只能实测（见下一步 ①）。
3. **审批语义**：见上表最后两行。
4. **ZCode 凭据**：zcode-server 需要已登录的 Z.ai 账号（OAuth，`packages/services/src/oauth/`；桌面版已登录则凭据在本地存储）。
5. **协议漂移**：codex main 分支演进快（本仓库 commit 时点 CHANGELOG 顶部即 Unreleased）；ZCode 远控 URL 已从 v3 迭代到 v4（但 bridge 不依赖 ZCode 远控，不受此影响）。

## 下一步（按序）

1. **协议实证**：本机跑真的 `codex remote-control start` + 手机配对，开 debug 日志记录 app-server 收到的完整 JSON-RPC 调用/通知序列（idle、建任务、发消息、审批、历史列表各阶段）→ 产出适配层需求清单。
2. **本地 mock wham 服务**：利用 `remote_control_url` 允许 localhost 的口子（`protocol.rs:197-271`），实现 enroll/pair/wss 的最小 mock，作为 bridge 上行层的离线测试床。
3. **MVP**：wham 客户端（enroll + 隧道跑通）→ zcode-server 起服 + ChannelClient 连通 → 最小方法集（`initialize`、`thread/start`、sendUserTurn、事件通知单向映射）。
4. **补全**：审批双向映射、历史列表、interrupt、重连场景（用 mock wham 模拟断线）。
