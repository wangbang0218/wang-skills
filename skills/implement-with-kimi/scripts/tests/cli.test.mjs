import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createInitialState,
  readStateFile,
  selectReviewer,
  writeStateFile,
} from "../lib/state.mjs";
import { sha256File } from "../lib/evidence.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(testsDirectory, "../kimi_context.mjs");
const hookAsset = path.resolve(testsDirectory, "../../assets/codex-hook/implement-with-kimi.mjs");
const fakeAcp = pathToFileURL(path.join(testsDirectory, "fixtures/fake-acp.mjs")).href;

test("bootstrap is local-only, fixes the reviewer, and performs no preflight", async () => {
  for (const reviewer of ["kimi", "claude-code"]) {
    const root = await repository();
    const harness = await reviewerHarness();
    const env = await fakeReviewerEnvironment(harness);
    const result = run(root, [
      "bootstrap", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", reviewer,
    ], env);
    assertOk(result);
    const output = json(result);
    assert.equal(output.status, "BOOTSTRAP_READY");
    assert.equal(output.reviewer_called, false);
    assert.equal(output.semantic_review, "PENDING");
    await assertMissing(harness.kimiMarker);
    await assertMissing(harness.claudeMarker);

    const loaded = await state(root);
    assert.equal(loaded.reviewer_policy.selected, reviewer);
    assert.equal(loaded.reviewer_policy.repository_access_authorized, true);
    assert.equal(loaded.reviewer_policy.required_context_tokens, 1_048_576);
    assert.equal(loaded.status, "BOOTSTRAP_READY");
  }

  const missing = await repository();
  const result = run(missing, ["bootstrap", "--spec", "spec.md", "--authority", "architecture.md"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--reviewer is required/);
  await assertMissing(path.join(missing, "spec.state.md"));
});

test("reviewer selection cannot switch within a run and still never preflights", async () => {
  const root = await repository();
  assertOk(bootstrap(root, "kimi"));
  const harness = await reviewerHarness();
  const env = await fakeReviewerEnvironment(harness);
  const before = await readFile(path.join(root, "spec.state.md"), "utf8");
  const result = run(root, [
    "select-reviewer", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", "claude-code",
  ], env);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /selection is fixed for the run/);
  assert.equal(await readFile(path.join(root, "spec.state.md"), "utf8"), before);
  await assertMissing(harness.kimiMarker);
  await assertMissing(harness.claudeMarker);
});

test("Red and baseline Green remain TESTS_WRITTEN; validate-tests and Green require complete mapped coverage", async () => {
  const root = await repository({ acCount: 2 });
  const harness = await reviewerHarness();
  const env = await fakeReviewerEnvironment(harness);
  assertOk(bootstrap(root, "claude-code", env));
  assertOk(run(root, [
    "record", "tests-written", "--spec", "spec.md", "--authority", "architecture.md",
    "--test-map", "AC-001=test/red.test.mjs", "--test-map", "AC-002=test/baseline.test.mjs",
  ], env));
  assertOk(run(root, [
    "record", "red-planned", "--spec", "spec.md", "--authority", "architecture.md",
    "--ac", "AC-001", "--expected-failure", "behavior missing",
  ], env));
  assertOk(run(root, [
    "record", "red-observed", "--spec", "spec.md", "--authority", "architecture.md",
    "--test", "test/red.test.mjs", "--command", "node --test test/red.test.mjs",
    "--exit-code", "1", "--matched-expectation",
  ], env));
  assert.equal((await state(root)).status, "TESTS_WRITTEN");
  assertOk(run(root, [
    "record", "baseline-green-observed", "--spec", "spec.md", "--authority", "architecture.md",
    "--test", "test/baseline.test.mjs", "--command", "node --test test/baseline.test.mjs", "--exit-code", "0",
  ], env));
  assert.equal((await state(root)).status, "TESTS_WRITTEN");

  const validated = run(root, ["review-tests", "--spec", "spec.md", "--authority", "architecture.md"], env);
  assertOk(validated);
  assert.equal(json(validated).status, "LOCAL_ONLY");
  assert.equal(json(validated).reviewer_called, false);
  assert.equal((await state(root)).status, "TESTS_VALIDATED");
  assertOk(run(root, ["record", "implementation-started", "--spec", "spec.md", "--authority", "architecture.md"], env));
  await writeFile(path.join(root, "src/implementation.mjs"), "export const implemented = true;\n", "utf8");

  assertOk(run(root, [
    "record", "green-observed", "--spec", "spec.md", "--authority", "architecture.md",
    "--test", "test/red.test.mjs", "--command", "node --test test/red.test.mjs", "--exit-code", "0",
  ], env));
  assert.equal((await state(root)).status, "IMPLEMENTING");
  assertOk(run(root, [
    "record", "green-observed", "--spec", "spec.md", "--authority", "architecture.md",
    "--test", "test/baseline.test.mjs", "--command", "node --test test/baseline.test.mjs", "--exit-code", "0",
  ], env));
  assert.equal((await state(root)).status, "GREEN_CONFIRMED");
  assertOk(run(root, [
    "record", "verification-observed", "--spec", "spec.md", "--authority", "architecture.md",
    "--command", "node --check src/implementation.mjs", "--exit-code", "0",
  ], env));
  assert.equal((await state(root)).status, "VERIFIED");
  await assertMissing(harness.kimiMarker);
  await assertMissing(harness.claudeMarker);
});

test("validate-tests requires current Red/baseline evidence and mapped test hashes invalidate later milestones", async () => {
  const missingEvidenceRoot = await repository();
  assertOk(bootstrap(missingEvidenceRoot, "kimi"));
  assertOk(run(missingEvidenceRoot, [
    "record", "tests-written", "--spec", "spec.md", "--authority", "architecture.md",
    "--test-map", "AC-001=test/red.test.mjs",
  ]));
  const missing = run(missingEvidenceRoot, ["validate-tests", "--spec", "spec.md", "--authority", "architecture.md"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /lacks current Red or baseline Green evidence/);

  const root = await repository();
  await reachTestValidated(root, "kimi");
  await writeFile(path.join(root, "test/red.test.mjs"), "changed after validation\n", "utf8");
  const invalidated = run(root, ["record", "implementation-started", "--spec", "spec.md", "--authority", "architecture.md"]);
  assert.equal(invalidated.status, 2);
  assert.match(invalidated.stdout, /requires TESTS_VALIDATED.*current status is TESTS_WRITTEN/s);
  const loaded = await state(root);
  assert.equal(loaded.status, "TESTS_WRITTEN");
  assert.equal(loaded.test_validation.fingerprint, null);
  assert.equal(loaded.history.at(-1).event, "test-milestone-invalidated");
});

test("rehydrate, suspend, and resume are local-only and only report the next step", async () => {
  const root = await repository();
  assertOk(bootstrap(root, "claude-code"));
  const harness = await reviewerHarness();
  const env = await fakeReviewerEnvironment(harness);
  const rehydrated = run(root, ["rehydrate", "--spec", "spec.md", "--authority", "architecture.md"], env);
  assertOk(rehydrated);
  assert.equal(json(rehydrated).reviewer_called, false);
  assert.match(json(rehydrated).next_action, /record tests-written/);
  assertOk(run(root, ["suspend", "--spec", "spec.md", "--authority", "architecture.md", "--reason", "pause"], env));
  const resumed = run(root, ["resume", "--spec", "spec.md", "--authority", "architecture.md"], env);
  assertOk(resumed);
  assert.equal(json(resumed).reviewer_called, false);
  assert.equal((await state(root)).active, true);
  await assertMissing(harness.kimiMarker);
  await assertMissing(harness.claudeMarker);
});

test("review-preview and unconfirmed audit return the same REVIEW_READY preview without changing state", async () => {
  const root = await repository();
  await reachVerified(root, "claude-code");
  const harness = await reviewerHarness();
  const env = await fakeReviewerEnvironment(harness);
  const before = await readFile(path.join(root, "spec.state.md"), "utf8");
  const preview = run(root, [
    "review-preview", "--mode", "audit", "--spec", "spec.md", "--authority", "architecture.md",
  ], env);
  const unconfirmed = run(root, ["audit", "--spec", "spec.md", "--authority", "architecture.md"], env);
  assertOk(preview);
  assertOk(unconfirmed);
  assert.deepEqual(json(unconfirmed), json(preview));
  assert.equal(json(preview).status, "REVIEW_READY");
  assert.equal(json(preview).requires_explicit_user_authorization, true);
  assert.equal(json(preview).reviewer_access.effort, "max");
  assert.equal(json(preview).cost_control.usd_cap, null);
  assert.equal(json(preview).submission_policy.max_prompt_submissions, 2);
  assert.equal(json(preview).submission_policy.preflight_failures_count, false);
  assert.match(json(preview).cost_control.note, /700K is the initial pack only.*Claude follow-up.*no hard token ceiling/);
  assert.equal(await readFile(path.join(root, "spec.state.md"), "utf8"), before);
  await assertMissing(harness.kimiMarker);
  await assertMissing(harness.claudeMarker);
});

test("authorized final audit routes to the fixed fake reviewer and completes with a usage ledger", async () => {
  for (const reviewer of ["kimi", "claude-code"]) {
    const root = await repository();
    await reachVerified(root, reviewer);
    const harness = await reviewerHarness();
    const claudeFindings = reviewer === "claude-code"
      ? [await localFinding(root, "AUDIT-WARNING", "WARNING")]
      : [];
    const env = await fakeReviewerEnvironment(harness, { claudeFindings });
    const result = run(root, [
      "audit", "--spec", "spec.md", "--authority", "architecture.md", "--execute-reviewer",
    ], { ...env, FAKE_REVIEW_RESPONSE: "1" });
    assertOk(result);
    assert.equal(json(result).status, reviewer === "claude-code" ? "WARNING" : "READY");
    assert.equal(json(result).module_status, "COMPLETED");
    const loaded = await state(root);
    assert.equal(loaded.status, "COMPLETED");
    assert.equal(loaded.active, false);
    assert.equal(loaded.semantic_review.status, "AUDITED");
    assert.equal(loaded.review_invocations.length, 1);
    assert.equal(loaded.review_invocations[0].status, "SUCCEEDED");
    assert.equal(loaded.review_invocations[0].reviewer, reviewer);
    if (reviewer === "kimi") {
      assert.equal(loaded.review_invocations[0].usage.total_cost_usd, null);
      assert.equal(loaded.review_invocations[0].usage.input_tokens, null);
      await readFile(harness.kimiMarker, "utf8");
      await assertMissing(harness.claudeMarker);
    } else {
      assert.equal(loaded.review_invocations[0].usage.total_cost_usd, 0.25);
      assert.equal(loaded.review_invocations[0].usage.input_tokens, 100);
      await readFile(harness.claudeMarker, "utf8");
      await assertMissing(harness.kimiMarker);
    }
  }
});

test("authorized query records cost but cannot change milestones, findings, or semantic review", async () => {
  const root = await repository();
  await reachVerified(root, "claude-code");
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  loaded.state.unresolved_findings = [{ id: "EXISTING", severity: "BLOCKED", title: "Preserve", explanation: "Preserve" }];
  await writeStateFile(path.join(root, "spec.state.md"), loaded.state, "keep\n");
  const harness = await reviewerHarness();
  const finding = await localFinding(root, "Q-001", "WARNING");
  const env = await fakeReviewerEnvironment(harness, { claudeFindings: [finding] });
  const preview = run(root, [
    "review-preview", "--mode", "query", "--spec", "spec.md", "--authority", "architecture.md",
    "--question", "Is the public API compatible?",
  ], env);
  assertOk(preview);
  assert.equal(json(preview).status, "REVIEW_READY");
  assert.equal(json(preview).question, "Is the public API compatible?");
  assert.equal(json(preview).reviewer_access.effort, "max");
  await assertMissing(harness.claudeMarker);
  const result = run(root, [
    "query", "--spec", "spec.md", "--authority", "architecture.md",
    "--question", "Is the public API compatible?", "--execute-reviewer",
  ], env);
  assertOk(result);
  assert.equal(json(result).advisory, true);
  const after = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(after.state.status, "VERIFIED");
  assert.equal(after.state.semantic_review.status, "PENDING");
  assert.deepEqual(after.state.unresolved_findings, loaded.state.unresolved_findings);
  assert.equal(after.state.last_query_review.advisory, true);
  assert.equal(after.state.last_reviewer_review, null);
  assert.equal(after.state.review_invocations[0].usage.total_cost_usd, 0.25);
  assert.equal(after.userNotes, "keep\n");
});

test("blocking audit stays blocked until the run fingerprint changes, then findings are superseded locally", async () => {
  const root = await repository();
  await reachVerified(root, "claude-code");
  const harness = await reviewerHarness();
  const blocking = await localFinding(root, "A-001", "BLOCKED");
  const env = await fakeReviewerEnvironment(harness, { claudeFindings: [blocking] });
  const audited = run(root, [
    "audit", "--spec", "spec.md", "--authority", "architecture.md", "--execute-reviewer",
  ], env);
  assert.equal(audited.status, 2);
  let loaded = await state(root);
  assert.equal(loaded.status, "BLOCKED");
  assert.equal(loaded.previous_status, "VERIFIED");
  assert.equal(loaded.semantic_review.status, "PENDING");
  assert.equal(loaded.unresolved_findings[0].id, "A-001");

  const unchanged = run(root, ["rehydrate", "--spec", "spec.md", "--authority", "architecture.md"]);
  assertOk(unchanged);
  assert.equal((await state(root)).status, "BLOCKED");
  await writeFile(path.join(root, "src/implementation.mjs"), "export const implemented = 'fixed';\n", "utf8");
  const changed = run(root, ["rehydrate", "--spec", "spec.md", "--authority", "architecture.md"]);
  assertOk(changed);
  loaded = await state(root);
  assert.equal(loaded.status, "IMPLEMENTING");
  assert.deepEqual(loaded.unresolved_findings, []);
  assert.equal(loaded.superseded_findings.at(-1).id, "A-001");

  const testRoot = await repository();
  await reachVerified(testRoot, "claude-code");
  const testHarness = await reviewerHarness();
  const testBlocking = await localFinding(testRoot, "A-TEST", "BLOCKED");
  const testEnv = await fakeReviewerEnvironment(testHarness, { claudeFindings: [testBlocking] });
  const testAudit = run(testRoot, [
    "audit", "--spec", "spec.md", "--authority", "architecture.md", "--execute-reviewer",
  ], testEnv);
  assert.equal(testAudit.status, 2);
  await writeFile(path.join(testRoot, "test/red.test.mjs"), "changed after blocked audit\n", "utf8");
  assertOk(run(testRoot, ["rehydrate", "--spec", "spec.md", "--authority", "architecture.md"]));
  const testLoaded = await state(testRoot);
  assert.equal(testLoaded.status, "TESTS_WRITTEN");
  assert.deepEqual(testLoaded.unresolved_findings, []);
  assert.equal(testLoaded.superseded_findings.at(-1).id, "A-TEST");
});

test("context shrink and compaction still share the two-submission audit cap", async () => {
  const root = await repository();
  await reachVerified(root, "claude-code");
  const harness = await reviewerHarness();
  const env = await fakeReviewerEnvironment(harness, { claudeCompacted: true });
  const result = run(root, [
    "audit", "--spec", "spec.md", "--authority", "architecture.md", "--execute-reviewer",
  ], env);
  assert.equal(result.status, 5);
  assert.match(result.stdout, /CONTEXT_OVERSIZE/);
  const loaded = await state(root);
  assert.equal(loaded.status, "VERIFIED");
  assert.equal(loaded.semantic_review.status, "PENDING");
  assert.deepEqual(loaded.review_invocations.map((entry) => [entry.attempt, entry.status, entry.error.kind]), [
    [1, "FAILED", "CONTEXT_OVERSIZE"],
    [2, "FAILED", "CONTEXT_OVERSIZE"],
  ]);
});

test("mandatory audit context over 700K blocks before reviewer preflight", async () => {
  const root = await repository({ testContent: "x".repeat(1_500_000) });
  await reachVerified(root, "kimi");
  const harness = await reviewerHarness();
  const env = await fakeReviewerEnvironment(harness);
  const result = run(root, ["audit", "--spec", "spec.md", "--authority", "architecture.md"], env);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /mandatory context requires.*exceeding the 700000 token budget/i);
  assert.equal((await state(root)).status, "BLOCKED");
  await assertMissing(harness.kimiMarker);
  await assertMissing(harness.claudeMarker);
});

test("migrated v3 Red state attaches test maps in place without changing run_id", async () => {
  const root = await repository();
  const specHash = await sha256File(path.join(root, "spec.md"));
  let legacy = createInitialState({ specPath: "spec.md", specSha256: specHash, runId: "legacy-run" });
  legacy = selectReviewer(legacy, "kimi");
  legacy.state_schema_version = 3;
  legacy.status = "RED_CONFIRMED";
  legacy.authority_paths = ["architecture.md"];
  legacy.authority_hashes = { "architecture.md": await sha256File(path.join(root, "architecture.md")) };
  await writeStateFile(path.join(root, "spec.state.md"), legacy, "legacy note\n");

  const result = run(root, [
    "attach-test-map", "--spec", "spec.md", "--authority", "architecture.md",
    "--test-map", "AC-001=test/red.test.mjs",
  ]);
  assertOk(result);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.state_schema_version, 4);
  assert.equal(loaded.state.run_id, "legacy-run");
  assert.equal(loaded.state.status, "TESTS_WRITTEN");
  assert.equal(loaded.state.migration_requirements.test_maps, "NOT_REQUIRED");
  assert.equal(loaded.state.test_mappings[0].path, "test/red.test.mjs");
  assert.equal(loaded.userNotes, "legacy note\n");
});

test("inspect remains compatible with a retained legacy raw bootstrap review", async () => {
  const root = await repository();
  assertOk(bootstrap(root, "kimi"));
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  const rawDirectory = await mkdtemp(path.join(tmpdir(), "iwk-raw-review-"));
  const rawPath = path.join(rawDirectory, "legacy.json");
  const finding = await localFinding(root, "LEGACY-001", "WARNING");
  const envelope = reviewerEnvelope({ runId: loaded.state.run_id, mode: "bootstrap", findings: [finding] });
  await writeFile(rawPath, JSON.stringify(envelope), "utf8");
  loaded.state.last_reviewer_review = {
    reviewer: "kimi", mode: "bootstrap", status: "WARNING",
    raw_result_ref: rawPath, finding_ids: ["LEGACY-001"],
  };
  await writeStateFile(path.join(root, "spec.state.md"), loaded.state, loaded.userNotes);

  const result = run(root, [
    "inspect", "--spec", "spec.md", "--authority", "architecture.md", "--finding", "LEGACY-001",
  ]);
  assertOk(result);
  assert.equal(json(result).finding.id, "LEGACY-001");
  assert.equal(json(result).finding.evidence[0].path, "spec.md");
});

test("authority changes fail closed and require a new run", async () => {
  const root = await repository();
  assertOk(bootstrap(root, "kimi"));
  await writeFile(path.join(root, "architecture.md"), "# Changed architecture\n", "utf8");
  const result = run(root, ["rehydrate", "--spec", "spec.md", "--authority", "architecture.md"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Authority paths or contents changed.*--new-run/s);
});

test("v4 project Hook only reminds recovery; setup/remove preserve unrelated hook config", async () => {
  const root = await repository();
  await mkdir(path.join(root, ".codex"));
  await writeFile(path.join(root, ".codex/hooks.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node existing.mjs" }] }] },
  }), "utf8");
  assertOk(run(root, ["setup-hook"]));
  const configured = JSON.parse(await readFile(path.join(root, ".codex/hooks.json"), "utf8"));
  assert.equal(configured.hooks.Stop.length, 1);
  assert.equal(configured.hooks.SessionStart[0].hooks[0].command,
    'volta run node "$(git rev-parse --show-toplevel)/.codex/hooks/implement-with-kimi.mjs"');
  assertOk(bootstrap(root, "kimi"));

  const hook = spawnSync(process.execPath, [hookAsset], {
    cwd: root,
    input: JSON.stringify({ cwd: root, source: "compact", session_id: "session-1" }),
    encoding: "utf8",
  });
  assert.equal(hook.status, 0, hook.stderr || hook.stdout);
  const output = JSON.parse(hook.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /必须先执行 rehydrate/);
  assert.equal((await state(root)).hook.status, "OBSERVED_ACTIVE");

  assertOk(run(root, ["remove-hook"]));
  await assertMissing(path.join(root, ".codex/hooks/implement-with-kimi.mjs"));
  const removed = JSON.parse(await readFile(path.join(root, ".codex/hooks.json"), "utf8"));
  assert.equal(removed.hooks.Stop.length, 1);
});

async function repository({ acCount = 1, testContent = "test placeholder\n" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-cli-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "spec.md"), specification(acCount), "utf8");
  await writeFile(path.join(root, "architecture.md"), "# Architecture\n", "utf8");
  await writeFile(path.join(root, "AGENTS.md"), "# Repository authority\n", "utf8");
  await writeFile(path.join(root, "src/implementation.mjs"), "export const implemented = false;\n", "utf8");
  await writeFile(path.join(root, "test/red.test.mjs"), testContent, "utf8");
  await writeFile(path.join(root, "test/baseline.test.mjs"), "baseline placeholder\n", "utf8");
  return root;
}

function specification(acCount) {
  const criteria = Array.from({ length: acCount }, (_, index) =>
    `- AC-${String(index + 1).padStart(3, "0")}: Behavior ${index + 1} is verified.`).join("\n");
  return `# Module

## Goal
Ship behavior.

## Scope
One module.

## Non-goals
No unrelated work.

## Dependencies
None.

## Acceptance criteria
${criteria}

## Test requirements
Map every AC to a test.

## Related architecture and PRD
- [Architecture](architecture.md)
`;
}

function run(root, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
}

function bootstrap(root, reviewer, env = {}) {
  return run(root, [
    "bootstrap", "--spec", "spec.md", "--authority", "architecture.md", "--goal", "active", "--reviewer", reviewer,
  ], env);
}

async function reachTestValidated(root, reviewer) {
  assertOk(bootstrap(root, reviewer));
  assertOk(run(root, [
    "record", "tests-written", "--spec", "spec.md", "--authority", "architecture.md",
    "--test-map", "AC-001=test/red.test.mjs",
  ]));
  assertOk(run(root, [
    "record", "red-planned", "--spec", "spec.md", "--authority", "architecture.md",
    "--ac", "AC-001", "--expected-failure", "behavior missing",
  ]));
  assertOk(run(root, [
    "record", "red-observed", "--spec", "spec.md", "--authority", "architecture.md",
    "--test", "test/red.test.mjs", "--command", "node --test test/red.test.mjs",
    "--exit-code", "1", "--matched-expectation",
  ]));
  assertOk(run(root, ["validate-tests", "--spec", "spec.md", "--authority", "architecture.md"]));
}

async function reachVerified(root, reviewer) {
  await reachTestValidated(root, reviewer);
  assertOk(run(root, ["record", "implementation-started", "--spec", "spec.md", "--authority", "architecture.md"]));
  await writeFile(path.join(root, "src/implementation.mjs"), "export const implemented = true;\n", "utf8");
  assertOk(run(root, [
    "record", "green-observed", "--spec", "spec.md", "--authority", "architecture.md",
    "--test", "test/red.test.mjs", "--command", "node --test test/red.test.mjs", "--exit-code", "0",
  ]));
  assertOk(run(root, [
    "record", "verification-observed", "--spec", "spec.md", "--authority", "architecture.md",
    "--command", "node --check src/implementation.mjs", "--exit-code", "0",
  ]));
  assert.equal((await state(root)).status, "VERIFIED");
}

async function reviewerHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-reviewer-harness-"));
  return {
    root,
    kimiMarker: path.join(root, "kimi.marker"),
    claudeMarker: path.join(root, "claude.marker"),
  };
}

async function fakeReviewerEnvironment(harness, { claudeFindings = [], claudeCompacted = false } = {}) {
  const kimi = path.join(harness.root, "fake-kimi");
  await writeFile(kimi, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env.FAKE_KIMI_MARKER) writeFileSync(process.env.FAKE_KIMI_MARKER, "called\\n");
const command = process.argv[2];
if (command === "--version") console.log("0.0.0-fake");
else if (command === "doctor") process.exit(0);
else if (command === "provider") console.log(JSON.stringify({ models: { "kimi-code/k3": { model: "k3", maxContextSize: 1048576, supportEfforts: ["low", "high", "max"] } } }));
else if (command === "acp") await import(${JSON.stringify(fakeAcp)});
else process.exit(1);
`, "utf8");
  await chmod(kimi, 0o755);

  const claude = path.join(harness.root, "fake-claude");
  const help = ["--safe-mode", "--no-session-persistence", "--json-schema", "--permission-mode", "--tools", "--allowedTools", "--disallowedTools", "--effort"].join(" ");
  await writeFile(claude, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env.FAKE_CLAUDE_MARKER) writeFileSync(process.env.FAKE_CLAUDE_MARKER, "called\\n");
if (process.argv[2] === "--version") console.log("9.9.9");
else if (process.argv[2] === "--help") console.log(${JSON.stringify(help)});
else {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const runId = prompt.match(/Run id: ([^.]+)\\./)?.[1];
  const mode = prompt.match(/Mode: ([^.]+)\\./)?.[1];
  console.log(JSON.stringify({
    structured_output: ${JSON.stringify(reviewerEnvelope({ runId: "__RUN__", findings: claudeFindings, compacted: claudeCompacted }))},
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    modelUsage: { "configured-default": { inputTokens: 100 } },
    total_cost_usd: 0.25,
    duration_ms: 500,
    duration_api_ms: 400,
    num_turns: 1
  }).replaceAll("__RUN__", runId).replace('"mode":"audit"', '"mode":"' + mode + '"'));
}
`, "utf8");
  await chmod(claude, 0o755);
  return {
    KIMI_BIN: kimi,
    CLAUDE_BIN: claude,
    FAKE_KIMI_MARKER: harness.kimiMarker,
    FAKE_CLAUDE_MARKER: harness.claudeMarker,
  };
}

function reviewerEnvelope({ runId, mode = "audit", findings = [], compacted = false }) {
  return {
    schema_version: 1,
    mode,
    run_id: runId,
    summary: "Fake review complete.",
    findings,
    ac_coverage: [{ ac_id: "AC-001", status: "COVERED", test_refs: ["test/red.test.mjs"] }],
    next_actions: [],
    external_research: { status: "NOT_REQUESTED", sources: [] },
    context: { completeness: "FULL", omissions: [], compacted },
  };
}

async function localFinding(root, id, severity) {
  return {
    id,
    severity,
    title: "Fake finding",
    explanation: "Evidence-backed fake finding.",
    evidence: [{
      path: "spec.md",
      sha256: await sha256File(path.join(root, "spec.md")),
      line_start: 1,
      line_end: 1,
      excerpt: "# Module",
      claim: "The module specification exists.",
    }],
  };
}

async function state(root) {
  return (await readStateFile(path.join(root, "spec.state.md"))).state;
}

function json(result) {
  return JSON.parse(result.stdout);
}

function assertOk(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function assertMissing(filePath) {
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
}
