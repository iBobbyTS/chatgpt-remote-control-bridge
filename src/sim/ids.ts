/**
 * ID 生成：对齐 codex 的视觉形状。
 * - thread/turn/item id：UUID v7（时间戳前缀，如 01a0da05-…）
 * - agentMessage id：`msg_` + 48 hex
 */
import { randomBytes, randomUUID } from "node:crypto";

/** UUID v7（unix 毫秒 48bit 大端 + ver7 + rand），与 codex thread/turn id 同形状。 */
export function uuidv7(): string {
  const ms = Date.now();
  const bytes = randomBytes(16);
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = ((bytes[6]! & 0x0f) | 0x70) as number;
  bytes[7] = ((bytes[7]! & 0x3f) | 0x80) as number;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** agentMessage/item id（codex 形状：msg_ + 48 hex）。 */
export function simMsgId(): string {
  return `msg_${randomBytes(24).toString("hex")}`;
}

export { randomUUID };
