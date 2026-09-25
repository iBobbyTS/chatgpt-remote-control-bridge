# 调查记录：ChatGPT 手机 App 远程控制 ZCode 的可行性

> 目标：把 ZCode 伪装成 Codex，借用 codex 的远程控制服务器（chatgpt.com wham），让 ChatGPT 手机 App 远程控制本机 ZCode。
> 本目录记录 bridge 项目启动前的全部源码调查结论。调查日期：2026-09-25。

## 参考源码版本

| 仓库 | 版本 | commit | 日期 | 说明 |
| --- | --- | --- | --- | --- |
| `reference/codex`（openai/codex） | main @ 开发版（无 release 号，CHANGELOG 顶部为 Unreleased；`codex-cli/package.json` 为 `0.0.0-dev`） | `f92655d07f40c9999915cd9244291ad3acfc2dca` | 2026-09-25 | Rust 实现（codex-rs）+ TS CLI（codex-cli） |
| `reference/ZCode`（z.ai ZCode） | `3.14.3`（package.json；与远控链接中 `app_version=3.14.3` 一致） | `29628c9acdb81b703bbd4080c207a0e7ce5e276e` | 2026-09-24 | pnpm monorepo，Node 24.14.0 / pnpm 10.33.2 |

## 文档索引

- [01-codex-remote-control.md](01-codex-remote-control.md) — codex 远程控制功能：是否开源、代码位置、协议细节
- [02-zcode-architecture.md](02-zcode-architecture.md) — ZCode 架构、可编程接口（app-server/CLI）、手机远控闭源证据
- [03-bridge-path-evaluation.md](03-bridge-path-evaluation.md) — 两条集成路径评估、推荐架构、风险与下一步
- [04-codex-probe-results.md](04-codex-probe-results.md) — mock wham 实测：codex 0.156.1 全链路打通（enroll/WS/双向 JSON-RPC/seq-ack），帧格式实证
- [05-real-wham-verification.md](05-real-wham-verification.md) — 真实 chatgpt.com wham 端到端闭环：bridge 凭证 enroll/手机配对/手机发任务本机执行并回复；CF 拦 Node fetch 的发现
- [06-mobile-scenarios.md](06-mobile-scenarios.md) — 12 场景实测：手机端全部 JSON-RPC 方法序列/参数/事件流实证（反向代理抓帧），ZCode 映射表
- [07-sim-layer.md](07-sim-layer.md) — 模拟层：桥直连真实 wham 扮演被控端，28 方法固定/模拟响应（不接 LLM），`npm run sim`

## 实现代码（探测阶段产出）

- `src/auth/` — codex 同款 ChatGPT 登录栈（OAuth PKCE + 本地回调 + auth.json 存储 +
  token 自动刷新/过期感知/重新登录），`npm run auth -- login|status|refresh|logout|headers`
- `src/wham/` — mock wham 服务器（REST enroll/refresh/pair + WS 隧道 + 模拟手机端脚本），
  `npm run wham -- --port 8787`；curl REST 客户端（enroll/refresh/pair）
- `src/sim/` — 模拟被控端（enroll→WSS→28 方法模拟响应），`npm run sim`
- 单测 24 项全绿：`npm test`

## 核心结论（TL;DR）

1. **codex 的"被控端"完整开源**：remote control 客户端（enroll/pair/websocket 隧道）+ 隧道内承载的 app-server JSON-RPC 协议都在 `codex-rs/app-server-transport` / `codex-rs/app-server-protocol` 中，协议对 bridge 完全可见。手机 App 与 chatgpt.com wham 服务端不开源。
2. **ZCode 的手机远控（`zcode.z.ai/remote/v4` 链接）关键部分闭源**：云端 relay、手机 Web UI、本地端连接 relay 的客户端均不在开源仓库中。逆向此通路成本高且不稳定（v3→v4 已迭代过）。
3. **ZCode 有官方 headless 可编程形态**：`@zcode/server`（bin 名 `zcode`）暴露 `/ws` WebSocket 上的 ChannelServer RPC，这正是网页版 UI 驱动 ZCode 的通道；`IZCodeAgentService` 接口面（createSession / v4 conversation 通道等）足以支撑 bridge 的全部需求。
4. **推荐路径 1**（zcode-server / CLI 驱动）+ 自研 wham 客户端，否决路径 2（逆向 ZCode relay）。
