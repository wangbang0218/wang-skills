export const REVIEWERS = Object.freeze(["kimi", "claude-code"]);
export const REQUIRED_CONTEXT_TOKENS = 1_048_576;

export function isReviewer(value) {
  return REVIEWERS.includes(value);
}

export function selectedReviewer(state) {
  const reviewer = state?.reviewer_policy?.selected;
  return isReviewer(reviewer) ? reviewer : null;
}

export function requireSelectedReviewerPolicy(state) {
  const policy = state?.reviewer_policy;
  const reviewer = selectedReviewer(state);
  if (!reviewer) {
    throw codedError("WORKFLOW", "No reviewer is selected for this run; use select-reviewer --reviewer kimi|claude-code.");
  }
  if (policy.repository_access_authorized !== true) {
    throw codedError("WORKFLOW", "Reviewer repository access is not authorized for this run; select the reviewer again.");
  }
  if (policy.required_context_tokens !== REQUIRED_CONTEXT_TOKENS) {
    throw codedError("WORKFLOW", "Reviewer policy must require a 1,048,576-token context; select the reviewer again.");
  }
  return reviewer;
}

function codedError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}
