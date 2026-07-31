import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { repositoryFingerprint } from "../lib/repository.mjs";

test("repository fingerprint detects staged changes before the first commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-repository-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "file.txt"), "first\n", "utf8");
  spawnSync("git", ["add", "file.txt"], { cwd: root });
  const before = repositoryFingerprint(root);

  await writeFile(path.join(root, "file.txt"), "second\n", "utf8");
  const unstaged = repositoryFingerprint(root);
  assert.notEqual(unstaged, before);

  spawnSync("git", ["add", "file.txt"], { cwd: root });
  const restaged = repositoryFingerprint(root);
  assert.notEqual(restaged, before);
});
