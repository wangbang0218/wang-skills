import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { renderSelectorContext, repositoryFingerprint } from "../lib/repository.mjs";

test("selector context preserves the catalog SHA-256", () => {
  const sha256 = "a".repeat(64);
  const context = renderSelectorContext({
    catalog: [{
      path: "lib/example.mjs",
      sha256,
      bytes: 42,
      estimated_tokens: 11,
      tier: 3,
      changed: true,
      text: "must not be included",
    }],
  }, { text: "# Module spec" }, 650_000);

  assert.match(context, new RegExp(`"sha256": "${sha256}"`));
  assert.doesNotMatch(context, /must not be included/);
});

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
