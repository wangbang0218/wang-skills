import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sha256File } from "../lib/evidence.mjs";
import { createSubmissionBudget, isTransientKimiError, runKimiNode } from "../lib/runner.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(testsDirectory, "fixtures/fake-acp.mjs");

test("explicit quota exhaustion is not retried as a transient 429", () => {
  assert.equal(isTransientKimiError(new Error("429 billing cycle quota exhausted")), false);
  assert.equal(isTransientKimiError(new Error("429 engine overload")), true);
});

test("Kimi audit canonicalizes evidence and records measurable usage without invented cost", async () => {
  const root = await createRepo("iwk-kimi-success-");
  await writeFile(path.join(root, "source.txt"), "root\n  nested\n", "utf8");
  const sha256 = await sha256File(path.join(root, "source.txt"));
  const binary = await fakeKimi(root);
  const events = [];
  const previous = process.env.FAKE_RESPONSE_TEXT;
  try {
    process.env.FAKE_RESPONSE_TEXT = JSON.stringify(envelope({ runId: "run-audit", sha256, excerpt: "nested" }));
    const result = await runKimiNode({
      repoRoot: root,
      mode: "audit",
      runId: "run-audit",
      specPath: "spec.md",
      contextPack: "<context />",
      preflight: kimiPreflight(binary),
      estimatedInitialTokens: 321,
      onInvocation: async (event) => events.push(event),
    });

    assert.equal(result.envelope.attempts, 1);
    assert.equal(result.envelope.findings[0].evidence[0].excerpt, "  nested");
    assert.deepEqual(events.map((event) => [event.phase, event.entry.status]), [
      ["started", "RUNNING"],
      ["finished", "SUCCEEDED"],
    ]);
    assert.equal(events[1].entry.usage.estimated_initial_tokens, 321);
    assert.equal(events[1].entry.usage.total_cost_usd, null);
    assert.equal(events[1].entry.usage.input_tokens, null);
    assert.equal(typeof events[1].entry.usage.extra_read_tokens, "number");
  } finally {
    restoreEnv("FAKE_RESPONSE_TEXT", previous);
  }
});

test("Kimi Schema repair and retry share a hard two-submission budget", async () => {
  const root = await createRepo("iwk-kimi-repair-");
  const binary = await fakeKimi(root);
  const budget = createSubmissionBudget();
  const events = [];
  const previous = process.env.FAKE_RESPONSE_TEXT;
  try {
    process.env.FAKE_RESPONSE_TEXT = "{}";
    await assert.rejects(runKimiNode({
      repoRoot: root,
      mode: "audit",
      runId: "run-repair",
      specPath: "spec.md",
      contextPack: "<context />",
      preflight: kimiPreflight(binary),
      submissionBudget: budget,
      onInvocation: async (event) => events.push(event),
    }), (error) => error.kind === "SCHEMA");
  } finally {
    restoreEnv("FAKE_RESPONSE_TEXT", previous);
  }

  assert.equal(budget.used, 2);
  assert.deepEqual(events.filter((event) => event.phase === "finished").map((event) => event.entry.status), ["FAILED", "FAILED"]);
  assert.deepEqual(events.filter((event) => event.phase === "finished").map((event) => event.entry.attempt), [1, 2]);
});

test("Kimi material evidence failures are ledgered once and never Schema-retried", async () => {
  const root = await createRepo("iwk-kimi-evidence-");
  await writeFile(path.join(root, "source.txt"), "root\n  nested\n", "utf8");
  const sha256 = await sha256File(path.join(root, "source.txt"));
  const binary = await fakeKimi(root);
  const budget = createSubmissionBudget();
  const events = [];
  const previous = process.env.FAKE_RESPONSE_TEXT;
  try {
    process.env.FAKE_RESPONSE_TEXT = JSON.stringify(envelope({ runId: "run-mismatch", sha256, excerpt: "different" }));
    await assert.rejects(runKimiNode({
      repoRoot: root,
      mode: "audit",
      runId: "run-mismatch",
      specPath: "spec.md",
      contextPack: "<context />",
      preflight: kimiPreflight(binary),
      submissionBudget: budget,
      onInvocation: async (event) => events.push(event),
    }), (error) => error.kind === "EVIDENCE" && /excerpt mismatch/.test(error.message));
  } finally {
    restoreEnv("FAKE_RESPONSE_TEXT", previous);
  }

  assert.equal(budget.used, 1);
  const finished = events.find((event) => event.phase === "finished").entry;
  assert.equal(finished.status, "FAILED");
  assert.equal(finished.error.kind, "EVIDENCE");
});

test("Kimi detects a concurrent worktree mutation as STALE and ledgers the failed submission", async () => {
  const root = await createRepo("iwk-kimi-stale-");
  await writeFile(path.join(root, "source.txt"), "root\n  nested\n", "utf8");
  const sha256 = await sha256File(path.join(root, "source.txt"));
  const binary = path.join(root, "fake-kimi-stale");
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(path.join(root, "concurrent.txt"))}, "changed during review\\n");
await import(${JSON.stringify(pathToFileURL(fakeAgent).href)});
`, "utf8");
  await chmod(binary, 0o755);
  const budget = createSubmissionBudget();
  const events = [];
  const previous = process.env.FAKE_RESPONSE_TEXT;
  try {
    process.env.FAKE_RESPONSE_TEXT = JSON.stringify(envelope({ runId: "run-stale", sha256, excerpt: "  nested" }));
    await assert.rejects(runKimiNode({
      repoRoot: root,
      mode: "audit",
      runId: "run-stale",
      specPath: "spec.md",
      contextPack: "<context />",
      preflight: kimiPreflight(binary),
      submissionBudget: budget,
      onInvocation: async (event) => events.push(event),
    }), (error) => error.kind === "STALE");
  } finally {
    restoreEnv("FAKE_RESPONSE_TEXT", previous);
  }

  assert.equal(budget.used, 1);
  const finished = events.find((event) => event.phase === "finished").entry;
  assert.equal(finished.status, "FAILED");
  assert.equal(finished.error.kind, "STALE");
});

function envelope({ runId, sha256, excerpt, evidencePath = "source.txt" }) {
  return {
    schema_version: 1,
    mode: "audit",
    run_id: runId,
    summary: "Review complete.",
    findings: [{
      id: "F-001",
      severity: "WARNING",
      title: "Evidence fixture",
      explanation: "The fixture exercises local evidence validation.",
      evidence: [{
        path: evidencePath,
        sha256,
        line_start: 2,
        line_end: 2,
        excerpt,
        claim: "The nested line exists.",
      }],
    }],
    ac_coverage: [],
    next_actions: [],
    external_research: { status: "NOT_REQUESTED", sources: [] },
    context: { completeness: "FULL", omissions: [], compacted: false },
  };
}

async function createRepo(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}

async function fakeKimi(root) {
  const binary = path.join(root, "fake-kimi");
  await writeFile(binary, `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fakeAgent).href)};\n`, "utf8");
  await chmod(binary, 0o755);
  return binary;
}

function kimiPreflight(binary) {
  return { binary, model_alias: "kimi-code/k3", model: "k3", max_context_size: 1_048_576 };
}

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
