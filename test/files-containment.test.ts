/**
 * fs/writeFile 路径收容单测（AUD-001 回归）。
 *
 * 矩阵覆盖：合法附件路径（含中文/空格/多段）、镜像路径折叠、各类 `..` 穿越
 * （附件分支 + 镜像分支整体 `..`）、空段（尾斜杠/双斜杠）、`.` 段与空相对路径。
 */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  ATTACHMENTS_DIR_PREFIX,
  PathEscapeError,
  resolveContainedSavePath,
} from "../src/agents/files.ts";

const FILES_DIR = "/data/cgrcb/files";

test("合法附件路径保留 <threadId>/<uuid>/<文件名> 层级（含中文/空格）", () => {
  const p = resolveContainedSavePath(
    FILES_DIR,
    `${ATTACHMENTS_DIR_PREFIX}tid-1/uuid-2/1-照片 备份.jpg`,
  );
  assert.equal(p, join(FILES_DIR, "tid-1", "uuid-2", "1-照片 备份.jpg"));
});

test("非附件绝对路径折叠为 mirror 单文件名", () => {
  const p = resolveContainedSavePath(FILES_DIR, "/etc/hosts");
  assert.equal(p, join(FILES_DIR, "mirror", "etc__hosts"));
});

test("附件分支 `..` 段一律拒绝", () => {
  for (const evil of [
    `${ATTACHMENTS_DIR_PREFIX}../escape.txt`,
    `${ATTACHMENTS_DIR_PREFIX}../../escape.txt`,
    `${ATTACHMENTS_DIR_PREFIX}a/../../escape.txt`,
    `${ATTACHMENTS_DIR_PREFIX}a/b/../../../deep/escape.txt`,
    `${ATTACHMENTS_DIR_PREFIX}..`,
    `${ATTACHMENTS_DIR_PREFIX}a/..`,
  ]) {
    assert.throws(() => resolveContainedSavePath(FILES_DIR, evil), PathEscapeError, evil);
  }
});

test("附件分支空段/`.` 段拒绝（尾斜杠/双斜杠/当前目录）", () => {
  for (const evil of [
    ATTACHMENTS_DIR_PREFIX,
    `${ATTACHMENTS_DIR_PREFIX}tid//uuid/f.txt`,
    `${ATTACHMENTS_DIR_PREFIX}tid/uuid/f.txt/`,
    `${ATTACHMENTS_DIR_PREFIX}./f.txt`,
    `${ATTACHMENTS_DIR_PREFIX}tid/./f.txt`,
  ]) {
    assert.throws(() => resolveContainedSavePath(FILES_DIR, evil), PathEscapeError, evil);
  }
});

test("镜像分支整体 `..`/`.`/空 拒绝（其余路径折叠后无层级可逃逸）", () => {
  for (const evil of ["/..", "/.", "/"]) {
    assert.throws(() => resolveContainedSavePath(FILES_DIR, evil), PathEscapeError, evil);
  }
  // 镜像内出现 ".." 字样但已被折叠为文件名的一部分：安全，保持落盘
  const p = resolveContainedSavePath(FILES_DIR, "/a/../b");
  assert.equal(p, join(FILES_DIR, "mirror", "a__..__b"));
});

test("所有合法返回值都落在 files/ 之下（resolve 前缀断言）", () => {
  const root = resolve(FILES_DIR);
  for (const okPath of [
    `${ATTACHMENTS_DIR_PREFIX}t/u/f.bin`,
    "/var/log/x.log",
  ]) {
    const saved = resolve(resolveContainedSavePath(FILES_DIR, okPath));
    assert.ok(
      saved === root || saved.startsWith(`${root}/`),
      `${saved} 应在 ${root} 之下`,
    );
  }
});
