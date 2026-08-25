const LOG_EXCERPT_LIMIT = 2_000;

export function buildReviewStateSummary(state) {
  return {
    status: state.status,
    semantic_review: state.semantic_review,
    test_mappings: state.test_mappings ?? [],
    test_validation: state.test_validation,
    effective_evidence: effectiveEvidence(state).map(sanitizeRecordedEvidence),
    unresolved_findings: state.unresolved_findings ?? [],
    warnings: currentWarnings(state.warnings ?? []),
    authority_hashes: state.authority_hashes,
    run_fingerprint: state.run_fingerprint,
    implementation_fingerprint: state.implementation_fingerprint,
  };
}

export function effectiveEvidence(state) {
  const evidence = state.evidence ?? [];
  if (state.test_validation?.legacy === true) return evidence;
  const mappings = new Map((state.test_mappings ?? []).map((item) => [item.path, item.sha256]));
  const current = evidence.filter((item) => {
    if (item.event === "test-exception") return true;
    if (["red-observed", "baseline-green-observed"].includes(item.event)) {
      return (item.tests ?? []).some((testFile) => mappings.get(testFile.path) === testFile.sha256);
    }
    if (["green-observed", "verification-observed"].includes(item.event)) {
      return item.run_fingerprint && item.run_fingerprint === state.implementation_fingerprint;
    }
    return false;
  });
  const latest = new Map();
  for (const item of current) {
    const tests = (item.tests ?? []).map((testFile) => testFile.path).sort().join(",");
    const key = item.event === "verification-observed"
      ? `${item.event}:${item.command}`
      : `${item.event}:${tests || (item.ac_ids ?? []).join(",")}`;
    latest.set(key, item);
  }
  return [...latest.values()];
}

function sanitizeRecordedEvidence(record) {
  const sanitized = structuredClone(record);
  if (!sanitized.log || typeof sanitized.log !== "object") return sanitized;

  const hadDiagnosticPath = typeof sanitized.log.path === "string" && sanitized.log.path !== "";
  delete sanitized.log.path;
  sanitized.log.kind = "recorded_execution_log";
  sanitized.log.citation_policy = "metadata_only_not_local_file_evidence";
  if (hadDiagnosticPath) sanitized.log.diagnostic_path_redacted = true;
  if (typeof sanitized.log.excerpt === "string" && sanitized.log.excerpt.length > LOG_EXCERPT_LIMIT) {
    const half = Math.floor(LOG_EXCERPT_LIMIT / 2);
    sanitized.log.excerpt = `${sanitized.log.excerpt.slice(0, half)}\n... AUDIT PROJECTION TRUNCATED ...\n${sanitized.log.excerpt.slice(-half)}`;
    sanitized.log.projection_truncated = true;
  }
  return sanitized;
}

function currentWarnings(warnings) {
  const latest = new Map();
  for (const warning of warnings) {
    latest.set(warning.code ?? warning.id ?? warning.title ?? JSON.stringify(warning), warning);
  }
  return [...latest.values()];
}
