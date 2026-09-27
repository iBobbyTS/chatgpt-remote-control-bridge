/**
 * sim 特殊指令识别与线程命名（从 appServer.ts 拆出，AUD-009）。
 *
 * - 特殊指令：手机端发送 help / test steer / test queue 即得固定模拟行为。
 * - 标题命名：识别手机的任务标题生成 turn（turnTrigger=remote_ios +
 *   outputSchema{title}）并按「自动命名：{请求前5码点}」模板应答。
 */

/** 特殊指令帮助文本（手机端发送对应指令即得本条回复）。 */
export const HELP_TEXT = [
  "特殊指令：",
  "help: 输出本条帮助信息",
  'test steer：服务器会返回3次消息，中间使用模拟命令"wait 15 seconds"（不依赖shell），可以测试steer强制插入消息的效果；期间steer发送stop会在当前步骤结束后停止脚本。',
  'test queue：服务器会返回3次消息，中间使用模拟命令"wait 15 seconds"（不依赖shell），可以测试queue排队消息的效果。',
  "",
  "模拟功能（对齐 codex）：",
  "goal 启用后自动续跑共4个goal turn（每个=1次模拟wait+1条输出；第2个turn的wait为30秒、其余10秒）：前3个后标记blocked，再次启动第4个后标记complete；turn运行中发消息会steer插入当前turn，停止/中止只结束当前turn、goal仍自动续跑，中止后排队消息不会自动开跑",
  "compact 约 5 秒完成且下一条回复标记",
  "Plan 模式回复带前缀",
  "shell 命令生成模拟命令条目",
  "branch 经 thread/metadata/update 设置、fork 复制历史",
  "消息含 $技能名 会确认加载",
].join("\n");

/** 特殊指令识别：trim + 大小写不敏感的完全匹配。 */
export function specialCommandOf(userText: string): "help" | "test-steer" | "test-queue" | null {
  const t = userText.trim().toLowerCase();
  if (t === "help") return "help";
  if (t === "test steer") return "test-steer";
  if (t === "test queue") return "test-queue";
  return null;
}

/**
 * 识别手机的任务标题生成 turn（turnTrigger=remote_ios + outputSchema{title}）：
 * 手机用 LLM 为用户消息生成 ≤36 字符的 UI 标题，期待 agentMessage 文本为符合
 * schema 的 JSON（{"title":"…"}）。2026-09-26 真机复现：该 turn 被当普通消息
 * 回复长文本（非 JSON）→ 手机 outputSchema 解析失败 → UI 渲染冻结 + 30s 重连
 * 循环（docs/research/07-sim-layer.md）。返回 title.maxLength（无则 36）；非
 * 标题 turn 返回 null。
 */
export function titleSchemaOf(p: Record<string, any>): number | null {
  const schema = p.outputSchema;
  if (typeof schema !== "object" || schema === null) return null;
  const props = (schema as { properties?: unknown }).properties;
  const title = typeof props === "object" && props !== null
    ? (props as Record<string, unknown>).title
    : undefined;
  if (typeof title !== "object" || title === null) return null;
  const max = (title as { maxLength?: unknown }).maxLength;
  if (typeof max === "number" && Number.isFinite(max) && max > 0) return max;
  return 36;
}

/** 自动命名模板前缀；命名格式为「自动命名：{用户请求的前5个字符}」。 */
export const AUTO_NAME_PREFIX = "自动命名：";

/** 请求文本前 5 个 Unicode 码点（Array.from 防止拆代理对），去尾随空白。 */
export function firstFiveChars(request: string): string {
  return Array.from(request).slice(0, 5).join("").trimEnd();
}

/**
 * 标题生成 turn 的自动命名：从 prompt 尾部 "User prompt:\n<msg>" 提取用户请求
 * （单行化、去引号），命名「自动命名：<请求前5码点>」。真机帧证据
 * （2026-09-27）：手机拿本 turn 的 JSON 输出回填 thread/name/set（title JSON
 * 完成于 name/set 之前 ~0.5s）——线程名完全由此模板决定，故超长请求不再
 * 回显整段；末尾按 schema maxLength 码点截断保契约（36 时恒不触发）。
 */
export function titleForPrompt(prompt: string, maxLength: number): string {
  const marker = "User prompt:";
  const idx = prompt.lastIndexOf(marker);
  const raw = idx >= 0 ? prompt.slice(idx + marker.length) : prompt;
  const request = raw.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "") || "Task";
  const title = AUTO_NAME_PREFIX + firstFiveChars(request);
  const cps = Array.from(title);
  return cps.length > maxLength ? cps.slice(0, maxLength).join("") : title;
}
