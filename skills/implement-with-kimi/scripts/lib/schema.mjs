const SEVERITIES = new Set(["CONFLICT", "BLOCKED", "WARNING", "INFO"]);
const MODES = new Set(["selector", "bootstrap", "review-tests", "rehydrate", "audit", "query"]);
const STATUS_ORDER = ["CONFLICT", "BLOCKED", "WARNING"];
const AC_STATUSES = new Set(["COVERED", "PARTIAL", "MISSING", "EXCEPTION"]);
const RESEARCH_STATUSES = new Set(["NOT_REQUESTED", "READY", "WARNING", "BLOCKED"]);
const CONTEXT_COMPLETENESS = new Set(["FULL", "PARTIAL"]);

export function computeStatus(findings) {
  for (const status of STATUS_ORDER) {
    if (findings.some((finding) => finding.severity === status)) return status;
  }
  return "READY";
}

export function validateKimiEnvelope(input, { mode, runId, acIds } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Kimi output must be a JSON object.");
  if (input.schema_version !== 1) throw new Error("Kimi output schema_version must be 1.");
  if (!MODES.has(input.mode)) throw new Error(`Unsupported Kimi mode: ${input.mode}`);
  if (mode && input.mode !== mode) throw new Error(`Kimi mode mismatch: expected ${mode}, received ${input.mode}.`);
  if (typeof input.run_id !== "string" || !input.run_id) throw new Error("Kimi output run_id is required.");
  if (runId && input.run_id !== runId) throw new Error("Kimi output run_id does not match the active run.");
  if (typeof input.summary !== "string" || !input.summary) throw new Error("Kimi output summary must be a non-empty string.");
  if (!Array.isArray(input.findings)) throw new Error("Kimi output findings must be an array.");

  const findings = input.findings.map((finding, index) => validateFinding(finding, index));
  assertUnique(findings.map((finding) => finding.id), "finding ids");
  if (!Array.isArray(input.ac_coverage)) throw new Error("Kimi output ac_coverage must be an array.");
  const acCoverage = input.ac_coverage.map((item, index) => validateAcCoverage(item, index));
  assertUnique(acCoverage.map((item) => item.ac_id), "AC coverage ids");
  if (acIds) assertExactAcCoverage(acCoverage, acIds);
  if (!Array.isArray(input.next_actions) || input.next_actions.some((item) => typeof item !== "string" || !item)) {
    throw new Error("Kimi output next_actions must be an array of non-empty strings.");
  }
  const nextActions = input.next_actions;
  const externalResearch = validateExternalResearch(input.external_research);
  const context = validateContext(input.context);

  return {
    ...input,
    status: computeStatus(findings),
    findings,
    ac_coverage: acCoverage,
    next_actions: nextActions,
    external_research: externalResearch,
    context,
  };
}

function validateFinding(finding, index) {
  if (!finding || typeof finding !== "object") throw new Error(`Finding ${index} must be an object.`);
  for (const key of ["id", "severity", "title", "explanation"]) {
    if (typeof finding[key] !== "string" || !finding[key]) throw new Error(`Finding ${index} is missing ${key}.`);
  }
  if (!SEVERITIES.has(finding.severity)) throw new Error(`Finding ${finding.id} has an invalid severity.`);
  if (!Array.isArray(finding.evidence)) throw new Error(`Finding ${finding.id} evidence must be an array.`);
  if (["CONFLICT", "BLOCKED"].includes(finding.severity) && finding.evidence.length === 0) {
    throw new Error(`Finding ${finding.id} must include evidence because it blocks progress.`);
  }
  return { ...finding, evidence: finding.evidence };
}

function validateAcCoverage(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`AC coverage ${index} must be an object.`);
  if (typeof item.ac_id !== "string" || !/^AC-\d{3,}$/.test(item.ac_id)) {
    throw new Error(`AC coverage ${index} has an invalid ac_id.`);
  }
  if (!AC_STATUSES.has(item.status)) throw new Error(`AC coverage ${item.ac_id} has an invalid status.`);
  if (!Array.isArray(item.test_refs) || item.test_refs.some((ref) => typeof ref !== "string" || !ref)) {
    throw new Error(`AC coverage ${item.ac_id} test_refs must be an array of non-empty strings.`);
  }
  return item;
}

function validateExternalResearch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("external_research must be an object.");
  const research = value;
  if (!RESEARCH_STATUSES.has(research.status)) throw new Error("external_research.status is invalid.");
  if (!Array.isArray(research.sources)) throw new Error("external_research.sources must be an array.");
  return research;
}

function validateContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("context must be an object.");
  const context = value;
  if (!CONTEXT_COMPLETENESS.has(context.completeness)) throw new Error("context.completeness must be FULL or PARTIAL.");
  if (!Array.isArray(context.omissions)) throw new Error("context.omissions must be an array.");
  if (typeof context.compacted !== "boolean") throw new Error("context.compacted must be a boolean.");
  if (context.compacted === true) {
    const error = new Error("Kimi reported that its own context was compacted.");
    error.code = "KIMI_CONTEXT_COMPACTED";
    throw error;
  }
  return context;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`Kimi output contains duplicate ${label}.`);
}

function assertExactAcCoverage(coverage, expectedIds) {
  const actual = new Set(coverage.map((item) => item.ac_id));
  const expected = new Set(expectedIds);
  const missing = [...expected].filter((id) => !actual.has(id));
  const unknown = [...actual].filter((id) => !expected.has(id));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`Kimi AC coverage mismatch; missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}.`);
  }
}

export function buildCapsule(envelope, { maxBytes = 32 * 1024 } = {}) {
  const mandatory = envelope.findings.filter((finding) => ["CONFLICT", "BLOCKED"].includes(finding.severity));
  const optional = envelope.findings.filter((finding) => !["CONFLICT", "BLOCKED"].includes(finding.severity));
  const capsule = {
    schema_version: envelope.schema_version,
    mode: envelope.mode,
    run_id: envelope.run_id,
    status: envelope.status,
    summary: envelope.summary,
    findings: mandatory.map(compactFinding),
    folded_findings: 0,
    ac_coverage: envelope.ac_coverage,
    next_actions: envelope.next_actions,
    external_research: envelope.external_research,
    context: envelope.context,
    raw_result_ref: envelope.raw_result_ref ?? null,
  };

  for (const finding of optional) {
    const candidate = { ...capsule, findings: [...capsule.findings, compactFinding(finding)] };
    if (Buffer.byteLength(JSON.stringify(candidate)) > maxBytes) break;
    capsule.findings.push(compactFinding(finding));
  }
  capsule.folded_findings = envelope.findings.length - capsule.findings.length;

  if (Buffer.byteLength(JSON.stringify(capsule)) > maxBytes) {
    capsule.ac_coverage = summarizeArray(capsule.ac_coverage);
    capsule.next_actions = summarizeArray(capsule.next_actions);
    capsule.context = {
      completeness: capsule.context?.completeness,
      omission_count: capsule.context?.omissions?.length ?? 0,
      compacted: capsule.context?.compacted === true,
    };
  }
  if (Buffer.byteLength(JSON.stringify(capsule)) > maxBytes) {
    throw new Error("Mandatory Kimi findings exceed the Codex capsule limit.");
  }
  return capsule;
}

function compactFinding(finding) {
  return {
    id: finding.id,
    severity: finding.severity,
    title: finding.title,
    explanation: finding.explanation,
    evidence_refs: finding.evidence.map((item) => item.evidence_id ?? item.path ?? item.url).filter(Boolean),
  };
}

function summarizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20);
}
