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
    { path: "spec.md", estimated_tokens: 700, tier: 1 },
    { path: "AGENTS.md", estimated_tokens: 500, tier: 2 },
  ];
  const result = selectContextFiles(catalog, {
    budgetTokens: 1_000,
    requiredPaths: ["spec.md", "AGENTS.md"],
  });

  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /mandatory/i);
  assert.deepEqual(result.selected, []);
});

test("selection records every omitted file with a reason", () => {
  const catalog = [
    { path: "spec.md", estimated_tokens: 100, tier: 1 },
    { path: "src/a.js", estimated_tokens: 200, tier: 3 },
    { path: "examples/large.txt", estimated_tokens: 900, tier: 6 },
  ];
  const result = selectContextFiles(catalog, {
    budgetTokens: 400,
    requiredPaths: ["spec.md"],
  });

  assert.equal(result.status, "READY");
  assert.deepEqual(result.selected.map((item) => item.path), ["spec.md", "src/a.js"]);
  assert.deepEqual(result.omitted, [
    { path: "examples/large.txt", reason: "context_budget", estimated_tokens: 900 },
  ]);
});
