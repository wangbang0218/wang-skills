import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const STATE_SCHEMA_VERSION = 2;
export const MANAGED_START = "<!-- implement-with-kimi:managed:start -->";
export const MANAGED_END = "<!-- implement-with-kimi:managed:end -->";

const STATUS_BY_EVENT = new Map([
  ["bootstrap-ready", { from: ["NOT_STARTED", "BLOCKED"], to: "BOOTSTRAP_READY" }],
  ["tests-written", { from: ["BOOTSTRAP_READY"], to: "TESTS_WRITTEN" }],
  ["red-planned", { from: ["TESTS_WRITTEN"], to: null }],
  ["red-observed", { from: ["TESTS_WRITTEN"], to: "RED_CONFIRMED" }],
  ["tests-reviewed", { from: ["TESTS_WRITTEN", "RED_CONFIRMED"], to: "TESTS_REVIEWED" }],
  ["implementation-started", { from: ["TESTS_REVIEWED"], to: "IMPLEMENTING" }],
  ["green-observed", { from: ["IMPLEMENTING"], to: "GREEN_CONFIRMED" }],
  ["verification-observed", { from: ["GREEN_CONFIRMED", "VERIFIED"], to: "VERIFIED" }],
  ["audited", { from: ["VERIFIED"], to: "AUDITED" }],
  ["completed", { from: ["AUDITED"], to: "COMPLETED" }],
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
    implementation_fingerprint: null,
    reviewer_policy: defaultReviewerPolicy(),
    reviewer_failover: defaultReviewerFailover(),
    last_reviewer_review: null,
    red_plan: null,
    evidence: [],
    unresolved_findings: [],
    warnings: [],
    past_runs: [],
    history: [{ at: now, event: "run-created", status: "NOT_STARTED", details: {} }],
  };
}

export function renderStateDocument(state, userNotes = "") {
  const title = path.basename(state.spec_path || "module.md", ".md");
  const notes = String(userNotes);
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
    notes,
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
  if (!Number.isInteger(state.state_schema_version)) {
    throw new Error("State schema version is missing.");
  }
  if (state.state_schema_version > STATE_SCHEMA_VERSION) {
    throw new Error("State file uses a newer schema; upgrade implement-with-kimi before continuing.");
  }
  if (state.state_schema_version < STATE_SCHEMA_VERSION) {
    state = migrateState(state);
  }
  if (state.tool !== "implement-with-kimi") {
    throw new Error("State managed block belongs to a different tool.");
  }

  const notesHeading = "\n## User notes\n\n";
  const notesIndex = document.indexOf(notesHeading, end + MANAGED_END.length);
  const userNotes = notesIndex < 0 ? "" : document.slice(notesIndex + notesHeading.length);
  return { state, userNotes };
}

function migrateState(input) {
  let state = structuredClone(input);
  if (state.state_schema_version === 1) {
    const at = state.updated_at ?? new Date().toISOString();
    state.reviewer_policy = defaultReviewerPolicy();
    state.reviewer_failover = defaultReviewerFailover();
    state.last_reviewer_review = state.last_kimi_review
      ? { reviewer: "kimi", ...state.last_kimi_review }
      : null;
    delete state.last_kimi_review;
    state.state_schema_version = 2;
    state.history ??= [];
    state.history.push({ at, event: "state-migrated", status: state.status, details: { from: 1, to: 2 } });
  }
  if (state.state_schema_version !== STATE_SCHEMA_VERSION) {
    throw new Error(`State schema version ${state.state_schema_version} has no supported migration.`);
  }
  return state;
}

export function enableReviewerFallback(inputState, { now = new Date().toISOString() } = {}) {
  const state = structuredClone(inputState);
  state.reviewer_policy = {
    preferred: "kimi",
    fallback: "claude-code",
    repository_consent: true,
    required_context_tokens: 1_048_576,
    enabled_at: now,
  };
  state.reviewer_failover ??= defaultReviewerFailover();
  state.updated_at = now;
  state.history.push({ at: now, event: "reviewer-fallback-enabled", status: state.status, details: { fallback: "claude-code", required_context_tokens: 1_048_576 } });
  return state;
}

export function activateReviewerFailover(inputState, { scope, reasonCode, message, now = new Date().toISOString() }) {
  if (!["RUN", "NODE"].includes(scope)) throw new Error("Reviewer failover scope must be RUN or NODE.");
  const state = structuredClone(inputState);
  state.reviewer_failover = {
    active: scope === "RUN",
    scope,
    reason_code: reasonCode,
    message: String(message || ""),
    activated_at: now,
  };
  state.updated_at = now;
  state.history.push({ at: now, event: "reviewer-failover", status: state.status, details: { scope, reason_code: reasonCode } });
  return state;
}

export function clearReviewerFailover(inputState, { now = new Date().toISOString() } = {}) {
  const state = structuredClone(inputState);
  state.reviewer_failover = defaultReviewerFailover();
  state.updated_at = now;
  state.history.push({ at: now, event: "kimi-retry-ready", status: state.status, details: {} });
  return state;
}

function defaultReviewerPolicy() {
  return {
    preferred: "kimi",
    fallback: null,
    repository_consent: false,
    required_context_tokens: null,
    enabled_at: null,
  };
}

function defaultReviewerFailover() {
  return { active: false, scope: null, reason_code: null, message: null, activated_at: null };
}

export function applyStateEvent(inputState, event, details = {}, now = new Date().toISOString()) {
  const state = JSON.parse(JSON.stringify(inputState));
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
    state.evidence.push({ at: now, event, ...details });
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

  if (event === "red-planned") state.red_plan = { at: now, ...details };
  if (["red-observed", "green-observed", "verification-observed"].includes(event)) {
    state.evidence.push({ at: now, event, ...details });
  }
  if (event === "completed") state.active = false;
  state.updated_at = now;
  state.history.push({ at: now, event, status: state.status, details });
  return state;
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
    const covered = [...(details.ac_ids ?? []), ...(details.exception_ac_ids ?? [])];
    if (covered.length === 0) throw new Error("tests-written requires at least one mapped or excepted AC id.");
  }
  if (event === "red-planned" && (!details.expected_failure || !Array.isArray(details.ac_ids) || details.ac_ids.length === 0)) {
    throw new Error("red-planned requires expected_failure and at least one AC id.");
  }
  if (event === "red-observed") {
    if (!state.red_plan) throw new Error("red-observed requires a prior red-planned event.");
    if (!Number.isInteger(details.exit_code) || details.exit_code === 0) {
      throw new Error("red-observed requires a non-zero test exit_code.");
    }
    if (details.matched_expectation !== true) {
      throw new Error("The observed Red did not match the planned failure.");
    }
  }
  if (["green-observed", "verification-observed"].includes(event) && details.exit_code !== 0) {
    throw new Error(`${event} requires exit_code 0.`);
  }
}
