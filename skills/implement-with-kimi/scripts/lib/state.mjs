import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { isReviewer, REQUIRED_CONTEXT_TOKENS } from "./reviewer.mjs";

export const STATE_SCHEMA_VERSION = 3;
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
  if (state.state_schema_version !== STATE_SCHEMA_VERSION) {
    throw new Error(`State schema version ${state.state_schema_version} has no supported migration.`);
  }
  return state;
}

export function selectReviewer(inputState, reviewer, { now = new Date().toISOString() } = {}) {
  if (!isReviewer(reviewer)) throw new Error("Reviewer must be kimi or claude-code.");
  const state = structuredClone(inputState);
  const previous = state.reviewer_policy?.selected ?? null;
  if (
    previous === reviewer &&
    state.reviewer_policy?.repository_access_authorized === true &&
    state.reviewer_policy?.required_context_tokens === REQUIRED_CONTEXT_TOKENS
  ) {
    return state;
  }
  state.reviewer_policy = {
    selected: reviewer,
    repository_access_authorized: true,
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
      repository_access_authorized: true,
      required_context_tokens: REQUIRED_CONTEXT_TOKENS,
    },
  });
  return state;
}

function defaultReviewerPolicy() {
  return {
    selected: null,
    repository_access_authorized: false,
    required_context_tokens: null,
    selected_at: null,
  };
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
