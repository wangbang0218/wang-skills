import assert from "node:assert/strict";
import test from "node:test";

import { buildCapsule, computeStatus, validateKimiEnvelope } from "../lib/schema.mjs";

function envelope(findings = []) {
  return {
    schema_version: 1,
    mode: "audit",
    run_id: "run-1",
    summary: "审查完成",
    findings,
    ac_coverage: [],
    next_actions: [],
    external_research: { status: "NOT_REQUESTED", sources: [] },
    context: { completeness: "FULL", omissions: [], compacted: false },
  };
}

const blockingEvidence = [{
  path: "spec.md",
  sha256: "a".repeat(64),
  line_start: 1,
  line_end: 1,
  excerpt: "# Spec",
  claim: "The specification is the authority.",
}];

test("status precedence is CONFLICT > BLOCKED > WARNING > READY", () => {
  assert.equal(computeStatus([]), "READY");
  assert.equal(computeStatus([{ severity: "WARNING" }]), "WARNING");
  assert.equal(computeStatus([{ severity: "BLOCKED" }, { severity: "WARNING" }]), "BLOCKED");
  assert.equal(computeStatus([{ severity: "CONFLICT" }, { severity: "BLOCKED" }]), "CONFLICT");
});

test("Kimi envelope status is computed rather than trusted", () => {
  const input = envelope([
    {
      id: "F-001",
      severity: "BLOCKED",
      title: "缺少验收证据",
      explanation: "AC-001 没有对应测试",
      evidence: blockingEvidence,
    },
  ]);
  input.status = "READY";

  const result = validateKimiEnvelope(input, { mode: "audit", runId: "run-1" });
  assert.equal(result.status, "BLOCKED");
});

test("selector findings are rejected before unverified evidence can be accepted", () => {
  const input = envelope([{
    id: "SEL-001",
    severity: "INFO",
    title: "Imagined file contents",
    explanation: "The metadata-only catalog does not support this claim.",
    evidence: [{
      path: "lib/example.dart",
      sha256: "a".repeat(64),
      line_start: 1,
      line_end: 1,
      excerpt: "export 'src/example.dart';",
      claim: "Invented from a conventional package layout.",
    }],
  }]);
  input.mode = "selector";

  assert.throws(
    () => validateKimiEnvelope(input, { mode: "selector", runId: "run-1" }),
    /Selector output findings must be empty.*metadata-only/,
  );
  input.findings = [];
  input.selected_paths = ["lib/example.dart"];
  assert.doesNotThrow(() => validateKimiEnvelope(input, { mode: "selector", runId: "run-1" }));
});

test("capsule keeps every blocking finding and reports folded warnings", () => {
  const warnings = Array.from({ length: 200 }, (_, index) => ({
    id: `W-${index}`,
    severity: "WARNING",
    title: `warning-${index}-${"x".repeat(300)}`,
    explanation: "detail",
    evidence: [],
  }));
  const input = envelope([
    {
      id: "F-BLOCK",
      severity: "BLOCKED",
      title: "must remain",
      explanation: "blocking detail",
      evidence: blockingEvidence,
    },
    ...warnings,
  ]);

  const capsule = buildCapsule(validateKimiEnvelope(input, { mode: "audit", runId: "run-1" }), {
    maxBytes: 32 * 1024,
  });
  const encoded = Buffer.from(JSON.stringify(capsule));

  assert.ok(encoded.byteLength <= 32 * 1024);
  assert.ok(capsule.findings.some((finding) => finding.id === "F-BLOCK"));
  assert.ok(capsule.folded_findings > 0);
});

test("blocking findings require evidence and AC coverage is validated", () => {
  assert.throws(
    () => validateKimiEnvelope(envelope([{ id: "F-1", severity: "BLOCKED", title: "x", explanation: "y", evidence: [] }])),
    /must include evidence/,
  );

  const input = envelope([]);
  input.ac_coverage = [{ ac_id: "AC-001", status: "COVERED", test_refs: ["tests/example.test.mjs"] }];
  assert.equal(validateKimiEnvelope(input).ac_coverage[0].status, "COVERED");
  input.ac_coverage[0].status = "UNKNOWN";
  assert.throws(() => validateKimiEnvelope(input), /invalid status/);
});

test("reviewer self-compaction is rejected with a retryable code", () => {
  const input = envelope([]);
  input.context.compacted = true;
  assert.throws(
    () => validateKimiEnvelope(input),
    (error) => error.code === "REVIEWER_CONTEXT_COMPACTED",
  );
});

test("AC coverage must exactly match the specification when expected ids are supplied", () => {
  const input = envelope([]);
  input.ac_coverage = [{ ac_id: "AC-001", status: "COVERED", test_refs: ["test.mjs"] }];
  assert.doesNotThrow(() => validateKimiEnvelope(input, { acIds: ["AC-001"] }));
  assert.throws(() => validateKimiEnvelope(input, { acIds: ["AC-001", "AC-002"] }), /coverage mismatch/);
});

test("required arrays and object fields fail closed", () => {
  const input = envelope([]);
  delete input.next_actions;
  assert.throws(() => validateKimiEnvelope(input), /next_actions/);
  const duplicate = envelope([
    { id: "F-1", severity: "INFO", title: "one", explanation: "one", evidence: [] },
    { id: "F-1", severity: "INFO", title: "two", explanation: "two", evidence: [] },
  ]);
  assert.throws(() => validateKimiEnvelope(duplicate), /duplicate finding ids/);
});

test("nested collection item types fail closed", () => {
  const objectActions = envelope([]);
  objectActions.next_actions = [{ action: "继续审查", priority: "HIGH" }];
  assert.throws(() => validateKimiEnvelope(objectActions), /next_actions.*non-empty strings/);

  const scalarOmissions = envelope([]);
  scalarOmissions.context.omissions = "无遗漏";
  assert.throws(() => validateKimiEnvelope(scalarOmissions), /omissions.*array of strings/);

  const objectOmissions = envelope([]);
  objectOmissions.context.omissions = [{ path: "ignored.txt" }];
  assert.throws(() => validateKimiEnvelope(objectOmissions), /omissions.*array of strings/);
});

test("selector requires non-empty selected paths during envelope validation", () => {
  const input = envelope([]);
  input.mode = "selector";
  assert.throws(() => validateKimiEnvelope(input), /selected_paths.*non-empty strings/);

  input.selected_paths = ["src/example.dart"];
  assert.doesNotThrow(() => validateKimiEnvelope(input));

  input.selected_paths = [""];
  assert.throws(() => validateKimiEnvelope(input), /selected_paths.*non-empty strings/);
});

test("context extensions remain compatible with Kimi and local validation", () => {
  const input = envelope([]);
  input.context.token_count = 42;
  assert.doesNotThrow(() => validateKimiEnvelope(input));
});
