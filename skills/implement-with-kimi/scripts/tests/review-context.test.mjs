import assert from "node:assert/strict";
import test from "node:test";

import { buildKimiPrompt } from "../lib/prompt.mjs";
import { INITIAL_CONTEXT_BUDGET, renderContextPack } from "../lib/repository.mjs";
import { buildReviewStateSummary, effectiveEvidence } from "../lib/review-context.mjs";

test("audit projection keeps only current evidence and redacts execution-log paths", () => {
  const currentSha = "c".repeat(64);
  const state = {
    status: "VERIFIED",
    semantic_review: "PENDING",
    test_mappings: [{ ac_id: "AC-001", path: "test/example.test.mjs", sha256: currentSha }],
    test_validation: { validated_at: "2026-08-25T00:00:00.000Z" },
    implementation_fingerprint: "fingerprint-current",
    run_fingerprint: "fingerprint-current",
    evidence: [
      { event: "red-observed", tests: [{ path: "test/example.test.mjs", sha256: "s".repeat(64) }], command: "node --test test/example.test.mjs", exit_code: 1 },
      { event: "red-observed", tests: [{ path: "test/example.test.mjs", sha256: currentSha }], command: "node --test test/example.test.mjs", exit_code: 1 },
      {
        event: "green-observed",
        tests: [{ path: "test/example.test.mjs", sha256: currentSha }],
        run_fingerprint: "fingerprint-current",
        command: "node --test test/example.test.mjs",
        exit_code: 0,
        log: { path: "/tmp/green.log", sha256: "a".repeat(64), excerpt: "x".repeat(2_500) },
      },
      { event: "verification-observed", run_fingerprint: "fingerprint-old", command: "node --check src/example.mjs", exit_code: 0 },
      { event: "verification-observed", run_fingerprint: "fingerprint-current", command: "node --check src/example.mjs", exit_code: 0 },
    ],
    unresolved_findings: [],
    warnings: [],
    authority_hashes: { "docs/authority.md": "b".repeat(64) },
  };

  assert.equal(effectiveEvidence(state).length, 3);
  const summary = buildReviewStateSummary(state);
  assert.equal(summary.effective_evidence.length, 3);
  const green = summary.effective_evidence.find((item) => item.event === "green-observed");
  assert.equal(green.log.path, undefined);
  assert.equal(green.log.sha256, "a".repeat(64));
  assert.equal(green.log.kind, "recorded_execution_log");
  assert.equal(green.log.diagnostic_path_redacted, true);
  assert.equal(green.log.projection_truncated, true);
  assert.match(green.log.excerpt, /AUDIT PROJECTION TRUNCATED/);
  assert.equal(state.evidence[2].log.path, "/tmp/green.log");

  const contextPack = renderContextPack({
    selected: [], omitted: [], excluded: [], estimated_tokens: 0,
    mandatory_tokens: 0, budget_tokens: INITIAL_CONTEXT_BUDGET,
  }, { state_summary: summary });
  const prompt = buildKimiPrompt({
    mode: "audit",
    runId: "run-redaction",
    specPath: "docs/tasks/module.md",
    effort: "max",
    contextPack,
  });
  assert.equal(prompt.includes("/tmp/green.log"), false);
  assert.match(prompt, /node --test test\/example\.test\.mjs/);
});

test("legacy post-test migrations retain their evidence without fabricating hashes", () => {
  const legacy = [{ event: "green-observed", command: "old suite", exit_code: 0 }];
  assert.deepEqual(effectiveEvidence({ test_validation: { legacy: true }, evidence: legacy }), legacy);
});
