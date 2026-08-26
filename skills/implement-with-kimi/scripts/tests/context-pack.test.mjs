import assert from "node:assert/strict";
import test from "node:test";

import { estimateTokens, selectContextFiles } from "../lib/context-pack.mjs";

test("token estimation is conservative and non-zero", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("hello world") >= 3);
  assert.ok(estimateTokens("中文上下文") >= 4);
});

test("mandatory context is never silently truncated", () => {
  const catalog = [
    { path: "spec.md", estimated_tokens: 700, tier: 0 },
    { path: "AGENTS.md", estimated_tokens: 500, tier: 0 },
  ];
  const result = selectContextFiles(catalog, {
    budgetTokens: 1_000,
    requiredPaths: ["spec.md", "AGENTS.md"],
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocker, "mandatory_overflow");
  assert.match(result.reason, /mandatory/i);
  assert.deepEqual(result.selected, []);
});

test("selection records every omitted file and preserves deterministic tier/path order", () => {
  const catalog = [
    { path: "spec.md", sha256: "a".repeat(64), estimated_tokens: 100, tier: 0 },
    { path: "src/b.js", sha256: "b".repeat(64), estimated_tokens: 200, tier: 3 },
    { path: "src/a.js", sha256: "c".repeat(64), estimated_tokens: 200, tier: 3 },
    { path: "examples/large.txt", sha256: "d".repeat(64), estimated_tokens: 900, tier: 6 },
  ];
  const result = selectContextFiles(catalog, {
    budgetTokens: 500,
    requiredPaths: ["spec.md"],
  });
  assert.equal(result.status, "READY");
  assert.deepEqual(result.selected.map((item) => item.path), ["spec.md", "src/a.js", "src/b.js"]);
  assert.equal(result.mandatory_tokens, 100);
  assert.deepEqual(result.omitted, [{
    path: "examples/large.txt",
    sha256: "d".repeat(64),
    reason: "context_budget",
    estimated_tokens: 900,
  }]);
});

test("a missing mandatory path blocks before optional selection", () => {
  const result = selectContextFiles([], {
    budgetTokens: 700_000,
    requiredPaths: ["test/mapped.test.mjs"],
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocker, "missing_mandatory");
  assert.match(result.reason, /Missing mandatory context: test\/mapped\.test\.mjs/);
});
