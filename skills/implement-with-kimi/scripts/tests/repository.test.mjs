import assert from "node:assert/strict";
import { mkdtemp, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  INITIAL_CONTEXT_BUDGET,
  QUERY_ADDITIONAL_CONTEXT_BUDGET,
  buildRepositoryCatalog,
  buildRunDelta,
  captureRunBaseline,
  extractSpecPaths,
  queryContextBudget,
  renderContextPack,
  repositoryFingerprint,
  runScopedFingerprint,
  selectRepositoryContext,
} from "../lib/repository.mjs";

test("repository context defaults to a 700,000-token initial pack", () => {
  const selection = selectRepositoryContext({ catalog: [], required_paths: [] });
  assert.equal(INITIAL_CONTEXT_BUDGET, 700_000);
  assert.equal(selection.budget_tokens, 700_000);
});

test("deterministic catalog ordering follows mandatory then fixed local tiers", async () => {
  const root = await createRepo();
  const files = {
    "AGENTS.md": "# Authority\n",
    "docs/module.md": "# Module\n",
    "docs/authority.md": "# Architecture\n",
    "docs/explicit.mjs": "export const explicit = true;\n",
    "docs/neighbor.md": "same directory\n",
    "src/api-schema.mjs": "export const schema = {};\n",
    "test/unmapped.test.mjs": "test placeholder\n",
    "test/mapped.test.mjs": "mapped test\n",
    "src/delta.mjs": "run delta\n",
    "src/implementation.mjs": "implementation\n",
    "fixtures/history.txt": "history\n",
  };
  for (const [file, content] of Object.entries(files)) await put(root, file, content);
  git(root, ["add", "."]);

  const catalog = await buildRepositoryCatalog(root, {
    specPath: "docs/module.md",
    authorityPaths: ["docs/authority.md"],
    mandatoryPaths: ["src/delta.mjs", "test/mapped.test.mjs"],
    explicitPaths: ["docs/explicit.mjs"],
    runDelta: [{ path: "src/delta.mjs" }],
  });
  const selection = selectRepositoryContext(catalog, { budgetTokens: 10_000 });

  assert.equal(selection.status, "READY");
  assert.deepEqual(selection.selected.map((item) => [item.path, item.tier]), [
    ["AGENTS.md", 0],
    ["docs/authority.md", 0],
    ["docs/module.md", 0],
    ["src/delta.mjs", 0],
    ["test/mapped.test.mjs", 0],
    ["docs/explicit.mjs", 1],
    ["docs/neighbor.md", 2],
    ["src/api-schema.mjs", 3],
    ["test/unmapped.test.mjs", 4],
    ["src/implementation.mjs", 5],
    ["fixtures/history.txt", 6],
  ]);
  assert.equal(selection.selected.find((item) => item.path === "src/delta.mjs").run_delta, true);
});

test("mandatory specification, authority, delta, and mapped tests block instead of truncating", () => {
  const selection = selectRepositoryContext({
    required_paths: ["AGENTS.md", "spec.md", "src/delta.mjs", "test/mapped.test.mjs"],
    catalog: [
      { path: "AGENTS.md", estimated_tokens: 100, tier: 0 },
      { path: "spec.md", estimated_tokens: 200, tier: 0 },
      { path: "src/delta.mjs", estimated_tokens: 300, tier: 0 },
      { path: "test/mapped.test.mjs", estimated_tokens: 400, tier: 0 },
    ],
  }, { budgetTokens: 999 });

  assert.equal(selection.status, "BLOCKED");
  assert.match(selection.reason, /mandatory context requires 1000 tokens/i);
});

test("query budget is mandatory context plus 150K capped at 700K", () => {
  assert.equal(QUERY_ADDITIONAL_CONTEXT_BUDGET, 150_000);
  assert.equal(queryContextBudget({
    required_paths: ["spec.md"],
    catalog: [{ path: "spec.md", estimated_tokens: 100_000 }],
  }), 250_000);
  assert.equal(queryContextBudget({
    required_paths: ["spec.md"],
    catalog: [{ path: "spec.md", estimated_tokens: 600_000 }],
  }), 700_000);
});

test("explicit specification paths include Markdown links and inline code paths", () => {
  const paths = extractSpecPaths([
    "[Architecture](../architecture.md)",
    "Change `../src/public_api.mjs` and `implementation-package.json`.",
    "Ignore `pnpm test` and https://example.com/file.md.",
  ].join("\n"), "docs/tasks/module.md");

  assert.deepEqual(paths, [
    "docs/architecture.md",
    "docs/src/public_api.mjs",
    "docs/tasks/implementation-package.json",
  ]);
});

test("review context manifest preserves omitted file SHA-256", () => {
  const omittedSha256 = "b".repeat(64);
  const context = renderContextPack({
    selected: [{
      path: "spec.md",
      sha256: "a".repeat(64),
      bytes: 13,
      estimated_tokens: 7,
      tier: 0,
      mandatory: true,
      text: "# Module spec",
    }],
    omitted: [{
      path: "lib/omitted.mjs",
      sha256: omittedSha256,
      reason: "context_budget",
      estimated_tokens: 900,
    }],
    estimated_tokens: 7,
    mandatory_tokens: 7,
    budget_tokens: INITIAL_CONTEXT_BUDGET,
  });
  const manifestStart = context.indexOf("\n") + 1;
  const manifestEnd = context.indexOf("\n<repository-file", manifestStart);
  const manifest = JSON.parse(context.slice(manifestStart, manifestEnd));

  assert.equal(manifest.completeness, "PARTIAL");
  assert.equal(manifest.mandatory_tokens, 7);
  assert.deepEqual(manifest.omitted, [{
    path: "lib/omitted.mjs",
    sha256: omittedSha256,
    reason: "context_budget",
    estimated_tokens: 900,
  }]);
});

test("run delta ignores unchanged pre-existing dirt and records later changes", async () => {
  const root = await createRepo();
  await put(root, "tracked.txt", "base\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]);
  await put(root, "tracked.txt", "dirty before run\n");
  const baseline = captureRunBaseline(root);

  await put(root, "new.txt", "created during run\n");
  assert.deepEqual(buildRunDelta(root, baseline).map((item) => item.path), ["new.txt"]);

  await put(root, "tracked.txt", "changed during run\n");
  assert.deepEqual(buildRunDelta(root, baseline).map((item) => item.path), ["new.txt", "tracked.txt"]);
});

test("run-scoped fingerprint and deletion metadata change with the run delta", async () => {
  const root = await createRepo();
  await put(root, "tracked.txt", "base\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]);
  const baseline = captureRunBaseline(root);
  const before = runScopedFingerprint(root, baseline);

  await unlink(path.join(root, "tracked.txt"));
  const delta = buildRunDelta(root, baseline);
  assert.equal(delta[0].path, "tracked.txt");
  assert.equal(delta[0].kind, "missing");
  assert.equal(delta[0].sha256, null);
  assert.notEqual(runScopedFingerprint(root, baseline), before);
});

test("repository fingerprint detects staged changes before the first commit", async () => {
  const root = await createRepo();
  await put(root, "file.txt", "first\n");
  git(root, ["add", "file.txt"]);
  const before = repositoryFingerprint(root);

  await put(root, "file.txt", "second\n");
  const unstaged = repositoryFingerprint(root);
  assert.notEqual(unstaged, before);

  git(root, ["add", "file.txt"]);
  const restaged = repositoryFingerprint(root);
  assert.notEqual(restaged, before);
});

async function createRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-repository-"));
  git(root, ["init", "-q"]);
  return root;
}

async function put(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, "utf8");
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
