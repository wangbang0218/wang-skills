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

test("selector context separates mandatory tokens from the additional budget", () => {
  const context = renderSelectorContext({
    required_paths: ["spec.md"],
    catalog: [{
      path: "spec.md",
      sha256: "a".repeat(64),
      bytes: 200,
      estimated_tokens: 100,
      tier: 1,
      changed: false,
      text: "# Module spec",
    }, {
      path: "lib/example.mjs",
      sha256: "b".repeat(64),
      bytes: 100,
      estimated_tokens: 40,
      tier: 3,
      changed: true,
      text: "must not be included",
    }],
  }, { text: "# Module spec" }, 500);

  assert.match(context, /total_tokens="500" mandatory_tokens="100" additional_tokens="400"/);
  assert.match(context, /Mandatory paths are always included/);
  assert.match(context, /"spec\.md"/);
});

test("repository selection keeps selector paths optional under the fixed budget", () => {
  const selection = selectRepositoryContext({
    required_paths: ["spec.md"],
    catalog: [{
      path: "spec.md",
      sha256: "a".repeat(64),
      estimated_tokens: 100,
      tier: 1,
    }, {
      path: "lib/large.mjs",
      sha256: "b".repeat(64),
      estimated_tokens: 450,
      tier: 3,
    }, {
      path: "lib/fits.mjs",
      sha256: "c".repeat(64),
      estimated_tokens: 250,
      tier: 3,
    }],
  }, {
    budgetTokens: 500,
    selectorPaths: ["lib/large.mjs", "lib/fits.mjs"],
  });

  assert.equal(selection.status, "READY");
  assert.deepEqual(selection.selected.map((item) => item.path), ["spec.md", "lib/fits.mjs"]);
  assert.deepEqual(selection.omitted.map((item) => [item.path, item.reason]), [
    ["lib/large.mjs", "context_budget"],
  ]);
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
