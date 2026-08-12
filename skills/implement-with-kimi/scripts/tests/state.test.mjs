import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStateEvent,
  createInitialState,
  deriveStatePath,
  parseStateDocument,
  renderStateDocument,
  selectReviewer,
} from "../lib/state.mjs";

test("deriveStatePath pairs a Markdown specification with one state document", () => {
  assert.equal(deriveStatePath("docs/tasks/payment.md"), "docs/tasks/payment.state.md");
  assert.throws(() => deriveStatePath("docs/tasks/payment.txt"), /Markdown/);
});

test("state rendering round-trips managed JSON and preserves user notes", () => {
  const state = createInitialState({
    specPath: "docs/tasks/payment.md",
    specSha256: "a".repeat(64),
    runId: "run-1",
    now: "2026-07-31T00:00:00.000Z",
  });
  const document = renderStateDocument(state, "Keep this note exactly.\n");
  const parsed = parseStateDocument(document);

  assert.deepEqual(parsed.state, state);
  assert.equal(parsed.userNotes, "Keep this note exactly.\n");
  assert.match(document, /implement-with-kimi:managed:start/);
});

test("version 1 state migrates to v3 without losing Kimi review evidence", () => {
  const state = createInitialState({ specPath: "spec.md", specSha256: "f".repeat(64), runId: "legacy" });
  state.state_schema_version = 1;
  delete state.reviewer_policy;
  delete state.reviewer_failover;
  delete state.last_reviewer_review;
  state.last_kimi_review = { reviewer: "claude-code", mode: "rehydrate", status: "READY", raw_result_ref: "/tmp/result.json" };
  const parsed = parseStateDocument(renderStateDocument(state, "legacy note\n"));
  assert.equal(parsed.state.state_schema_version, 3);
  assert.equal(parsed.state.run_id, "legacy");
  assert.equal(parsed.state.last_reviewer_review.reviewer, "kimi");
  assert.equal(parsed.state.last_reviewer_review.raw_result_ref, "/tmp/result.json");
  assert.equal(parsed.state.reviewer_policy.selected, null);
  assert.equal(parsed.state.history.at(-1).details.reviewer_selection_required, true);
  assert.equal(parsed.userNotes, "legacy note\n");
});

test("version 2 migration preserves execution evidence and records the complete legacy route", () => {
  const state = createInitialState({ specPath: "spec.md", specSha256: "a".repeat(64), runId: "legacy-v2" });
  state.state_schema_version = 2;
  state.status = "RED_CONFIRMED";
  state.evidence.push({ event: "red-observed", exit_code: 1 });
  state.unresolved_findings.push({ id: "F-001" });
  state.past_runs.push({ run_id: "older" });
  state.reviewer_policy = {
    preferred: "kimi",
    fallback: "claude-code",
    repository_consent: true,
    required_context_tokens: 1_048_576,
    enabled_at: "2026-08-07T00:00:00.000Z",
  };
  state.reviewer_failover = {
    active: true,
    scope: "RUN",
    reason_code: "KIMI_QUOTA_EXHAUSTED",
    message: "quota exhausted",
    activated_at: "2026-08-07T00:01:00.000Z",
  };
  const parsed = parseStateDocument(renderStateDocument(state, "keep\n"));
  const legacy = parsed.state.history.at(-1).details.legacy_reviewer_routing;
  assert.equal(parsed.state.state_schema_version, 3);
  assert.equal(parsed.state.reviewer_policy.selected, null);
  assert.deepEqual(parsed.state.evidence, state.evidence);
  assert.deepEqual(parsed.state.unresolved_findings, state.unresolved_findings);
  assert.deepEqual(parsed.state.past_runs, state.past_runs);
  assert.equal(legacy.repository_consent, true);
  assert.equal(legacy.required_context_tokens, 1_048_576);
  assert.equal(legacy.enabled_at, "2026-08-07T00:00:00.000Z");
  assert.equal(legacy.failover_message, "quota exhausted");
  assert.equal(legacy.failover_activated_at, "2026-08-07T00:01:00.000Z");
  assert.equal(parsed.userNotes, "keep\n");
});

test("reviewer selection authorizes repository access and preserves run evidence", () => {
  let state = createInitialState({ specPath: "spec.md", specSha256: "a".repeat(64), runId: "selection" });
  state.evidence.push({ event: "red-observed", exit_code: 1 });
  state = selectReviewer(state, "claude-code", { now: "2026-08-07T00:00:00.000Z" });
  assert.equal(state.reviewer_policy.selected, "claude-code");
  assert.equal(state.reviewer_policy.repository_access_authorized, true);
  assert.equal(state.reviewer_policy.required_context_tokens, 1_048_576);
  assert.deepEqual(state.evidence, [{ event: "red-observed", exit_code: 1 }]);
  assert.deepEqual(state.history.at(-1).details, {
    previous: null,
    selected: "claude-code",
    repository_access_authorized: true,
    required_context_tokens: 1_048_576,
  });
});

test("state events enforce the TDD transition order", () => {
  let state = createInitialState({
    specPath: "docs/tasks/payment.md",
    specSha256: "b".repeat(64),
    runId: "run-2",
    now: "2026-07-31T00:00:00.000Z",
  });

  state = applyStateEvent(state, "bootstrap-ready", {}, "2026-07-31T00:01:00.000Z");
  state = applyStateEvent(state, "tests-written", { ac_ids: ["AC-001"] }, "2026-07-31T00:02:00.000Z");
  state = applyStateEvent(
    state,
    "red-planned",
    { expected_failure: "missing behavior", ac_ids: ["AC-001"] },
    "2026-07-31T00:03:00.000Z",
  );
  state = applyStateEvent(
    state,
    "red-observed",
    { command: "npm test", exit_code: 1, matched_expectation: true },
    "2026-07-31T00:04:00.000Z",
  );

  assert.equal(state.status, "RED_CONFIRMED");
  assert.throws(
    () => applyStateEvent(state, "green-observed", { exit_code: 0 }, "2026-07-31T00:05:00.000Z"),
    /TESTS_REVIEWED|IMPLEMENTING/,
  );
});

test("future state schema versions fail closed", () => {
  const state = createInitialState({
    specPath: "spec.md",
    specSha256: "c".repeat(64),
    runId: "run-3",
  });
  state.state_schema_version = 99;
  const document = renderStateDocument(state, "");
  assert.throws(() => parseStateDocument(document), /newer|upgrade/i);
});

test("repeated blocking preserves the original previous status", () => {
  let state = createInitialState({
    specPath: "spec.md",
    specSha256: "d".repeat(64),
    runId: "run-4",
  });
  state = applyStateEvent(state, "bootstrap-ready", {});
  state = applyStateEvent(state, "blocked", { reason: "first" });
  state = applyStateEvent(state, "blocked", { reason: "second" });
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.previous_status, "BOOTSTRAP_READY");
});

test("all-exception workflow may reach test review without fabricating Red", () => {
  let state = createInitialState({
    specPath: "spec.md",
    specSha256: "e".repeat(64),
    runId: "run-5",
  });
  state = applyStateEvent(state, "bootstrap-ready", {});
  state = applyStateEvent(state, "test-exception", { reason: "documentation only", ac_ids: ["AC-001"] });
  state = applyStateEvent(state, "tests-written", { ac_ids: [], exception_ac_ids: ["AC-001"] });
  state = applyStateEvent(state, "tests-reviewed", { review_status: "READY" });
  assert.equal(state.status, "TESTS_REVIEWED");
});
