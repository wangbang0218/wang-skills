import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  INITIAL_CONTEXT_BUDGET,
  reconcileSelectorPaths,
  renderContextPack,
  renderSelectorContext,
  repositoryFingerprint,
  selectRepositoryContext,
} from "../lib/repository.mjs";

test("repository context defaults to a 700,000-token initial pack", () => {
  const selection = selectRepositoryContext({ catalog: [], required_paths: [] });

  assert.equal(INITIAL_CONTEXT_BUDGET, 700_000);
  assert.equal(selection.budget_tokens, 700_000);
});

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
  }, { text: "# Module spec" }, INITIAL_CONTEXT_BUDGET);

  assert.match(context, new RegExp(`"sha256": "${sha256}"`));
  assert.doesNotMatch(context, /must not be included/);
});

test("review context manifest preserves omitted file SHA-256", () => {
  const selectedSha256 = "a".repeat(64);
  const omittedSha256 = "b".repeat(64);
  const context = renderContextPack({
    selected: [{
      path: "spec.md",
      sha256: selectedSha256,
      bytes: 13,
      estimated_tokens: 7,
      tier: 1,
      text: "# Module spec",
    }],
    omitted: [{
      path: "lib/omitted.mjs",
      sha256: omittedSha256,
      reason: "context_budget",
      estimated_tokens: 900,
    }],
    estimated_tokens: 7,
    budget_tokens: INITIAL_CONTEXT_BUDGET,
  });
  const manifestStart = context.indexOf("\n") + 1;
  const manifestEnd = context.indexOf("\n<repository-file", manifestStart);
  const manifest = JSON.parse(context.slice(manifestStart, manifestEnd));

  assert.equal(manifest.completeness, "PARTIAL");
  assert.deepEqual(manifest.omitted, [{
    path: "lib/omitted.mjs",
    sha256: omittedSha256,
    reason: "context_budget",
    estimated_tokens: 900,
  }]);
});

test("selector reconciliation ignores only cataloged managed state paths", () => {
  const result = reconcileSelectorPaths({
    catalog: [{ path: "lib/example.mjs" }],
    excluded: [
      { path: "docs/tasks/module.state.md", reason: "managed_state" },
      { path: "fixtures/blob.bin", reason: "binary_nul" },
    ],
  }, ["lib/example.mjs", "docs/tasks/module.state.md"]);

  assert.deepEqual(result.selectedPaths, ["lib/example.mjs"]);
  assert.deepEqual(result.ignoredManagedStatePaths, ["docs/tasks/module.state.md"]);
  assert.deepEqual(result.unknownPaths, []);
});

test("selector reconciliation keeps every other unknown or excluded path fatal", () => {
  const result = reconcileSelectorPaths({
    catalog: [{ path: "lib/example.mjs" }],
    excluded: [
      { path: "docs/tasks/module.state.md", reason: "managed_state" },
      { path: "fixtures/blob.bin", reason: "binary_nul" },
    ],
  }, [
    "docs/tasks/invented.state.md",
    "fixtures/blob.bin",
    "outside/repository.txt",
  ]);

  assert.deepEqual(result.selectedPaths, []);
  assert.deepEqual(result.ignoredManagedStatePaths, []);
  assert.deepEqual(result.unknownPaths, [
    "docs/tasks/invented.state.md",
    "fixtures/blob.bin",
    "outside/repository.txt",
  ]);
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
