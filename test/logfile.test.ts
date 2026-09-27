/**
 * 有界日志维护单测（AUD-002/AUD-010 回归）：rename 轮转（单代 .1）与原地截断。
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, after } from "node:test";
import {
  rotateLogIfLarge,
  truncateLogIfLarge,
} from "../src/wham/logfile.ts";

const cleanupDirs: string[] = [];
after(async () => {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), ".agent-work", "tmp", "logfile-tests-"));
  cleanupDirs.push(dir);
  return dir;
}

test("rotateLogIfLarge：不存在 → absent；未超限 → kept；超限 → rotated 且单代保留", async () => {
  const dir = await tempDir();
  const path = join(dir, "frames.jsonl");

  assert.equal(await rotateLogIfLarge(path), "absent");

  await writeFile(path, "small");
  assert.equal(await rotateLogIfLarge(path, { capBytes: 1024 }), "kept");

  await writeFile(path, "x".repeat(10));
  await writeFile(`${path}.1`, "old-generation");
  assert.equal(await rotateLogIfLarge(path, { capBytes: 4 }), "rotated");
  assert.equal(await readFile(`${path}.1`, "utf8"), "x".repeat(10), "超限内容应轮转为 .1（旧代被覆盖）");
  assert.equal(
    await stat(path).then(
      () => true,
      () => false,
    ),
    false,
    "轮转后原路径暂无（下次 append 重建）",
  );
});

test("rotateLogIfLarge：mode 选项顺带收敛历史权限（0755 → 0600）", async () => {
  const dir = await tempDir();
  const path = join(dir, "frames.jsonl");
  await writeFile(path, "legacy");
  await chmod(path, 0o755);
  assert.equal(await rotateLogIfLarge(path, { mode: 0o600 }), "kept");
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, `权限应收敛为 0600，实际 ${mode.toString(8)}`);
});

test("truncateLogIfLarge：不存在 → absent；未超限 → kept；超限 → 截断为 0", async () => {
  const dir = await tempDir();
  const path = join(dir, "cgrcb.err.log");

  assert.equal(await truncateLogIfLarge(path), "absent");

  await writeFile(path, "small");
  assert.equal(await truncateLogIfLarge(path, 1024), "kept");
  assert.equal((await stat(path)).size, 5);

  await writeFile(path, "y".repeat(100));
  assert.equal(await truncateLogIfLarge(path, 10), "truncated");
  assert.equal((await stat(path)).size, 0);
});
