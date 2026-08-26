import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStateEvent,
  createInitialState,
  deriveStatePath,
  parseStateDocument,
  recordReviewInvocation,
  renderStateDocument,
  selectReviewer,
} from "../lib/state.mjs";

const sha = "a".repeat(64);
const mapping = { ac_id: "AC-001", path: "test/module.test.mjs", sha256: sha };

test("deriveStatePath pairs a Markdown specification with one state document", () => {
  assert.equal(deriveStatePath("docs/tasks/payment.md"), "docs/tasks/payment.state.md");
  assert.throws(() => deriveStatePath("docs/tasks/payment.txt"), /Markdown/);
});

test("state v4 rendering round-trips managed JSON and preserves user notes", () => {
  const state = createInitialState({
    specPath: "docs/tasks/payment.md",
    specSha256: sha,
    runId: "run-1",
    now: "2026-07-31T00:00:00.000Z",
  });
  const document = renderStateDocument(state, "Keep this note exactly.\n");
  const parsed = parseStateDocument(document);

  assert.equal(parsed.state.state_schema_version, 4);
  assert.deepEqual(parsed.state, state);
  assert.equal(parsed.userNotes, "Keep this note exactly.\n");
});

test("version 1 state migrates through v3 to v4 without losing Kimi evidence", () => {
  const state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "legacy" });
  state.state_schema_version = 1;
  delete state.reviewer_policy;
  delete state.last_reviewer_review;
  state.last_kimi_review = { mode: "rehydrate", status: "READY", raw_result_ref: "/tmp/result.json" };
  const parsed = parseStateDocument(renderStateDocument(state, "legacy note\n"));

  assert.equal(parsed.state.state_schema_version, 4);
  assert.equal(parsed.state.last_reviewer_review.reviewer, "kimi");
  assert.equal(parsed.state.last_reviewer_review.raw_result_ref, "/tmp/result.json");
  assert.equal(parsed.state.reviewer_policy.selected, null);
  assert.equal(parsed.state.semantic_review.status, "PENDING");
  assert.equal(parsed.userNotes, "legacy note\n");
});

test("version 2 Red state migrates in place to TESTS_WRITTEN with a map requirement", () => {
  const state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "legacy-v2" });
  state.state_schema_version = 2;
  state.status = "RED_CONFIRMED";
  state.evidence.push({ event: "red-observed", exit_code: 1 });
  state.reviewer_policy = {
    preferred: "kimi",
    fallback: "claude-code",
    repository_consent: true,
    required_context_tokens: 1_048_576,
  };
  state.reviewer_failover = { active: true, message: "quota exhausted" };
  const parsed = parseStateDocument(renderStateDocument(state, "keep\n"));

  assert.equal(parsed.state.state_schema_version, 4);
  assert.equal(parsed.state.status, "TESTS_WRITTEN");
  assert.equal(parsed.state.migration_requirements.test_maps, "PENDING");
  assert.deepEqual(parsed.state.evidence, state.evidence);
  assert.equal(parsed.state.reviewer_policy.selected, null);
  assert.equal(parsed.userNotes, "keep\n");
});

test("version 3 post-test state preserves its milestone with explicit legacy provenance", () => {
  const state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "legacy-v3" });
  state.state_schema_version = 3;
  state.status = "TESTS_REVIEWED";
  const parsed = parseStateDocument(renderStateDocument(state, ""));

  assert.equal(parsed.state.status, "TESTS_VALIDATED");
  assert.deepEqual(parsed.state.test_validation, {
    source: "legacy-reviewer",
    validated_at: state.updated_at,
    fingerprint: null,
    legacy: true,
  });
  assert.equal(parsed.state.migration_requirements.test_maps, "OPTIONAL_LEGACY");
});

test("reviewer selection is fixed for one run with a 1M read-only contract", () => {
  let state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "selection" });
  state = selectReviewer(state, "claude-code", { now: "2026-08-07T00:00:00.000Z" });
  assert.equal(state.reviewer_policy.selected, "claude-code");
  assert.equal("repository_access_authorized" in state.reviewer_policy, false);
  assert.equal(state.reviewer_policy.required_context_tokens, 1_048_576);
  assert.deepEqual(selectReviewer(state, "claude-code"), state);
  assert.throws(() => selectReviewer(state, "kimi"), /fixed for the run/);
});

test("current state ignores and removes the retired repository authorization field", () => {
  const state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "retired-authorization" });
  state.reviewer_policy.repository_access_authorized = false;
  const parsed = parseStateDocument(renderStateDocument(state, ""));
  assert.equal("repository_access_authorized" in parsed.state.reviewer_policy, false);
  assert.equal(selectReviewer(state, "kimi").reviewer_policy.repository_access_authorized, undefined);
});

test("state events enforce local test validation before implementation", () => {
  let state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "run-tdd" });
  state = applyStateEvent(state, "bootstrap-ready", {});
  state = applyStateEvent(state, "tests-written", { test_mappings: [mapping], exception_ac_ids: [] });
  state = applyStateEvent(state, "red-planned", { expected_failure: "missing", ac_ids: ["AC-001"] });
  state = applyStateEvent(state, "red-observed", {
    command: "npm test",
    exit_code: 1,
    matched_expectation: true,
    tests: [{ path: mapping.path, sha256: sha }],
  });
  assert.equal(state.status, "TESTS_WRITTEN");
  state = applyStateEvent(state, "tests-validated", { source: "local-deterministic", fingerprint: "tests-fp" });
  state = applyStateEvent(state, "implementation-started", {});
  state = applyStateEvent(state, "green-observed", {
    command: "npm test",
    exit_code: 0,
    tests: [{ path: mapping.path, sha256: sha }],
    run_fingerprint: "run-fp",
  });
  assert.equal(state.status, "GREEN_CONFIRMED");
  state = applyStateEvent(state, "verification-observed", {
    command: "npm run build",
    exit_code: 0,
    tests: [],
    run_fingerprint: "run-fp",
  });
  state = applyStateEvent(state, "audited", { review_status: "READY" });
  state = applyStateEvent(state, "completed", {});
  assert.equal(state.status, "COMPLETED");
  assert.equal(state.active, false);
  assert.equal(state.semantic_review.status, "AUDITED");
});

test("Green remains IMPLEMENTING until every mapped path has current evidence", () => {
  let state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "run-green" });
  state = applyStateEvent(state, "bootstrap-ready", {});
  state = applyStateEvent(state, "tests-written", {
    test_mappings: [
      mapping,
      { ac_id: "AC-002", path: "test/edge.test.mjs", sha256: "b".repeat(64) },
    ],
    exception_ac_ids: [],
  });
  state = applyStateEvent(state, "tests-validated", { source: "local-deterministic", fingerprint: "tests-fp" });
  state = applyStateEvent(state, "implementation-started", {});
  state = applyStateEvent(state, "green-observed", {
    command: "npm test module",
    exit_code: 0,
    tests: [{ path: mapping.path, sha256: sha }],
    run_fingerprint: "run-fp",
  });
  assert.equal(state.status, "IMPLEMENTING");
});

test("all-exception workflow validates locally without fabricated Red", () => {
  let state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "run-exception" });
  state = applyStateEvent(state, "bootstrap-ready", {});
  state = applyStateEvent(state, "test-exception", { reason: "docs", ac_ids: ["AC-001"] });
  state = applyStateEvent(state, "tests-written", { test_mappings: [], exception_ac_ids: ["AC-001"] });
  state = applyStateEvent(state, "tests-validated", { source: "local-deterministic", fingerprint: "empty-tests" });
  state = applyStateEvent(state, "implementation-started", {});
  state = applyStateEvent(state, "green-observed", {
    command: "npm run lint",
    exit_code: 0,
    tests: [],
    run_fingerprint: "run-fp",
  });
  assert.equal(state.status, "GREEN_CONFIRMED");
});

test("review invocation ledger upserts failed or successful prompt submissions", () => {
  let state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "ledger" });
  state = recordReviewInvocation(state, {
    invocation_id: "inv-1",
    mode: "audit",
    reviewer: "kimi",
    status: "RUNNING",
  });
  state = recordReviewInvocation(state, {
    invocation_id: "inv-1",
    status: "FAILED",
    error: { kind: "SCHEMA", message: "bad output" },
  });
  assert.equal(state.review_invocations.length, 1);
  assert.equal(state.review_invocations[0].status, "FAILED");
});

test("future state schema versions fail closed", () => {
  const state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "future" });
  state.state_schema_version = 99;
  assert.throws(() => parseStateDocument(renderStateDocument(state, "")), /newer|upgrade/i);
});

test("repeated blocking preserves the original previous status", () => {
  let state = createInitialState({ specPath: "spec.md", specSha256: sha, runId: "blocked" });
  state = applyStateEvent(state, "bootstrap-ready", {});
  state = applyStateEvent(state, "blocked", { reason: "first" });
  state = applyStateEvent(state, "blocked", { reason: "second" });
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.previous_status, "BOOTSTRAP_READY");
});
