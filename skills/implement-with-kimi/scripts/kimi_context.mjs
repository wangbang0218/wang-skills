#!/usr/bin/env -S volta run node

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File } from "./lib/evidence.mjs";
import { validateImplementationPackage } from "./lib/document-package.mjs";
import { mergeHookConfig, removeHookConfig } from "./lib/hook-config.mjs";
import { assertSupportedNode, assertVoltaNode, preflightKimi } from "./lib/preflight.mjs";
import { preflightClaude, runClaudeNode } from "./lib/claude-runner.mjs";
import {
  buildRepositoryCatalog,
  buildRunDelta,
  captureRunBaseline,
  getRepoRoot,
  gitBaseline,
  INITIAL_CONTEXT_BUDGET,
  queryContextBudget,
  renderContextPack,
  repositoryFingerprint,
  runScopedFingerprint,
  selectRepositoryContext,
} from "./lib/repository.mjs";
import { createSubmissionBudget, runKimiNode, validateEnvelopeEvidence } from "./lib/runner.mjs";
import { validateReviewerEnvelope } from "./lib/schema.mjs";
import { isReviewer, requireSelectedReviewerPolicy } from "./lib/reviewer.mjs";
import { loadAndValidateSpec } from "./lib/spec.mjs";
import {
  applyStateEvent,
  createInitialState,
  deriveStatePath,
  discoverStateDocuments,
  readStateFile,
  recordReviewInvocation,
  selectReviewer,
  writeStateFile,
} from "./lib/state.mjs";
import { extractJsonObject } from "./lib/prompt.mjs";
import { buildReviewStateSummary } from "./lib/review-context.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.dirname(scriptDirectory);
const SHRUNK_CONTEXT_BUDGET = 520_000;
const EXIT = { GENERAL: 1, BLOCKED: 2, CONFIG: 3, VALIDATION: 4, TRANSIENT: 5, CANCELLED: 6 };
const LEGACY_COMMANDS = new Set(["enable-reviewer-fallback", "retry-kimi"]);
const LEGACY_OPTIONS = ["fallback-reviewer", "reviewer-context", "consent-repository-to-reviewer"];
const LEGACY_HOOK_SHA256 = new Set([
  "09c60b7b3230d3d858bddcc7b00e42cac0f2a2cc505397f55130d882e541f40f",
  "00af13816e350bf8318c178e7b6ee24c5c910a02bee25b8aaba6a72b2aacf609",
  "aa740f22e079f94710142abe6670bc593dd8ccb7bbe8b5143e529a951da38275",
  "dd541b46c61bfae44bae740cfc0bea3da3e1428502edc877bd15873fd17afc28",
]);

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());

main().catch((error) => {
  emit({
    schema_version: 1,
    status: error.kind === "CANCELLED" ? "CANCELLED" : "ERROR",
    error: {
      kind: error.kind || "GENERAL",
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
    ...(error.issues ? { issues: error.issues } : {}),
  });
  process.exitCode = exitCodeFor(error);
});

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.command || parsed.options.help) {
    process.stdout.write(usage() + "\n");
    return;
  }
  rejectLegacyReviewerInterface(parsed);
  validateReviewerOptionScope(parsed);
  if (["bootstrap", "select-reviewer"].includes(parsed.command) ||
      (parsed.command === "resume" && parsed.options.reviewer !== undefined)) {
    requireReviewerOption(parsed.options);
  }
  assertSupportedNode();
  assertVoltaNode();
  const repoRoot = getRepoRoot(process.cwd());

  if (parsed.command === "setup-hook") return setupHook(repoRoot);
  if (parsed.command === "remove-hook") return removeHook(repoRoot);
  if (parsed.command === "inspect") return inspectFinding(repoRoot, parsed.options);
  if (parsed.command === "validate-package") {
    const packagePath = requireOption(parsed.options, "package");
    return emit(await validateImplementationPackage(repoRoot, packagePath, {
      specPath: parsed.options.spec ? requireOption(parsed.options, "spec") : null,
    }));
  }

  const specPath = requireOption(parsed.options, "spec");
  const spec = await loadAndValidateSpec(repoRoot, specPath, arrayOption(parsed.options, "authority"));
  if (parsed.command === "bootstrap") return bootstrap(repoRoot, spec, parsed.options);
  if (parsed.command === "select-reviewer") return selectRunReviewer(repoRoot, spec, parsed.options);
  if (parsed.command === "record") return recordEvidence(repoRoot, spec, parsed.event, parsed.options);
  if (parsed.command === "validate-tests") return validateTests(repoRoot, spec, { compatibilityAlias: false });
  if (parsed.command === "review-tests") return validateTests(repoRoot, spec, { compatibilityAlias: true });
  if (parsed.command === "attach-test-map") return attachTestMap(repoRoot, spec, parsed.options);
  if (parsed.command === "rehydrate") return rehydrate(repoRoot, spec);
  if (parsed.command === "suspend") return suspend(repoRoot, spec, parsed.options);
  if (parsed.command === "resume") return resume(repoRoot, spec, parsed.options);
  if (parsed.command === "review-preview") return reviewPreview(repoRoot, spec, parsed.options);
  if (["audit", "query"].includes(parsed.command)) {
    return reviewCommand(repoRoot, spec, parsed.command, parsed.options);
  }
  throw typedError("USAGE", "Unknown command: " + parsed.command);
}

async function bootstrap(repoRoot, spec, options) {
  const reviewer = requireReviewerOption(options);
  if (options.goal !== undefined && !["active", "none"].includes(options.goal)) {
    throw typedError("USAGE", "--goal must be active or none.");
  }
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const specHash = await sha256File(spec.absolute_path);
  const existing = await readOptionalState(stateLocation);
  if (existing && existing.state.spec_sha256 === specHash && !options["new-run"] &&
      !(await authorityMatches(repoRoot, existing.state, spec))) {
    throw typedError("WORKFLOW", "Authority paths or contents changed; start bootstrap with --new-run --reason <reason>.");
  }
  if (existing && existing.state.spec_sha256 === specHash && existing.state.status === "COMPLETED" && !options["new-run"]) {
    return emit({
      schema_version: 1,
      status: "ALREADY_COMPLETED",
      run_id: existing.state.run_id,
      state_path: relative(repoRoot, stateLocation),
    });
  }
  if (existing && existing.state.spec_sha256 === specHash && existing.state.status !== "COMPLETED" && !options["new-run"]) {
    return emit({
      schema_version: 1,
      status: "RESUME_REQUIRED",
      run_id: existing.state.run_id,
      state_path: relative(repoRoot, stateLocation),
    });
  }
  if (options["new-run"] && !options.reason) throw typedError("USAGE", "--new-run requires --reason.");

  await assertNoOtherActiveState(repoRoot, stateLocation);
  let state = createInitialState({
    specPath: spec.relative_path,
    specSha256: specHash,
    runId: randomUUID(),
  });
  state.authority_paths = spec.authority_paths;
  state.authority_hashes = await hashAuthorities(repoRoot, spec.authority_paths);
  state.git_baseline = gitBaseline(repoRoot);
  state.run_baseline = captureRunBaseline(repoRoot);
  state.goal = { status: options.goal || "unknown" };
  if (!options.goal) {
    state = applyStateEvent(state, "warning", {
      code: "GOAL_STATUS_UNKNOWN",
      message: "No Goal status was supplied.",
    });
  }
  state = selectReviewer(state, reviewer);
  state = applyStateEvent(state, "bootstrap-ready", {
    validation: "local-deterministic",
    semantic_review: "PENDING",
  });
  state.run_fingerprint = runScopedFingerprint(repoRoot, state.run_baseline);
  if (existing) {
    const archived = structuredClone(existing.state);
    delete archived.past_runs;
    state.past_runs = [...(existing.state.past_runs || []), archived];
  }
  await writeStateFile(stateLocation, state, existing?.userNotes || "");
  emit({
    schema_version: 1,
    status: "BOOTSTRAP_READY",
    run_id: state.run_id,
    reviewer,
    semantic_review: "PENDING",
    reviewer_called: false,
    state_path: relative(repoRoot, stateLocation),
  });
}

async function selectRunReviewer(repoRoot, spec, options) {
  const reviewer = requireReviewerOption(options);
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.active) throw typedError("WORKFLOW", "Reviewer can only be selected for an active run.");
  let state;
  try {
    state = selectReviewer(loaded.state, reviewer);
  } catch (error) {
    throw typedError("WORKFLOW", error.message);
  }
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({
    schema_version: 1,
    status: "REVIEWER_SELECTED",
    run_id: state.run_id,
    reviewer,
    reviewer_called: false,
    required_context_tokens: 1_048_576,
    state_path: relative(repoRoot, stateLocation),
  });
}

async function recordEvidence(repoRoot, spec, event, options) {
  if (!event) throw typedError("USAGE", "record requires an event name.");
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.active) throw typedError("WORKFLOW", "Cannot record evidence for an inactive module.");
  let state = await reconcileMilestones(repoRoot, loaded.state);
  if (JSON.stringify(state) !== JSON.stringify(loaded.state)) {
    await writeStateFile(stateLocation, state, loaded.userNotes);
  }
  const details = await eventDetails(repoRoot, event, options, spec, state);
  try {
    state = applyStateEvent(state, event, details);
  } catch (error) {
    throw typedError("WORKFLOW", error.message);
  }
  state.run_fingerprint = runScopedFingerprint(repoRoot, state.run_baseline);
  if (event === "green-observed" && state.status === "GREEN_CONFIRMED") {
    state.implementation_fingerprint = state.run_fingerprint;
  }
  if (event === "verification-observed") state.implementation_fingerprint = state.run_fingerprint;
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({
    schema_version: 1,
    status: "RECORDED",
    event,
    run_id: state.run_id,
    module_status: state.status,
    state_path: relative(repoRoot, stateLocation),
  });
}

async function validateTests(repoRoot, spec, { compatibilityAlias }) {
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.active) throw typedError("WORKFLOW", "Cannot validate tests for an inactive module.");
  let state = await reconcileMilestones(repoRoot, loaded.state);
  if (state.status !== "TESTS_WRITTEN") {
    throw typedError("WORKFLOW", "validate-tests requires TESTS_WRITTEN; current status is " + state.status + ".");
  }
  const fingerprint = await validateTestGate(repoRoot, spec, state);
  state = applyStateEvent(state, "tests-validated", {
    source: "local-deterministic",
    fingerprint,
  });
  state.run_fingerprint = runScopedFingerprint(repoRoot, state.run_baseline);
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({
    schema_version: 1,
    status: compatibilityAlias ? "LOCAL_ONLY" : "TESTS_VALIDATED",
    ...(compatibilityAlias ? { deprecated_alias: "review-tests", canonical_command: "validate-tests" } : {}),
    reviewer_called: false,
    run_id: state.run_id,
    module_status: state.status,
    test_fingerprint: fingerprint,
    state_path: relative(repoRoot, stateLocation),
  });
}

async function attachTestMap(repoRoot, spec, options) {
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.active) throw typedError("WORKFLOW", "Cannot attach test maps to an inactive module.");
  const requirement = loaded.state.migration_requirements?.test_maps;
  if (!["PENDING", "OPTIONAL_LEGACY"].includes(requirement)) {
    throw typedError("WORKFLOW", "attach-test-map is only available to a migrated v1-v3 run that lacks path mappings.");
  }
  const mappings = await parseTestMappings(repoRoot, options, spec);
  if (mappings.length === 0) throw typedError("USAGE", "attach-test-map requires at least one --test-map AC-NNN=path.");
  const state = structuredClone(loaded.state);
  state.test_mappings = mergeMappings(state.test_mappings || [], mappings);
  assertCompleteAcMapping(spec, state.test_mappings, testExceptionIds(state));
  state.migration_requirements = { test_maps: "NOT_REQUIRED" };
  state.history.push({
    at: new Date().toISOString(),
    event: "legacy-test-maps-attached",
    status: state.status,
    details: { test_mappings: mappings },
  });
  state.updated_at = new Date().toISOString();
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({
    schema_version: 1,
    status: "TEST_MAPS_ATTACHED",
    run_id: state.run_id,
    module_status: state.status,
    test_mappings: state.test_mappings,
    state_path: relative(repoRoot, stateLocation),
  });
}

async function rehydrate(repoRoot, spec) {
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.active) throw typedError("WORKFLOW", "Module is not active; use resume --spec " + spec.relative_path + ".");
  const beforeStatus = loaded.state.status;
  const state = await reconcileMilestones(repoRoot, loaded.state, { recoverAuditBlock: true });
  state.history.push({
    at: new Date().toISOString(),
    event: "rehydrated-local",
    status: state.status,
    details: { previous_status: beforeStatus, reviewer_called: false },
  });
  state.updated_at = new Date().toISOString();
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({
    schema_version: 1,
    status: "REHYDRATED",
    run_id: state.run_id,
    module_status: state.status,
    reviewer_called: false,
    semantic_review: state.semantic_review?.status || "PENDING",
    next_action: nextActionForStatus(state.status),
    state_path: relative(repoRoot, stateLocation),
  });
}

async function resume(repoRoot, spec, options) {
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.suspended) throw typedError("WORKFLOW", "Only a suspended module can be resumed.");
  await assertNoOtherActiveState(repoRoot, stateLocation);
  let state = loaded.state;
  if (options.reviewer !== undefined) {
    try {
      state = selectReviewer(state, requireReviewerOption(options));
    } catch (error) {
      throw typedError("WORKFLOW", error.message);
    }
  }
  requireSelectedReviewerPolicy(state);
  state = applyStateEvent(state, "resume", {});
  state = await reconcileMilestones(repoRoot, state, { recoverAuditBlock: true });
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({
    schema_version: 1,
    status: "RESUMED",
    run_id: state.run_id,
    module_status: state.status,
    reviewer_called: false,
    next_action: nextActionForStatus(state.status),
    state_path: relative(repoRoot, stateLocation),
  });
}

async function suspend(repoRoot, spec, options) {
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  const state = applyStateEvent(loaded.state, "suspend", {
    reason: requireOption(options, "reason"),
    run_fingerprint: runScopedFingerprint(repoRoot, loaded.state.run_baseline),
    full_worktree_fingerprint: repositoryFingerprint(repoRoot),
    git_baseline: gitBaseline(repoRoot),
  });
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({
    schema_version: 1,
    status: "SUSPENDED",
    run_id: state.run_id,
    state_path: relative(repoRoot, stateLocation),
  });
}

async function reviewPreview(repoRoot, spec, options) {
  const mode = requireOption(options, "mode");
  if (!["audit", "query"].includes(mode)) throw typedError("USAGE", "--mode must be audit or query.");
  if (mode === "query") requireOption(options, "question");
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.active) throw typedError("WORKFLOW", "Review preview requires an active module.");
  const state = await reconcileMilestones(repoRoot, loaded.state);
  assertReviewStage(state, mode);
  emit((await prepareReview(repoRoot, spec, state, mode, { question: options.question })).preview);
}

async function reviewCommand(repoRoot, spec, mode, options) {
  if (mode === "query") requireOption(options, "question");
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.active) throw typedError("WORKFLOW", "Module is not active; use resume --spec " + spec.relative_path + ".");
  let state = await reconcileMilestones(repoRoot, loaded.state);
  if (JSON.stringify(state) !== JSON.stringify(loaded.state)) {
    await writeStateFile(stateLocation, state, loaded.userNotes);
  }
  assertReviewStage(state, mode);

  let preparation;
  try {
    preparation = await prepareReview(repoRoot, spec, state, mode, { question: options.question });
  } catch (error) {
    if (mode === "audit" && error.kind === "BLOCKED") {
      state = applyStateEvent(state, "blocked", { mode, reason: error.message, source: "local-context-gate" });
      state.audit_blocked_fingerprint = runScopedFingerprint(repoRoot, state.run_baseline);
      await writeStateFile(stateLocation, state, loaded.userNotes);
    }
    throw error;
  }
  if (options["execute-reviewer"] !== true) return emit(preparation.preview);

  progress(
    "Authorized reviewer execution: mode=" + mode +
    ", reviewer=" + preparation.preview.reviewer +
    ", initial_tokens=" + preparation.preview.initial_context.estimated_tokens +
    "/" + preparation.preview.initial_context.budget_tokens,
  );
  const persistInvocation = async ({ entry }) => {
    state = recordReviewInvocation(state, entry);
    await writeStateFile(stateLocation, state, loaded.userNotes);
  };

  let result;
  try {
    result = await executeReview(repoRoot, spec, state, mode, options, preparation, persistInvocation);
  } catch (error) {
    if (mode === "audit" && error.kind === "BLOCKED") {
      state = applyStateEvent(state, "blocked", { mode, reason: error.message, source: "review-context" });
      state.audit_blocked_fingerprint = runScopedFingerprint(repoRoot, state.run_baseline);
      await writeStateFile(stateLocation, state, loaded.userNotes);
    }
    throw error;
  }

  state = mode === "query"
    ? applyAdvisoryQueryToState(state, result)
    : applyAuditToState(state, result, repoRoot);
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emitReviewResult(result, state, repoRoot, stateLocation, { advisory: mode === "query" });
}

async function prepareReview(repoRoot, spec, state, mode, { question = null } = {}) {
  const reviewer = requireSelectedReviewerPolicy(state);
  const runDelta = buildRunDelta(repoRoot, state.run_baseline);
  const mappedTests = [...new Set((state.test_mappings || []).map((item) => item.path))];
  const mandatoryPaths = [
    ...runDelta.filter((entry) => entry.kind !== "missing").map((entry) => entry.path),
    ...mappedTests,
  ];
  const catalog = await buildRepositoryCatalog(repoRoot, {
    specPath: spec.relative_path,
    specText: spec.text,
    authorityPaths: spec.authority_paths,
    mandatoryPaths,
    runDelta,
  });
  const budgetTokens = mode === "query" ? queryContextBudget(catalog) : INITIAL_CONTEXT_BUDGET;
  const selection = selectRepositoryContext(catalog, { budgetTokens });
  if (selection.status === "BLOCKED") throw typedError("BLOCKED", selection.reason);
  const preview = {
    schema_version: 1,
    status: "REVIEW_READY",
    mode,
    ...(mode === "query" ? { question } : {}),
    run_id: state.run_id,
    reviewer,
    requires_execute_reviewer: true,
    requires_explicit_user_authorization: true,
    state_unchanged: true,
    initial_context: {
      budget_tokens: selection.budget_tokens,
      estimated_tokens: selection.estimated_tokens,
      mandatory_tokens: selection.mandatory_tokens,
      completeness: selection.omitted.length === 0 ? "FULL" : "PARTIAL",
      selected_count: selection.selected.length,
      omitted_count: selection.omitted.length,
      mandatory_paths: catalog.required_paths,
      run_delta: catalog.run_delta,
    },
    reviewer_access: {
      required_context_tokens: 1_048_576,
      effort: "max",
      repository_read_search: "allowed",
      additional_repo_read_limit_tokens: reviewer === "kimi" ? 100_000 : null,
      claude_additional_reads_hard_limited: false,
      web_access: true,
    },
    cost_control: {
      usd_cap: null,
      provider_cost_recorded_after_call: true,
      note: "700K is the initial pack only; Claude follow-up repository reads have no hard token ceiling.",
    },
    submission_policy: {
      max_prompt_submissions: 2,
      shared_by: ["initial", "schema_repair", "context_shrink", "post_send_retry"],
      preflight_failures_count: false,
    },
    next_command: mode + " --execute-reviewer",
  };
  return { catalog, selection, preview };
}

async function executeReview(repoRoot, spec, state, mode, options, preparation, onInvocation) {
  const reviewer = requireSelectedReviewerPolicy(state);
  const preflight = reviewer === "kimi" ? await preflightKimi() : await preflightClaude();
  const submissionBudget = createSubmissionBudget(2);
  const runSelection = async (selection) => {
    const node = {
      repoRoot,
      mode,
      runId: state.run_id,
      specPath: spec.relative_path,
      acIds: spec.ac_ids,
      contextPack: renderReviewContext(preparation.catalog, selection, state, spec, mode),
      question: options.question,
      signal: controller.signal,
      submissionBudget,
      estimatedInitialTokens: selection.estimated_tokens,
      onInvocation,
      onProgress: progress,
    };
    try {
      const result = reviewer === "kimi"
        ? await runKimiNode({ ...node, preflight })
        : await runClaudeNode({ ...node, preflight });
      if (reviewer === "kimi") result.envelope.reviewer = "kimi";
      return result;
    } catch (error) {
      error.reviewer = reviewer;
      error.details = { selected_reviewer: reviewer, automatic_fallback: false };
      throw error;
    }
  };

  try {
    return await runSelection(preparation.selection);
  } catch (error) {
    if (!["CONTEXT_COMPACTED", "CONTEXT_OVERSIZE"].includes(error.kind) ||
        submissionBudget.used >= submissionBudget.max) {
      throw error;
    }
    progress("Reviewer context retry after " + error.kind + "; shrinking initial pack to " + SHRUNK_CONTEXT_BUDGET + " tokens");
    const shrunk = selectRepositoryContext(preparation.catalog, { budgetTokens: SHRUNK_CONTEXT_BUDGET });
    if (shrunk.status === "BLOCKED") throw typedError("BLOCKED", shrunk.reason);
    return runSelection(shrunk);
  }
}

function renderReviewContext(catalog, selection, state, spec, mode) {
  return renderContextPack(
    { ...selection, excluded: catalog.excluded },
    {
      run_id: state.run_id,
      mode,
      spec_path: spec.relative_path,
      authority_paths: spec.authority_paths,
      git_baseline: state.git_baseline,
      run_delta: catalog.run_delta,
      state_summary: buildReviewStateSummary(state),
    },
  );
}

function applyAuditToState(inputState, result, repoRoot) {
  assertReviewerIdentity(inputState, result);
  let state = structuredClone(inputState);
  state.last_reviewer_review = summarizeReview(result);
  state.warnings.push(...result.envelope.findings
    .filter((finding) => finding.severity === "WARNING")
    .map(summarizeFinding));
  const blocking = result.envelope.findings
    .filter((finding) => ["CONFLICT", "BLOCKED"].includes(finding.severity))
    .map(summarizeFinding);
  if (blocking.length > 0) {
    state.unresolved_findings = blocking;
    state = applyStateEvent(state, "blocked", { mode: "audit", findings: blocking });
    state.audit_blocked_fingerprint = runScopedFingerprint(repoRoot, state.run_baseline);
    return state;
  }
  state.unresolved_findings = [];
  state = applyStateEvent(state, "audited", { review_status: result.envelope.status });
  return applyStateEvent(state, "completed", {});
}

function applyAdvisoryQueryToState(inputState, result) {
  assertReviewerIdentity(inputState, result);
  const state = structuredClone(inputState);
  state.last_query_review = { ...summarizeReview(result), advisory: true };
  state.updated_at = new Date().toISOString();
  state.history.push({
    at: state.updated_at,
    event: "advisory-query-recorded",
    status: state.status,
    details: {
      review_status: result.envelope.status,
      finding_ids: result.envelope.findings.map((finding) => finding.id),
    },
  });
  return state;
}

function summarizeReview(result) {
  return {
    at: new Date().toISOString(),
    reviewer: result.envelope.reviewer,
    mode: result.envelope.mode,
    status: result.envelope.status,
    model: result.envelope.model,
    snapshot: result.envelope.snapshot,
    raw_result_ref: result.envelope.raw_result_ref,
    finding_ids: result.envelope.findings.map((finding) => finding.id),
  };
}

function assertReviewerIdentity(state, result) {
  const expected = requireSelectedReviewerPolicy(state);
  if (!isReviewer(result.envelope.reviewer) || result.envelope.reviewer !== expected) {
    throw typedError(
      "PROTOCOL",
      "Reviewer result identity mismatch: expected " + expected +
      ", received " + (result.envelope.reviewer || "missing") + ".",
    );
  }
}

async function reconcileMilestones(repoRoot, inputState, { recoverAuditBlock = false } = {}) {
  const state = structuredClone(inputState);
  const previousUpdatedAt = state.updated_at;
  const currentRunFingerprint = runScopedFingerprint(repoRoot, state.run_baseline);
  if (recoverAuditBlock && state.status === "BLOCKED" && state.audit_blocked_fingerprint &&
      state.audit_blocked_fingerprint !== currentRunFingerprint) {
    state.superseded_findings = state.superseded_findings || [];
    state.superseded_findings.push(...(state.unresolved_findings || []).map((finding) => ({
      ...finding,
      superseded_at: new Date().toISOString(),
      reason: "run_fingerprint_changed_after_audit_block",
    })));
    state.unresolved_findings = [];
    state.status = state.test_validation?.source ? "IMPLEMENTING" : "TESTS_WRITTEN";
    delete state.previous_status;
    state.audit_blocked_fingerprint = null;
    state.semantic_review = { status: "PENDING", audited_at: null };
    state.history.push({
      at: new Date().toISOString(),
      event: "audit-findings-superseded",
      status: state.status,
      details: { reason: "run_fingerprint_changed" },
    });
  }
  const effectiveStatus = state.status === "BLOCKED" ? state.previous_status : state.status;
  if (state.test_validation?.legacy !== true && state.test_validation?.fingerprint &&
      !["NOT_STARTED", "BOOTSTRAP_READY", "TESTS_WRITTEN"].includes(effectiveStatus)) {
    let currentFingerprint = null;
    try {
      currentFingerprint = await currentTestFingerprint(repoRoot, state.test_mappings || []);
    } catch {
      // Missing or unreadable mapped tests invalidate the local test gate.
    }
    if (currentFingerprint !== state.test_validation.fingerprint) {
      state.status = "TESTS_WRITTEN";
      delete state.previous_status;
      state.test_validation = { source: null, validated_at: null, fingerprint: null, legacy: false };
      state.test_fingerprint = null;
      state.implementation_fingerprint = null;
      state.semantic_review = { status: "PENDING", audited_at: null };
      state.unresolved_findings = [];
      state.history.push({
        at: new Date().toISOString(),
        event: "test-milestone-invalidated",
        status: state.status,
        details: { reason: "mapped_test_fingerprint_changed" },
      });
    }
  }

  const currentEffective = state.status === "BLOCKED" ? state.previous_status : state.status;
  if (state.implementation_fingerprint &&
      ["GREEN_CONFIRMED", "VERIFIED", "AUDITED"].includes(currentEffective) &&
      state.implementation_fingerprint !== currentRunFingerprint) {
    state.status = "IMPLEMENTING";
    delete state.previous_status;
    state.semantic_review = { status: "PENDING", audited_at: null };
    state.history.push({
      at: new Date().toISOString(),
      event: "implementation-milestone-invalidated",
      status: state.status,
      details: { reason: "run_fingerprint_changed" },
    });
  }
  state.run_fingerprint = currentRunFingerprint;
  const comparable = structuredClone(state);
  comparable.updated_at = previousUpdatedAt;
  if (JSON.stringify(comparable) !== JSON.stringify(inputState)) {
    state.updated_at = new Date().toISOString();
  }
  return state;
}

async function validateTestGate(repoRoot, spec, state) {
  const exceptions = testExceptionIds(state);
  assertCompleteAcMapping(spec, state.test_mappings || [], exceptions);
  const currentMappings = await refreshMappingHashes(repoRoot, state.test_mappings || []);
  for (const mapping of state.test_mappings || []) {
    const current = currentMappings.find((item) => item.ac_id === mapping.ac_id && item.path === mapping.path);
    if (!current || current.sha256 !== mapping.sha256) {
      throw typedError("WORKFLOW", "Mapped test changed after tests-written: " + mapping.path + "; record tests-written again.");
    }
  }
  const paths = [...new Set((state.test_mappings || []).map((item) => item.path))];
  for (const testPath of paths) {
    const expectedSha = (state.test_mappings || []).find((item) => item.path === testPath)?.sha256;
    const covered = (state.evidence || []).some((item) =>
      ["red-observed", "baseline-green-observed"].includes(item.event) &&
      (item.tests || []).some((testFile) => testFile.path === testPath && testFile.sha256 === expectedSha));
    if (!covered) {
      throw typedError("WORKFLOW", "Mapped test lacks current Red or baseline Green evidence: " + testPath + ".");
    }
  }
  return currentTestFingerprint(repoRoot, state.test_mappings || []);
}

async function eventDetails(repoRoot, event, options, spec, state) {
  if (event === "tests-written") {
    const mappings = await parseTestMappings(repoRoot, options, spec);
    const legacyAcIds = unique(arrayOption(options, "ac"));
    if (legacyAcIds.length > 0) {
      validateAcIds(legacyAcIds, spec);
      const mappedIds = new Set(mappings.map((item) => item.ac_id));
      const missingPaths = legacyAcIds.filter((acId) => !mappedIds.has(acId));
      if (missingPaths.length > 0) {
        throw typedError("USAGE", "--ac no longer maps a test path; use --test-map AC-NNN=path for: " + missingPaths.join(", ") + ".");
      }
    }
    const exceptionIds = testExceptionIds(state);
    assertCompleteAcMapping(spec, mappings, exceptionIds);
    return { test_mappings: mappings, exception_ac_ids: exceptionIds };
  }
  if (event === "red-planned") {
    const acIds = unique(arrayOption(options, "ac"));
    if (acIds.length === 0) throw typedError("USAGE", "red-planned requires at least one --ac.");
    validateAcIds(acIds, spec);
    const excepted = testExceptionIds(state);
    const invalid = acIds.filter((id) => excepted.includes(id));
    if (invalid.length > 0) throw typedError("WORKFLOW", "Cannot plan Red for excepted AC ids: " + invalid.join(", "));
    const mapped = new Set((state.test_mappings || []).map((item) => item.ac_id));
    const unmapped = acIds.filter((id) => !mapped.has(id));
    if (unmapped.length > 0) throw typedError("WORKFLOW", "Red AC ids are not mapped to test paths: " + unmapped.join(", "));
    return { expected_failure: requireOption(options, "expected-failure"), ac_ids: acIds };
  }
  if (event === "test-exception") {
    const acIds = unique(arrayOption(options, "ac"));
    if (acIds.length === 0) throw typedError("USAGE", "test-exception requires at least one --ac.");
    validateAcIds(acIds, spec);
    return { reason: requireOption(options, "reason"), ac_ids: acIds };
  }
  if (event === "implementation-started") return {};
  if (["red-observed", "baseline-green-observed", "green-observed", "verification-observed"].includes(event)) {
    const exitCode = Number(requireOption(options, "exit-code"));
    if (!Number.isInteger(exitCode)) throw typedError("USAGE", "--exit-code must be an integer.");
    const tests = event === "verification-observed"
      ? []
      : await testSnapshots(repoRoot, arrayOption(options, "test"));
    if (event !== "verification-observed" && tests.length === 0 &&
        !((state.test_mappings || []).length === 0 && event === "green-observed")) {
      throw typedError("USAGE", event + " requires at least one --test path.");
    }
    for (const testFile of tests) {
      if (!(state.test_mappings || []).some((mapping) => mapping.path === testFile.path)) {
        throw typedError("WORKFLOW", "Evidence test is not mapped by tests-written: " + testFile.path + ".");
      }
    }
    if (event === "red-observed") {
      const planned = new Set((state.red_plans || []).flatMap((item) => item.ac_ids || []));
      const unplanned = tests.filter((testFile) =>
        !(state.test_mappings || []).some((mapping) => mapping.path === testFile.path && planned.has(mapping.ac_id)));
      if (unplanned.length > 0) {
        throw typedError("WORKFLOW", "Red evidence has no matching red-planned AC: " + unplanned.map((item) => item.path).join(", ") + ".");
      }
    }
    const runFingerprint = ["green-observed", "verification-observed"].includes(event)
      ? runScopedFingerprint(repoRoot, state.run_baseline)
      : undefined;
    return {
      command: requireOption(options, "command"),
      exit_code: exitCode,
      tests,
      run_fingerprint: runFingerprint,
      matched_expectation: event === "red-observed" ? options["matched-expectation"] === true : undefined,
      log: options.log ? await summarizeLog(options.log, exitCode) : null,
    };
  }
  throw typedError("USAGE", "Unsupported record event: " + event);
}

async function parseTestMappings(repoRoot, options, spec) {
  const result = [];
  for (const value of arrayOption(options, "test-map")) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw typedError("USAGE", "Invalid --test-map " + value + "; expected AC-NNN=repository/path.");
    }
    const acId = value.slice(0, separator);
    validateAcIds([acId], spec);
    const testFile = (await testSnapshots(repoRoot, [value.slice(separator + 1)]))[0];
    result.push({ ac_id: acId, ...testFile });
  }
  return mergeMappings([], result);
}

async function refreshMappingHashes(repoRoot, mappings) {
  const result = [];
  for (const mapping of mappings) {
    const snapshot = (await testSnapshots(repoRoot, [mapping.path]))[0];
    result.push({ ac_id: mapping.ac_id, ...snapshot });
  }
  return result;
}

async function testSnapshots(repoRoot, values) {
  const result = [];
  for (const value of unique(values)) {
    const normalized = await normalizeRepositoryFile(repoRoot, value);
    result.push({ path: normalized, sha256: await sha256File(path.join(repoRoot, normalized)) });
  }
  return result;
}

async function normalizeRepositoryFile(repoRoot, value) {
  if (!value || path.isAbsolute(value)) throw typedError("USAGE", "Repository path must be relative: " + (value || "empty") + ".");
  const resolved = path.resolve(repoRoot, value);
  if (!isWithin(repoRoot, resolved)) throw typedError("USAGE", "Repository path escapes the worktree: " + value + ".");
  let stat;
  try {
    stat = await lstat(resolved);
  } catch {
    throw typedError("WORKFLOW", "Repository file does not exist: " + value + ".");
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) throw typedError("WORKFLOW", "Repository path is not a file: " + value + ".");
  const actual = await realpath(resolved);
  if (!isWithin(await realpath(repoRoot), actual)) {
    throw typedError("WORKFLOW", "Repository file resolves outside the worktree: " + value + ".");
  }
  return relative(repoRoot, resolved);
}

async function currentTestFingerprint(repoRoot, mappings) {
  const current = await refreshMappingHashes(repoRoot, mappings);
  current.sort((left, right) => left.ac_id.localeCompare(right.ac_id) || left.path.localeCompare(right.path));
  return createHash("sha256").update(JSON.stringify(current)).digest("hex");
}

function mergeMappings(existing, additions) {
  const result = new Map();
  for (const mapping of [...existing, ...additions]) {
    result.set(mapping.ac_id + "\0" + mapping.path, mapping);
  }
  return [...result.values()].sort((left, right) =>
    left.ac_id.localeCompare(right.ac_id) || left.path.localeCompare(right.path));
}

function assertCompleteAcMapping(spec, mappings, exceptionIds) {
  const mapped = new Set(mappings.map((item) => item.ac_id));
  const excepted = new Set(exceptionIds);
  const overlap = [...mapped].filter((id) => excepted.has(id));
  if (overlap.length > 0) throw typedError("WORKFLOW", "AC ids cannot be both tested and excepted: " + overlap.join(", "));
  const missing = spec.ac_ids.filter((id) => !mapped.has(id) && !excepted.has(id));
  if (missing.length > 0) {
    throw typedError("WORKFLOW", "Every AC must map to a test path or approved exception; missing: " + missing.join(", "));
  }
}

function testExceptionIds(state) {
  return unique((state.evidence || [])
    .filter((item) => item.event === "test-exception")
    .flatMap((item) => item.ac_ids || []));
}

function validateAcIds(acIds, spec) {
  const unknown = acIds.filter((id) => !spec.ac_ids.includes(id));
  if (unknown.length > 0) throw typedError("WORKFLOW", "Unknown AC ids: " + unknown.join(", "));
}

function assertReviewStage(state, mode) {
  if (mode === "audit" && state.status !== "VERIFIED") {
    throw typedError("WORKFLOW", "audit requires VERIFIED; current status is " + state.status + ".");
  }
}

async function inspectFinding(repoRoot, options) {
  const findingId = requireOption(options, "finding");
  const specPath = requireOption(options, "spec");
  const spec = await loadAndValidateSpec(repoRoot, specPath, arrayOption(options, "authority"));
  const loaded = await requireState(repoRoot, spec, stateFileLocation(repoRoot, spec.relative_path));
  for (const review of [loaded.state.last_reviewer_review, loaded.state.last_query_review].filter(Boolean)) {
    if (!review.finding_ids?.includes(findingId) || !review.raw_result_ref) continue;
    const raw = await readFile(review.raw_result_ref, "utf8");
    const envelope = validateReviewerEnvelope(extractJsonObject(raw), {
      mode: review.mode,
      runId: loaded.state.run_id,
      acIds: spec.ac_ids,
    });
    await validateEnvelopeEvidence(repoRoot, envelope);
    const finding = envelope.findings.find((item) => item.id === findingId);
    if (finding) return emit({ schema_version: 1, status: "READY", run_id: loaded.state.run_id, finding });
  }
  throw typedError("WORKFLOW", "Finding not found or its retained raw result is unavailable: " + findingId);
}

async function setupHook(repoRoot) {
  const asset = path.join(skillDirectory, "assets/codex-hook/implement-with-kimi.mjs");
  const targetDirectory = path.join(repoRoot, ".codex/hooks");
  const target = path.join(targetDirectory, "implement-with-kimi.mjs");
  const configPath = path.join(repoRoot, ".codex/hooks.json");
  const assetContent = await readFile(asset, "utf8");
  const currentScript = await readOptionalText(target);
  const currentHash = currentScript === null ? null : createHash("sha256").update(currentScript).digest("hex");
  if (currentScript !== null && currentScript !== assetContent && !LEGACY_HOOK_SHA256.has(currentHash)) {
    throw typedError("WORKFLOW", "Existing project Hook script differs from the Skill asset; refusing to overwrite it.");
  }
  const config = await readJsonOrDefault(configPath, {});
  const command = 'volta run node "$(git rev-parse --show-toplevel)/.codex/hooks/implement-with-kimi.mjs"';
  const merged = mergeHookConfig(config, command);
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(target, assetContent, "utf8");
  await writeJsonAtomic(configPath, merged);
  emit({
    schema_version: 1,
    status: "CONFIGURED_UNVERIFIED",
    files: [relative(repoRoot, configPath), relative(repoRoot, target)],
    next_action: "Run /hooks in Codex to review and trust the project hook.",
  });
}

async function removeHook(repoRoot) {
  const asset = path.join(skillDirectory, "assets/codex-hook/implement-with-kimi.mjs");
  const target = path.join(repoRoot, ".codex/hooks/implement-with-kimi.mjs");
  const configPath = path.join(repoRoot, ".codex/hooks.json");
  const config = await readJsonOrDefault(configPath, {});
  const removed = removeHookConfig(config);
  await writeJsonAtomic(configPath, removed);
  let script = "preserved";
  const [assetContent, targetContent] = await Promise.all([readFile(asset, "utf8"), readOptionalText(target)]);
  const targetHash = targetContent === null ? null : createHash("sha256").update(targetContent).digest("hex");
  if (targetContent === assetContent || LEGACY_HOOK_SHA256.has(targetHash)) {
    await unlink(target);
    script = "removed";
  }
  emit({ schema_version: 1, status: "REMOVED", config: relative(repoRoot, configPath), script });
}

async function requireState(repoRoot, spec, stateLocation) {
  const loaded = await readOptionalState(stateLocation);
  if (!loaded) throw typedError("WORKFLOW", "No state exists; run bootstrap --spec " + spec.relative_path + ".");
  const currentSpecHash = await sha256File(spec.absolute_path);
  if (loaded.state.spec_sha256 !== currentSpecHash) {
    throw typedError("WORKFLOW", "Specification changed; start a new bootstrap run.");
  }
  if (loaded.state.spec_path !== spec.relative_path) {
    throw typedError("WORKFLOW", "State file is paired with a different specification.");
  }
  if (!(await authorityMatches(repoRoot, loaded.state, spec))) {
    throw typedError("WORKFLOW", "Authority paths or contents changed; start bootstrap with --new-run --reason <reason>.");
  }
  return loaded;
}

async function authorityMatches(repoRoot, state, spec) {
  const expectedPaths = [...(state.authority_paths || [])].sort();
  const actualPaths = [...spec.authority_paths].sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) return false;
  try {
    const current = await hashAuthorities(repoRoot, actualPaths);
    return actualPaths.every((file) => current[file] === state.authority_hashes?.[file]);
  } catch {
    return false;
  }
}

async function summarizeLog(logPath, exitCode) {
  const content = await readFile(path.resolve(logPath));
  const text = content.toString("utf8");
  const max = exitCode === 0 ? 4_000 : 16_000;
  return {
    path: path.resolve(logPath),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
    truncated: text.length > max,
    excerpt: text.length > max
      ? text.slice(0, max / 2) + "\n... TRUNCATED ...\n" + text.slice(-max / 2)
      : text,
  };
}

async function assertNoOtherActiveState(repoRoot, stateLocation) {
  const states = await discoverStateDocuments(repoRoot);
  const conflicts = states.filter(
    (item) => item.state.active && path.resolve(item.absolute) !== path.resolve(stateLocation),
  );
  if (conflicts.length > 0) {
    throw typedError("WORKFLOW", "Another module is active: " + conflicts.map((item) => item.path).join(", "));
  }
}

async function hashAuthorities(repoRoot, paths) {
  const result = {};
  for (const file of paths) result[file] = await sha256File(path.join(repoRoot, file));
  return result;
}

function stateFileLocation(repoRoot, specPath) {
  return path.join(repoRoot, deriveStatePath(specPath));
}

async function readOptionalState(filePath) {
  try {
    return await readStateFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonOrDefault(filePath, fallback) {
  const text = await readOptionalText(filePath);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw typedError("WORKFLOW", "Existing " + filePath + " is not valid JSON: " + error.message);
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp-" + process.pid + "-" + Date.now();
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, filePath);
}

function emitReviewResult(result, state, repoRoot, stateLocation, { advisory = false } = {}) {
  emit({
    ...result.capsule,
    advisory,
    module_status: state.status,
    state_path: relative(repoRoot, stateLocation),
  });
  if (!advisory && isBlocking(result.envelope.status)) process.exitCode = EXIT.BLOCKED;
}

function summarizeFinding(finding) {
  return {
    id: finding.id,
    severity: finding.severity,
    title: finding.title,
    explanation: finding.explanation,
  };
}

function isBlocking(status) {
  return status === "CONFLICT" || status === "BLOCKED";
}

function nextActionForStatus(status) {
  const actions = {
    BOOTSTRAP_READY: "record tests-written",
    TESTS_WRITTEN: "record test evidence, then validate-tests",
    TESTS_VALIDATED: "record implementation-started",
    IMPLEMENTING: "record complete Green evidence",
    GREEN_CONFIRMED: "record verification-observed",
    VERIFIED: "run audit for REVIEW_READY, obtain approval, then add --execute-reviewer",
    BLOCKED: "resolve the recorded blocker, then run rehydrate",
  };
  return actions[status] || "inspect the state and specification";
}

function requireReviewerOption(options) {
  const reviewer = requireOption(options, "reviewer");
  if (!isReviewer(reviewer)) throw typedError("USAGE", "--reviewer must be kimi or claude-code.");
  return reviewer;
}

function rejectLegacyReviewerInterface(parsed) {
  if (LEGACY_COMMANDS.has(parsed.command)) {
    throw typedError("USAGE", parsed.command + " was removed; reviewer switching and automatic fallback are not supported.");
  }
  const supplied = LEGACY_OPTIONS.filter((name) => parsed.options[name] !== undefined);
  if (supplied.length > 0) {
    throw typedError(
      "USAGE",
      "Legacy reviewer options were removed (" + supplied.map((name) => "--" + name).join(", ") + "); choose one reviewer per run.",
    );
  }
}

function validateReviewerOptionScope(parsed) {
  if (parsed.options.reviewer === undefined) return;
  if (!["bootstrap", "select-reviewer", "resume"].includes(parsed.command)) {
    throw typedError("USAGE", "--reviewer is not accepted by " + parsed.command + ".");
  }
}

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function isWithin(root, candidate) {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

function emit(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function progress(value) {
  process.stderr.write("[implement-with-kimi] " + String(value) + "\n");
}

function requireOption(options, name) {
  const value = options[name];
  if (value === undefined || value === true || value === "") throw typedError("USAGE", "--" + name + " is required.");
  return Array.isArray(value) ? value.at(-1) : value;
}

function arrayOption(options, name) {
  const value = options[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(values) {
  return [...new Set(values)];
}

function parseArguments(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    return { command: null, event: null, options: { help: true } };
  }
  const command = argv[0];
  let index = 1;
  let event = null;
  if (command === "record" && argv[index] && !argv[index].startsWith("--")) event = argv[index++];
  const options = {};
  while (index < argv.length) {
    const token = argv[index++];
    if (!token.startsWith("--")) throw typedError("USAGE", "Unexpected argument: " + token);
    const name = token.slice(2);
    if (["new-run", "matched-expectation", "execute-reviewer", "consent-repository-to-reviewer", "help"].includes(name)) {
      options[name] = true;
      continue;
    }
    if (index >= argv.length || argv[index].startsWith("--")) {
      throw typedError("USAGE", token + " requires a value.");
    }
    const value = argv[index++];
    if (["authority", "ac", "test", "test-map"].includes(name)) {
      options[name] = [...(options[name] || []), value];
    } else {
      options[name] = value;
    }
  }
  return { command, event, options };
}

function exitCodeFor(error) {
  if (["WORKFLOW", "SPEC_INVALID", "PACKAGE_INVALID", "BLOCKED", "USAGE"].includes(error.kind)) return EXIT.BLOCKED;
  if (error.kind === "CONFIG") return EXIT.CONFIG;
  if (["SCHEMA", "PROTOCOL", "STALE", "POLICY_VIOLATION", "EVIDENCE"].includes(error.kind)) return EXIT.VALIDATION;
  if (/idle timeout/i.test(error.message) ||
      ["RETRY_EXHAUSTED", "CONTEXT_COMPACTED", "CONTEXT_OVERSIZE"].includes(error.kind)) return EXIT.TRANSIENT;
  if (error.kind === "CANCELLED") return EXIT.CANCELLED;
  return EXIT.GENERAL;
}

function typedError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function usage() {
  return [
    "implement-with-kimi",
    "",
    "Usage:",
    "  kimi_context.mjs validate-package --package <file> [--spec <module.md>]",
    "  kimi_context.mjs bootstrap --spec <file> --reviewer kimi|claude-code [--authority <file> ...]",
    "  kimi_context.mjs record tests-written --spec <file> --test-map AC-001=path [...]",
    "  kimi_context.mjs record red-planned|red-observed|baseline-green-observed|implementation-started|green-observed|verification-observed [...]",
    "  kimi_context.mjs validate-tests --spec <file>",
    "  kimi_context.mjs review-tests --spec <file>  # one-release local-only alias",
    "  kimi_context.mjs attach-test-map --spec <file> --test-map AC-001=path [...]",
    "  kimi_context.mjs rehydrate|suspend|resume --spec <file> [...]",
    "  kimi_context.mjs review-preview --mode audit|query --spec <file> [--question <text>]",
    "  kimi_context.mjs audit --spec <file> [--execute-reviewer]",
    "  kimi_context.mjs query --spec <file> --question <text> [--execute-reviewer]",
    "  kimi_context.mjs inspect --spec <file> --finding <id>",
    "  kimi_context.mjs setup-hook|remove-hook",
  ].join("\n");
}
