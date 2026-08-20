import assert from "node:assert/strict";
import test from "node:test";

import { buildKimiPrompt } from "../lib/prompt.mjs";
import { INITIAL_CONTEXT_BUDGET, renderContextPack } from "../lib/repository.mjs";
import { buildReviewStateSummary } from "../lib/review-context.mjs";

test("review context redacts external execution-log paths without losing recorded results", () => {
  const state = {
    status: "IMPLEMENTING",
    evidence: [
      {
        at: "2026-08-02T03:51:44.324Z",
        event: "red-observed",
        command: "fvm flutter test packages/template_engine/test",
        exit_code: 1,
        matched_expectation: true,
        log: {
          path: "/tmp/tag-mate-mod002-red.log",
          sha256: "a".repeat(64),
          bytes: 53_898,
          truncated: true,
          excerpt: "Error: Method not found: 'RasterImage'.",
        },
      },
    ],
    unresolved_findings: [],
    warnings: [],
    authority_hashes: { "docs/architecture/architecture.md": "b".repeat(64) },
  };

  const summary = buildReviewStateSummary(state);

  assert.equal(JSON.stringify(summary).includes("/tmp/tag-mate-mod002-red.log"), false);
  assert.equal(summary.evidence[0].log.path, undefined);
  assert.equal(summary.evidence[0].log.sha256, "a".repeat(64));
  assert.equal(summary.evidence[0].log.excerpt, "Error: Method not found: 'RasterImage'.");
  assert.equal(summary.evidence[0].log.kind, "recorded_execution_log");
  assert.equal(summary.evidence[0].log.citation_policy, "metadata_only_not_local_file_evidence");
  assert.equal(summary.evidence[0].log.diagnostic_path_redacted, true);
  assert.equal(state.evidence[0].log.path, "/tmp/tag-mate-mod002-red.log");

  const contextPack = renderContextPack(
    { selected: [], omitted: [], excluded: [], estimated_tokens: 0, budget_tokens: INITIAL_CONTEXT_BUDGET },
    { state_summary: summary },
  );
  const prompt = buildKimiPrompt({
    mode: "rehydrate",
    runId: "run-redaction",
    specPath: "docs/tasks/module.md",
    effort: "high",
    contextPack,
  });
  assert.equal(prompt.includes("/tmp/tag-mate-mod002-red.log"), false);
  assert.match(prompt, /fvm flutter test packages\/template_engine\/test/);
  assert.match(prompt, new RegExp("a{64}"));
});
