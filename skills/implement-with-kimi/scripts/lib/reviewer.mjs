const NON_FALLBACK_KINDS = new Set([
  "SCHEMA",
  "EVIDENCE",
  "STALE",
  "POLICY_VIOLATION",
  "PROTOCOL",
  "CONTEXT_COMPACTED",
  "CONTEXT_OVERSIZE",
  "BLOCKED",
  "CONFLICT",
  "WORKFLOW",
]);

export function classifyKimiFallback(error) {
  const message = `${error?.code ?? ""} ${error?.message ?? ""}`;
  if (/access terminated|account (?:terminated|disabled|suspended)|abuse|safety enforcement/i.test(message)) return null;
  if (NON_FALLBACK_KINDS.has(error?.kind)) return null;

  if (
    /authentication is required|run kimi login|invalid auth|invalid api key|\b401\b|quota (?:is )?exhausted|quota exhausted|billing cycle quota|monthly quota|rolling quota|subscription.{0,40}(?:required|unavailable)|membership.{0,40}(?:required|expired)|no (?:k3|1m|model) access|required k3 model alias is not configured|not k3 with a .{0,30}context window|model access.{0,40}(?:denied|unavailable)|entitlement/i.test(message)
  ) {
    return { scope: "RUN", reason_code: fallbackReasonCode(message) };
  }

  if (
    /unable to verify membership|membership verification|\b402\b|engine overload|concurrent requests?|\b429\b|\b5\d\d\b|network|ECONN|EAI_AGAIN|temporar|idle timeout/i.test(message)
  ) {
    return { scope: "NODE", reason_code: "KIMI_TRANSIENT_UNAVAILABLE" };
  }
  return null;
}

export function fallbackEnabled(state) {
  return state?.reviewer_policy?.fallback === "claude-code" &&
    state.reviewer_policy.repository_consent === true &&
    state.reviewer_policy.required_context_tokens === 1_048_576;
}

export function shouldUseStickyFallback(state) {
  return fallbackEnabled(state) && state?.reviewer_failover?.active === true && state.reviewer_failover.scope === "RUN";
}

function fallbackReasonCode(message) {
  if (/quota|billing cycle|monthly|rolling/i.test(message)) return "KIMI_QUOTA_EXHAUSTED";
  if (/subscription|membership|entitlement|model access|no (?:k3|1m|model) access/i.test(message)) {
    return "KIMI_ENTITLEMENT_UNAVAILABLE";
  }
  return "KIMI_AUTH_REQUIRED";
}
