export function buildReviewStateSummary(state) {
  return {
    status: state.status,
    evidence: (state.evidence ?? []).map(sanitizeRecordedEvidence),
    unresolved_findings: state.unresolved_findings,
    warnings: state.warnings,
    authority_hashes: state.authority_hashes,
  };
}

function sanitizeRecordedEvidence(record) {
  const sanitized = structuredClone(record);
  if (!sanitized.log || typeof sanitized.log !== "object") return sanitized;

  const hadDiagnosticPath = typeof sanitized.log.path === "string" && sanitized.log.path !== "";
  delete sanitized.log.path;
  sanitized.log.kind = "recorded_execution_log";
  sanitized.log.citation_policy = "metadata_only_not_local_file_evidence";
  if (hadDiagnosticPath) sanitized.log.diagnostic_path_redacted = true;
  return sanitized;
}
