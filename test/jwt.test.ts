import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeTestJwt,
  parseIdTokenInfo,
  parseJwtExpiration,
} from "../src/auth/jwt.ts";

// 与 codex model-provider/src/auth.rs:372 的测试 token 同构
const ID_TOKEN = makeTestJwt({
  email: "user@example.com",
  email_verified: true,
  "https://api.openai.com/auth": {
    chatgpt_user_id: "user-12345",
    user_id: "user-12345",
    chatgpt_plan_type: "pro",
    chatgpt_account_id: "account-123",
    chatgpt_account_is_fedramp: false,
  },
});

test("parseIdTokenInfo 提取 email/plan/account claims", () => {
  const info = parseIdTokenInfo(ID_TOKEN);
  assert.equal(info.email, "user@example.com");
  assert.equal(info.chatgptPlanType, "pro");
  assert.equal(info.chatgptUserId, "user-12345");
  assert.equal(info.chatgptAccountId, "account-123");
  assert.equal(info.chatgptAccountIsFedramp, false);
  assert.equal(info.rawJwt, ID_TOKEN);
});

test("parseIdTokenInfo 容忍缺失 auth claims（token_data.rs None 分支）", () => {
  const info = parseIdTokenInfo(makeTestJwt({ email: "a@b.c" }));
  assert.equal(info.email, "a@b.c");
  assert.equal(info.chatgptPlanType, null);
  assert.equal(info.chatgptAccountId, null);
});

test("parseJwtExpiration 返回 exp；无 exp 返回 null", () => {
  const withExp = makeTestJwt({ exp: 1893456000 });
  assert.equal(parseJwtExpiration(withExp)?.getTime(), 1893456000 * 1000);
  assert.equal(parseJwtExpiration(ID_TOKEN), null);
});

test("parseIdTokenInfo 拒绝非 JWT 形状", () => {
  assert.throws(() => parseIdTokenInfo("not-a-jwt"));
});
