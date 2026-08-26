import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { estimateTokens } from "../lib/context-pack.mjs";
import {
  buildLargeRunContext,
  LARGE_RUN_CONTEXT_BUDGET,
  LARGE_RUN_RESPONSE_RESERVE,
} from "../lib/large-run-context.mjs";
import {
  buildRepositoryCatalog,
  buildRunDelta,
  captureRunBaseline,
} from "../lib/repository.mjs";

test("large-run context keeps mandatory files whole and represents every tracked change and deletion in one complete diff", async () => {
  const root = await createCommittedRepo();
  const baseline = captureRunBaseline(root);
  await put(root, "src/changed.mjs", "export const value = 'after';\n");
  await unlink(path.join(root, "src/deleted.mjs"));
  await put(root, "src/new-untracked.mjs", "export const untracked = 'full body';\n");
  const runDelta = buildRunDelta(root, baseline);
  const mappedTests = ["test/mapped.test.mjs"];
  const catalog = await buildRepositoryCatalog(root, {
    specPath: "spec.md",
    authorityPaths: ["architecture.md"],
    mandatoryPaths: [
      ...runDelta.filter((entry) => entry.kind !== "missing").map((entry) => entry.path),
      ...mappedTests,
    ],
    runDelta,
  });

  const result = buildLargeRunContext(root, catalog, {
    baseline,
    fullPaths: ["spec.md", "architecture.md", "AGENTS.md", ...mappedTests],
    metadata: { run_id: "large-run", mode: "audit", state_summary: { status: "VERIFIED" } },
    ordinaryBlock: { budget_tokens: 700_000, mandatory_tokens: 710_000 },
  });

  assert.equal(result.status, "READY");
  assert.equal(result.representation, "large_run_unified_diff");
  assert.equal(result.budget_tokens, LARGE_RUN_CONTEXT_BUDGET);
  assert.ok(result.estimated_tokens <= LARGE_RUN_CONTEXT_BUDGET);
  assert.equal(result.estimated_tokens, estimateTokens(result.context_pack));
  assert.deepEqual(result.untracked_delta_full_paths, ["src/new-untracked.mjs"]);
  assert.match(result.context_pack, /<repository-file path="test\/mapped\.test\.mjs"[^>]*>\nmapped test body\n+<\/repository-file>/);
  assert.match(result.context_pack, /<repository-file path="src\/new-untracked\.mjs"[^>]*>\nexport const untracked = 'full body';\n+<\/repository-file>/);

  const expectedDiff = git(root, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    "--unified=0",
    "--no-renames",
    baseline.head,
    "--",
    ":(top,literal)src/changed.mjs",
    ":(top,literal)src/deleted.mjs",
  ]);
  assert.equal(result.diff.text, expectedDiff);
  assert.match(result.diff.text, /-export const value = 'before';/);
  assert.match(result.diff.text, /\+export const value = 'after';/);
  assert.match(result.diff.text, /-export const removed = true;/);
  assert.equal(result.diff.sha256, createHash("sha256").update(expectedDiff).digest("hex"));
  assert.deepEqual(result.represented.map((entry) => entry.path), ["src/changed.mjs", "src/deleted.mjs"]);
  assert.ok(result.represented.every((entry) => entry.baseline_sha256));

  const manifest = parseManifest(result.context_pack);
  assert.equal(manifest.mandatory_completeness, "FULL");
  assert.equal(manifest.tracked_delta_diff.complete, true);
  assert.equal(manifest.tracked_delta_diff.context_lines, 0);
  assert.equal(manifest.response_reserve_tokens, LARGE_RUN_RESPONSE_RESERVE);
  const untrackedPathIndex = manifest.untracked_delta_schema.indexOf("path");
  assert.deepEqual(manifest.untracked_delta.map((entry) => entry[untrackedPathIndex]), ["src/new-untracked.mjs"]);
  const omittedPathIndex = manifest.omitted_schema.indexOf("path");
  assert.ok(manifest.omitted.some((entry) => entry[omittedPathIndex] === "src/optional.mjs"));
});

test("large-run context fails closed above one million estimated tokens without truncating", async () => {
  const root = await createCommittedRepo();
  const baseline = captureRunBaseline(root);
  await put(root, "src/huge-untracked.txt", "x".repeat(2_050_000));
  const runDelta = buildRunDelta(root, baseline);
  const catalog = await buildRepositoryCatalog(root, {
    specPath: "spec.md",
    authorityPaths: ["architecture.md"],
    mandatoryPaths: runDelta.map((entry) => entry.path),
    runDelta,
  });
  const result = buildLargeRunContext(root, catalog, {
    baseline,
    fullPaths: ["spec.md", "architecture.md", "AGENTS.md", "test/mapped.test.mjs"],
    metadata: { run_id: "oversize", mode: "audit", state_summary: { status: "VERIFIED" } },
  });

  assert.equal(result.status, "BLOCKED");
  assert.ok(result.estimated_tokens > LARGE_RUN_CONTEXT_BUDGET);
  assert.match(result.reason, /exceeding the 1000000 token budget; no file or diff was truncated/i);
  assert.equal(result.context_pack, undefined);
});

async function createCommittedRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-large-run-"));
  git(root, ["init", "-q"]);
  await put(root, "AGENTS.md", "# Repository authority\n");
  await put(root, "spec.md", "# Module specification\n");
  await put(root, "architecture.md", "# Architecture\n");
  await put(root, "test/mapped.test.mjs", "mapped test body\n");
  await put(root, "src/changed.mjs", "export const value = 'before';\n");
  await put(root, "src/deleted.mjs", "export const removed = true;\n");
  await put(root, "src/optional.mjs", "export const optional = true;\n");
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline"]);
  return root;
}

async function put(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, "utf8");
}

function parseManifest(contextPack) {
  const start = contextPack.indexOf("\n") + 1;
  const end = contextPack.indexOf("\n<repository-file", start);
  return JSON.parse(contextPack.slice(start, end));
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
