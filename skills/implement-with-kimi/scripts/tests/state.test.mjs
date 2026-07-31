import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStateEvent,
  createInitialState,
  deriveStatePath,
  parseStateDocument,
  renderStateDocument,
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
