import assert from "node:assert/strict";
import test from "node:test";

import {
  isReviewer,
  REQUIRED_CONTEXT_TOKENS,
  requireSelectedReviewerPolicy,
  selectedReviewer,
} from "../lib/reviewer.mjs";

test("reviewer selection accepts only Kimi and Claude Code", () => {
  assert.equal(isReviewer("kimi"), true);
  assert.equal(isReviewer("claude-code"), true);
  assert.equal(isReviewer(""), false);
  assert.equal(isReviewer("auto"), false);
});

test("a complete reviewer policy fixes one selected reviewer", () => {
  const state = {
    reviewer_policy: {
      selected: "claude-code",
      required_context_tokens: REQUIRED_CONTEXT_TOKENS,
    },
  };
  assert.equal(selectedReviewer(state), "claude-code");
  assert.equal(requireSelectedReviewerPolicy(state), "claude-code");
});

test("reviewer policy fails closed when selection or 1M context is missing", () => {
  const valid = {
    reviewer_policy: {
      selected: "kimi",
      required_context_tokens: REQUIRED_CONTEXT_TOKENS,
    },
  };
  assert.throws(() => requireSelectedReviewerPolicy({ reviewer_policy: { ...valid.reviewer_policy, selected: null } }), /select-reviewer/);
  assert.equal(requireSelectedReviewerPolicy({
    reviewer_policy: { ...valid.reviewer_policy, repository_access_authorized: false },
  }), "kimi");
  assert.throws(
    () => requireSelectedReviewerPolicy({ reviewer_policy: { ...valid.reviewer_policy, required_context_tokens: 262_144 } }),
    /1,048,576/,
  );
});
