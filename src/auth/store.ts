/**
 * auth.json 持久化（对齐 codex-rs/login/src/auth/storage.rs 的 AuthDotJson 格式）。
 *
 * 文件位于 <codexHome>/auth.json，权限 600，原子写入。
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseIdTokenInfo, type IdTokenInfo } from "./jwt.ts";

export interface TokenData {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string | null;
}

/** codex auth.json 顶层结构（serde camelCase/snake_case 按 codex 实际字段名）。 */
export interface AuthDotJson {
  auth_mode: "chatgpt" | "apikey";
  openai_api_key: string | null;
  tokens: TokenData | null;
  last_refresh: string | null;
}

export function authJsonPath(codexHome: string): string {
  return join(codexHome, "auth.json");
}

export async function readAuthStore(
  codexHome: string,
): Promise<AuthDotJson | null> {
  const path = authJsonPath(codexHome);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as AuthDotJson;
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${err}`);
  }
}

export async function writeAuthStore(
  codexHome: string,
  auth: AuthDotJson,
): Promise<void> {
  const path = authJsonPath(codexHome);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function deleteAuthStore(codexHome: string): Promise<boolean> {
  const path = authJsonPath(codexHome);
  try {
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

/** id_token claims + account_id 的组合视图（登录与刷新后都会用到）。 */
export function describeTokens(tokens: TokenData): {
  idTokenInfo: IdTokenInfo;
  accountId: string | null;
} {
  const idTokenInfo = parseIdTokenInfo(tokens.id_token);
  return {
    idTokenInfo,
    accountId: idTokenInfo.chatgptAccountId ?? tokens.account_id ?? null,
  };
}
