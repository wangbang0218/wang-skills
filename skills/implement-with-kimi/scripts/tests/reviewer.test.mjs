import assert from "node:assert/strict";
import test from "node:test";

import { classifyKimiFallback, fallbackEnabled, shouldUseStickyFallback } from "../lib/reviewer.mjs";

test("Kimi account and quota failures activate run-sticky fallback", () => {
  assert.deepEqual(classifyKimiFallback(new Error("Billing cycle quota exhausted")), {
    scope: "RUN",
    reason_code: "KIMI_QUOTA_EXHAUSTED",
  });
  const auth = new Error("Kimi authentication is required; run kimi login first.");
  auth.kind = "CONFIG";
  assert.equal(classifyKimiFallback(auth).reason_code, "KIMI_AUTH_REQUIRED");
});

test("temporary membership and service failures fall back for one node", () => {
  assert.deepEqual(classifyKimiFallback(new Error("402 unable to verify membership temporarily")), {
    scope: "NODE",
    reason_code: "KIMI_TRANSIENT_UNAVAILABLE",
  });
  assert.equal(classifyKimiFallback(new Error("503 engine overload")).scope, "NODE");
});

test("policy, evidence, and terminated access never fall back", () => {
  for (const kind of ["SCHEMA", "EVIDENCE", "STALE", "POLICY_VIOLATION", "BLOCKED", "CONFLICT"]) {
    const error = new Error("deterministic failure");
    error.kind = kind;
    assert.equal(classifyKimiFallback(error), null);
  }
  assert.equal(classifyKimiFallback(new Error("Access terminated")), null);
});

test("fallback requires per-run consent and a declared 1M context", () => {
  const state = {
    reviewer_policy: {
      fallback: "claude-code",
      repository_consent: true,
      required_context_tokens: 1_048_576,
    },
    reviewer_failover: { active: true, scope: "RUN" },
  };
  assert.equal(fallbackEnabled(state), true);
  assert.equal(shouldUseStickyFallback(state), true);
  state.reviewer_policy.required_context_tokens = 262_144;
  assert.equal(fallbackEnabled(state), false);
});
