import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { isReviewer, REQUIRED_CONTEXT_TOKENS } from "./reviewer.mjs";

export const STATE_SCHEMA_VERSION = 4;
export const MANAGED_START = "<!-- implement-with-kimi:managed:start -->";
export const MANAGED_END = "<!-- implement-with-kimi:managed:end -->";

const STATUS_BY_EVENT = new Map([
  ["bootstrap-ready", { from: ["NOT_STARTED", "BLOCKED"], to: "BOOTSTRAP_READY" }],
  ["tests-written", { from: ["BOOTSTRAP_READY", "TESTS_WRITTEN"], to: "TESTS_WRITTEN" }],
  ["red-planned", { from: ["TESTS_WRITTEN"], to: null }],
  ["red-observed", { from: ["TESTS_WRITTEN"], to: null }],
  ["baseline-green-observed", { from: ["TESTS_WRITTEN"], to: null }],
  ["tests-validated", { from: ["TESTS_WRITTEN"], to: "TESTS_VALIDATED" }],
  ["implementation-started", { from: ["TESTS_VALIDATED"], to: "IMPLEMENTING" }],
  ["green-observed", { from: ["IMPLEMENTING"], to: null }],
  ["verification-observed", { from: ["GREEN_CONFIRMED", "VERIFIED"], to: "VERIFIED" }],
  ["audited", { from: ["VERIFIED"], to: "AUDITED" }],
  ["completed", { from: ["AUDITED"], to: "COMPLETED" }],
]);

const LEGACY_POST_TEST_STATUSES = new Set([
  "TESTS_REVIEWED",
  "TESTS_VALIDATED",
  "IMPLEMENTING",
  "GREEN_CONFIRMED",
  "VERIFIED",
  "AUDITED",
  "COMPLETED",
]);

export function deriveStatePath(specPath) {
  if (typeof specPath !== "string" || !specPath.toLowerCase().endsWith(".md")) {
    throw new Error("The module specification must be a Markdown file.");
  }
  return `${specPath.slice(0, -3)}.state.md`;
}

export function createInitialState({ specPath, specSha256, runId, now = new Date().toISOString() }) {
  if (!specPath || !specSha256 || !runId) {
    throw new Error("specPath, specSha256, and runId are required.");
  }
  return {
    state_schema_version: STATE_SCHEMA_VERSION,
    tool: "implement-with-kimi",
    spec_path: specPath,
    spec_sha256: specSha256,
    run_id: runId,
    active: true,
    suspended: false,
    status: "NOT_STARTED",
    created_at: now,
    updated_at: now,
    git_baseline: [],
    run_baseline: null,
    run_fingerprint: null,
    implementation_fingerprint: null,
    test_fingerprint: null,
    semantic_review: { status: "PENDING", audited_at: null },
    reviewer_policy: defaultReviewerPolicy(),
    review_invocations: [],
    last_reviewer_review: null,
    last_query_review: null,
    red_plan: null,
    red_plans: [],
    test_mappings: [],
    test_validation: { source: null, validated_at: null, fingerprint: null, legacy: false },
    migration_requirements: { test_maps: "NOT_REQUIRED" },
    evidence: [],
    unresolved_findings: [],
    superseded_findings: [],
    warnings: [],
    audit_blocked_fingerprint: null,
    past_runs: [],
    history: [{ at: now, event: "run-created", status: "NOT_STARTED", details: {} }],
  };
}

export function renderStateDocument(state, userNotes = "") {
  const title = path.basename(state.spec_path || "module.md", ".md");
  return [
    `# Implementation State: ${title}`,
    "",
    "This file contains an agent-managed state block. Edit only the User notes section manually.",
    "",
    MANAGED_START,
    "```json",
    JSON.stringify(state, null, 2),
    "```",
    MANAGED_END,
    "",
    "## User notes",
    "",
    String(userNotes),
  ].join("\n");
}

export function parseStateDocument(document) {
  if (typeof document !== "string") throw new Error("State document must be text.");
  const start = document.indexOf(MANAGED_START);
  const end = document.indexOf(MANAGED_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("State document is missing the implement-with-kimi managed markers.");
  }
  const managed = document.slice(start + MANAGED_START.length, end).trim();
  const match = managed.match(/^```json\s*\n([\s\S]*?)\n```$/);
  if (!match) throw new Error("State managed block is not a valid JSON code fence.");

  let state;
  try {
    state = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`State managed JSON is invalid: ${error.message}`);
  }
  if (!Number.isInteger(state.state_schema_version)) throw new Error("State schema version is missing.");
  if (state.state_schema_version > STATE_SCHEMA_VERSION) {
    throw new Error("State file uses a newer schema; upgrade implement-with-kimi before continuing.");
  }
  if (state.state_schema_version < STATE_SCHEMA_VERSION) state = migrateState(state);
  if (state.reviewer_policy) delete state.reviewer_policy.repository_access_authorized;
  if (state.tool !== "implement-with-kimi") throw new Error("State managed block belongs to a different tool.");

  const notesHeading = "\n## User notes\n\n";
  const notesIndex = document.indexOf(notesHeading, end + MANAGED_END.length);
  const userNotes = notesIndex < 0 ? "" : document.slice(notesIndex + notesHeading.length);
  return { state, userNotes };
}

function migrateState(input) {
  let state = structuredClone(input);
  const originalVersion = state.state_schema_version;
  if (state.state_schema_version === 1) {
    state.reviewer_policy = defaultReviewerPolicy();
    state.last_reviewer_review = state.last_kimi_review
      ? { ...state.last_kimi_review, reviewer: "kimi" }
      : null;
    delete state.last_kimi_review;
    state.state_schema_version = 2;
  }
  if (state.state_schema_version === 2) {
    const at = state.updated_at ?? new Date().toISOString();
    const legacyPolicy = state.reviewer_policy ?? {};
    const legacyFailover = state.reviewer_failover ?? {};
    state.reviewer_policy = defaultReviewerPolicy();
    delete state.reviewer_failover;
    state.state_schema_version = 3;
    state.history ??= [];
    state.history.push({
      at,
      event: "state-migrated",
      status: state.status,
      details: {
        from: originalVersion,
        to: 3,
        reviewer_selection_required: true,
        legacy_reviewer_routing: {
          preferred: legacyPolicy.preferred ?? "kimi",
          fallback: legacyPolicy.fallback ?? null,
          repository_consent: legacyPolicy.repository_consent === true,
          required_context_tokens: legacyPolicy.required_context_tokens ?? null,
          enabled_at: legacyPolicy.enabled_at ?? null,
          failover_active: legacyFailover.active === true,
          failover_scope: legacyFailover.scope ?? null,
          failover_reason_code: legacyFailover.reason_code ?? null,
          failover_message: legacyFailover.message ?? null,
          failover_activated_at: legacyFailover.activated_at ?? null,
        },
      },
    });
  }
  if (state.state_schema_version === 3) state = migrateV3ToV4(state, originalVersion);
  if (state.state_schema_version !== STATE_SCHEMA_VERSION) {
    throw new Error(`State schema version ${state.state_schema_version} has no supported migration.`);
  }
  return state;
}

function migrateV3ToV4(input, originalVersion) {
  const state = structuredClone(input);
  const at = state.updated_at ?? new Date().toISOString();
  const effectiveStatus = state.status === "BLOCKED" ? state.previous_status : state.status;
  const legacyPostTest = LEGACY_POST_TEST_STATUSES.has(effectiveStatus);
  state.status = mapLegacyStatus(state.status);
  if (state.previous_status) state.previous_status = mapLegacyStatus(state.previous_status);
  state.state_schema_version = 4;
  state.run_baseline ??= null;
  state.run_fingerprint ??= null;
  state.test_fingerprint ??= null;
  state.semantic_review = {
    status: ["AUDITED", "COMPLETED"].includes(state.status) ? "AUDITED" : "PENDING",
    audited_at: ["AUDITED", "COMPLETED"].includes(state.status) ? at : null,
  };
  state.review_invocations ??= [];
  state.last_query_review ??= null;
  state.red_plans = state.red_plans ?? (state.red_plan ? [state.red_plan] : []);
  state.test_mappings ??= [];
  state.test_validation = legacyPostTest
    ? { source: "legacy-reviewer", validated_at: at, fingerprint: null, legacy: true }
    : { source: null, validated_at: null, fingerprint: null, legacy: false };
  state.migration_requirements = {
    test_maps: state.active && state.test_mappings.length === 0
      ? legacyPostTest ? "OPTIONAL_LEGACY" : state.status === "TESTS_WRITTEN" ? "PENDING" : "NOT_REQUIRED"
      : "NOT_REQUIRED",
  };
  state.superseded_findings ??= [];
  state.audit_blocked_fingerprint ??= null;
  state.history ??= [];
  state.history.push({
    at,
    event: "state-migrated",
    status: state.status,
    details: {
      from: Math.max(3, originalVersion),
      to: 4,
      legacy_test_validation: legacyPostTest,
      test_map_requirement: state.migration_requirements.test_maps,
      reviewer_runtime_modes: ["audit", "query"],
    },
  });
  return state;
}

function mapLegacyStatus(status) {
  if (status === "RED_CONFIRMED") return "TESTS_WRITTEN";
  if (status === "TESTS_REVIEWED") return "TESTS_VALIDATED";
  return status;
}

export function selectReviewer(inputState, reviewer, { now = new Date().toISOString() } = {}) {
  if (!isReviewer(reviewer)) throw new Error("Reviewer must be kimi or claude-code.");
  const state = structuredClone(inputState);
  if (state.reviewer_policy) delete state.reviewer_policy.repository_access_authorized;
  const previous = state.reviewer_policy?.selected ?? null;
  if (previous && previous !== reviewer) {
    throw new Error(`This run already selected ${previous}; reviewer selection is fixed for the run.`);
  }
  if (
    previous === reviewer &&
    state.reviewer_policy?.required_context_tokens === REQUIRED_CONTEXT_TOKENS
  ) return state;
  state.reviewer_policy = {
    selected: reviewer,
    required_context_tokens: REQUIRED_CONTEXT_TOKENS,
    selected_at: now,
  };
  state.updated_at = now;
  state.history.push({
    at: now,
    event: "reviewer-selected",
    status: state.status,
    details: {
      previous,
      selected: reviewer,
      required_context_tokens: REQUIRED_CONTEXT_TOKENS,
    },
  });
  return state;
}

function defaultReviewerPolicy() {
  return {
    selected: null,
    required_context_tokens: null,
    selected_at: null,
  };
}

export function applyStateEvent(inputState, event, details = {}, now = new Date().toISOString()) {
  const state = structuredClone(inputState);
  const transition = STATUS_BY_EVENT.get(event);

  if (event === "blocked") {
    if (state.status !== "BLOCKED") state.previous_status = state.status;
    state.status = "BLOCKED";
  } else if (event === "warning") {
    state.warnings.push({ at: now, ...details });
  } else if (event === "test-exception") {
    if (state.status !== "BOOTSTRAP_READY") throw new Error("test-exception requires BOOTSTRAP_READY.");
    if (!details.reason || !Array.isArray(details.ac_ids) || details.ac_ids.length === 0) {
      throw new Error("test-exception requires reason and at least one AC id.");
    }
    state.evidence.push(withEvidenceId(state, event, details, now));
  } else if (event === "suspend") {
    if (!state.active) throw new Error("The module is not active.");
    if (!details.reason) throw new Error("A suspension reason is required.");
    state.active = false;
    state.suspended = true;
  } else if (event === "resume") {
    if (!state.suspended) throw new Error("The module is not suspended.");
    state.active = true;
    state.suspended = false;
  } else {
    if (!transition) throw new Error(`Unknown state event: ${event}`);
    if (!transition.from.includes(state.status)) {
      throw new Error(`Event ${event} requires ${transition.from.join(" or ")}; current status is ${state.status}.`);
    }
    validateEventDetails(state, event, details);
    if (transition.to) state.status = transition.to;
  }

  if (event === "tests-written") {
    state.test_mappings = structuredClone(details.test_mappings ?? []);
    state.migration_requirements = { test_maps: "NOT_REQUIRED" };
    state.test_validation = { source: null, validated_at: null, fingerprint: null, legacy: false };
    state.test_fingerprint = null;
  }
  if (event === "red-planned") {
    state.red_plan = { at: now, ...details };
    state.red_plans ??= [];
    state.red_plans.push(state.red_plan);
  }
  if (["red-observed", "baseline-green-observed", "green-observed", "verification-observed"].includes(event)) {
    state.evidence.push(withEvidenceId(state, event, details, now));
  }
  if (event === "tests-validated") {
    state.test_fingerprint = details.fingerprint;
    state.test_validation = {
      source: "local-deterministic",
      validated_at: now,
      fingerprint: details.fingerprint,
      legacy: false,
    };
  }
  if (event === "green-observed" && hasCompleteGreenCoverage(state, details.run_fingerprint)) {
    state.status = "GREEN_CONFIRMED";
  }
  if (event === "audited") {
    state.semantic_review = { status: "AUDITED", audited_at: now };
    state.audit_blocked_fingerprint = null;
  }
  if (event === "completed") state.active = false;
  state.updated_at = now;
  state.history.push({ at: now, event, status: state.status, details });
  return state;
}

export function recordReviewInvocation(inputState, entry, now = new Date().toISOString()) {
  if (!entry?.invocation_id) throw new Error("Review invocation requires invocation_id.");
  const state = structuredClone(inputState);
  state.review_invocations ??= [];
  const index = state.review_invocations.findIndex((item) => item.invocation_id === entry.invocation_id);
  if (index >= 0) state.review_invocations[index] = { ...state.review_invocations[index], ...entry };
  else state.review_invocations.push(structuredClone(entry));
  state.updated_at = now;
  return state;
}

function withEvidenceId(state, event, details, at) {
  return {
    evidence_id: details.evidence_id ?? `EV-${String((state.evidence?.length ?? 0) + 1).padStart(4, "0")}`,
    at,
    event,
    ...details,
  };
}

function hasCompleteGreenCoverage(state, runFingerprint) {
  const paths = [...new Set((state.test_mappings ?? []).map((item) => item.path))];
  const evidence = (state.evidence ?? []).filter(
    (item) => item.event === "green-observed" && item.run_fingerprint === runFingerprint && item.exit_code === 0,
  );
  if (paths.length === 0) return evidence.length > 0;
  return paths.every((testPath) => evidence.some(
    (item) => (item.tests ?? []).some((testFile) => testFile.path === testPath &&
      state.test_mappings.some((mapping) => mapping.path === testPath && mapping.sha256 === testFile.sha256)),
  ));
}

export async function readStateFile(filePath) {
  return parseStateDocument(await readFile(filePath, "utf8"));
}

export async function writeStateFile(filePath, state, userNotes = "") {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, renderStateDocument(state, userNotes), "utf8");
  await rename(temporary, filePath);
}

export async function discoverStateDocuments(repoRoot) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to discover state documents.");
  const files = result.stdout.split("\0").filter((item) => item.endsWith(".state.md"));
  const states = [];
  for (const relative of files) {
    const absolute = path.join(repoRoot, relative);
    const text = await readFile(absolute, "utf8");
    if (!text.includes(MANAGED_START)) continue;
    const parsed = parseStateDocument(text);
    states.push({ path: relative.split(path.sep).join("/"), absolute, ...parsed });
  }
  return states;
}

function validateEventDetails(state, event, details) {
  if (event === "tests-written") {
    if (!Array.isArray(details.test_mappings) || !Array.isArray(details.exception_ac_ids)) {
      throw new Error("tests-written requires test_mappings and exception_ac_ids arrays.");
    }
    const covered = [...details.test_mappings.map((item) => item.ac_id), ...details.exception_ac_ids];
    if (covered.length === 0) throw new Error("tests-written requires at least one mapped or excepted AC id.");
  }
  if (event === "red-planned" && (!details.expected_failure || !Array.isArray(details.ac_ids) || details.ac_ids.length === 0)) {
    throw new Error("red-planned requires expected_failure and at least one AC id.");
  }
  if (event === "red-observed") {
    if (!(state.red_plans?.length || state.red_plan)) throw new Error("red-observed requires a prior red-planned event.");
    if (!Number.isInteger(details.exit_code) || details.exit_code === 0) {
      throw new Error("red-observed requires a non-zero test exit_code.");
    }
    if (details.matched_expectation !== true) throw new Error("The observed Red did not match the planned failure.");
    requireTests(details, event);
  }
  if (event === "baseline-green-observed") {
    if (details.exit_code !== 0) throw new Error("baseline-green-observed requires exit_code 0.");
    requireTests(details, event);
  }
  if (event === "tests-validated" && (!details.fingerprint || details.source !== "local-deterministic")) {
    throw new Error("tests-validated requires a local deterministic fingerprint.");
  }
  if (event === "green-observed") {
    if (details.exit_code !== 0) throw new Error("green-observed requires exit_code 0.");
    if ((state.test_mappings ?? []).length > 0) requireTests(details, event);
    if (!details.run_fingerprint) throw new Error("green-observed requires run_fingerprint.");
  }
  if (event === "verification-observed") {
    if (details.exit_code !== 0) throw new Error("verification-observed requires exit_code 0.");
    if (!details.run_fingerprint) throw new Error("verification-observed requires run_fingerprint.");
  }
}

function requireTests(details, event) {
  if (!Array.isArray(details.tests) || details.tests.length === 0) {
    throw new Error(`${event} requires at least one test path.`);
  }
}
