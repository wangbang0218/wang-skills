#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File } from "./lib/evidence.mjs";
import { validateImplementationPackage } from "./lib/document-package.mjs";
import { HOOK_STATUS_MESSAGE, mergeHookConfig, removeHookConfig } from "./lib/hook-config.mjs";
import { preflightKimi } from "./lib/preflight.mjs";
import { preflightClaude, runClaudeNode } from "./lib/claude-runner.mjs";
import {
  buildRepositoryCatalog,
  getRepoRoot,
  gitBaseline,
  reconcileSelectorPaths,
  renderContextPack,
  renderSelectorContext,
  repositoryFingerprint,
  selectRepositoryContext,
} from "./lib/repository.mjs";
import { probeKimiAvailability, runKimiNode, validateEnvelopeEvidence } from "./lib/runner.mjs";
import { validateReviewerEnvelope } from "./lib/schema.mjs";
import { classifyKimiFallback, fallbackEnabled, shouldUseStickyFallback } from "./lib/reviewer.mjs";
import { loadAndValidateSpec } from "./lib/spec.mjs";
import {
  applyStateEvent,
  activateReviewerFailover,
  clearReviewerFailover,
  createInitialState,
  deriveStatePath,
  discoverStateDocuments,
  enableReviewerFallback,
  readStateFile,
  writeStateFile,
} from "./lib/state.mjs";
import { extractJsonObject } from "./lib/prompt.mjs";
import { buildReviewStateSummary } from "./lib/review-context.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.dirname(scriptDirectory);
const CONTEXT_BUDGET = 650_000;
const SHRUNK_CONTEXT_BUDGET = 520_000;
const EXIT = { GENERAL: 1, BLOCKED: 2, CONFIG: 3, VALIDATION: 4, TRANSIENT: 5, CANCELLED: 6 };

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}

main().catch((error) => {
  const payload = {
    schema_version: 1,
    status: error.kind === "CANCELLED" ? "CANCELLED" : "ERROR",
    error: { kind: error.kind ?? "GENERAL", message: error.message, ...(error.details ? { details: error.details } : {}) },
    ...(error.issues ? { issues: error.issues } : {}),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCodeFor(error);
});

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.command || parsed.options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const repoRoot = getRepoRoot(process.cwd());

  if (parsed.command === "setup-hook") return setupHook(repoRoot);
  if (parsed.command === "remove-hook") return removeHook(repoRoot);
  if (parsed.command === "inspect") return inspectFinding(repoRoot, parsed.options);
  if (parsed.command === "validate-package") {
    const packagePath = requireOption(parsed.options, "package");
    const result = await validateImplementationPackage(repoRoot, packagePath, {
      specPath: parsed.options.spec ? requireOption(parsed.options, "spec") : null,
    });
    return emit(result);
  }

  const specPath = requireOption(parsed.options, "spec");
  const spec = await loadAndValidateSpec(repoRoot, specPath, arrayOption(parsed.options, "authority"));
  if (parsed.command === "bootstrap") return bootstrap(repoRoot, spec, parsed.options);
  if (parsed.command === "enable-reviewer-fallback") return enableFallback(repoRoot, spec, parsed.options);
  if (parsed.command === "retry-kimi") return retryKimi(repoRoot, spec);
  if (parsed.command === "record") return recordEvidence(repoRoot, spec, parsed.event, parsed.options);
  if (parsed.command === "suspend") return suspend(repoRoot, spec, parsed.options);
  if (parsed.command === "resume") return resume(repoRoot, spec, parsed.options);
  if (["review-tests", "rehydrate", "audit", "query"].includes(parsed.command)) {
    return reviewCommand(repoRoot, spec, parsed.command, parsed.options);
  }
  throw typedError("USAGE", `Unknown command: ${parsed.command}`);
}

async function bootstrap(repoRoot, spec, options) {
  if (options.goal !== undefined && !["active", "none"].includes(options.goal)) {
    throw typedError("USAGE", "--goal must be active or none.");
  }
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const specHash = await sha256File(spec.absolute_path);
  const existing = await readOptionalState(stateLocation);
  if (existing && existing.state.spec_sha256 === specHash && !options["new-run"] && !(await authorityMatches(repoRoot, existing.state, spec))) {
    throw typedError("WORKFLOW", "Authority paths or contents changed; start bootstrap with --new-run --reason <reason>.");
  }
  if (existing && existing.state.spec_sha256 === specHash && existing.state.status === "COMPLETED" && !options["new-run"]) {
    return emit({ schema_version: 1, status: "ALREADY_COMPLETED", run_id: existing.state.run_id, state_path: relative(repoRoot, stateLocation) });
  }
  const retryBlockedBootstrap = existing && existing.state.spec_sha256 === specHash &&
    (existing.state.status === "NOT_STARTED" || (existing.state.status === "BLOCKED" && existing.state.previous_status === "NOT_STARTED"));
  if (existing && existing.state.spec_sha256 === specHash && existing.state.status !== "COMPLETED" && !options["new-run"] && !retryBlockedBootstrap) {
    return emit({ schema_version: 1, status: "RESUME_REQUIRED", run_id: existing.state.run_id, state_path: relative(repoRoot, stateLocation) });
  }
  if (options["new-run"] && !options.reason) throw typedError("USAGE", "--new-run requires --reason.");

  await assertNoOtherActiveState(repoRoot, stateLocation);
  const runId = randomUUID();
  let state = retryBlockedBootstrap ? restoreBlockedState(existing.state, ["NOT_STARTED"]) : createInitialState({ specPath: spec.relative_path, specSha256: specHash, runId });
  if (!retryBlockedBootstrap) {
    state.authority_paths = spec.authority_paths;
    state.authority_hashes = await hashAuthorities(repoRoot, spec.authority_paths);
    state.git_baseline = gitBaseline(repoRoot);
    state.goal = { status: options.goal ?? "unknown" };
    if (!options.goal) state = applyStateEvent(state, "warning", { code: "GOAL_STATUS_UNKNOWN", message: "No Goal status was supplied." });
  }
  state = configureFallbackFromOptions(state, options);
  if (existing && !retryBlockedBootstrap) {
    const archived = structuredClone(existing.state);
    delete archived.past_runs;
    state.past_runs = [...(existing.state.past_runs ?? []), archived];
  }
  await writeStateFile(stateLocation, state, existing?.userNotes ?? "");

  const result = await executeReview(repoRoot, spec, state, "bootstrap", options, async (details) => {
    state = activateReviewerFailover(state, details);
    await writeStateFile(stateLocation, state, existing?.userNotes ?? "");
    return state;
  });
  state = applyReviewToState(state, result, "bootstrap-ready");
  await writeStateFile(stateLocation, state, existing?.userNotes ?? "");
  emitResult(result, state, repoRoot, stateLocation);
}

async function reviewCommand(repoRoot, spec, mode, options) {
  if (mode === "query") requireOption(options, "question");
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  let state = loaded.state;
  if (!state.active) throw typedError("WORKFLOW", `Module is not active; use resume --spec ${spec.relative_path}.`);

  const allTestsExcepted = hasAllTestExceptions(state, spec.ac_ids);
  const requirements = {
    "review-tests": allTestsExcepted ? ["TESTS_WRITTEN", "RED_CONFIRMED"] : ["RED_CONFIRMED"],
    audit: ["VERIFIED"],
  };
  if (requirements[mode]) state = restoreBlockedState(state, requirements[mode]);
  if (requirements[mode] && !requirements[mode].includes(state.status)) {
    throw typedError("WORKFLOW", `${mode} requires ${requirements[mode].join(" or ")}; current status is ${state.status}.`);
  }
  if (mode === "audit" && state.implementation_fingerprint !== repositoryFingerprint(repoRoot)) {
    state.status = "IMPLEMENTING";
    state.history.push({ at: new Date().toISOString(), event: "audit-invalidated", status: state.status, details: { reason: "implementation_fingerprint_changed" } });
    await writeStateFile(stateLocation, state, loaded.userNotes);
    throw typedError("WORKFLOW", "Implementation changed after verification; rerun Green and verification before audit.");
  }

  const result = await executeReview(repoRoot, spec, state, mode, options, async (details) => {
    state = activateReviewerFailover(state, details);
    await writeStateFile(stateLocation, state, loaded.userNotes);
    return state;
  });
  const successEvent = mode === "review-tests" ? "tests-reviewed" : mode === "audit" ? "audited" : null;
  state = applyReviewToState(state, result, successEvent);
  if (mode === "rehydrate" && !isBlocking(result.envelope.status)) {
    state = rollbackStaleMilestoneIfNeeded(state, repoRoot);
    state.history.push({ at: new Date().toISOString(), event: "rehydrated", status: state.status, details: { context_hash: result.envelope.snapshot.before } });
  }
  if (mode === "audit" && !isBlocking(result.envelope.status)) state = applyStateEvent(state, "completed", {});
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emitResult(result, state, repoRoot, stateLocation);
}

async function resume(repoRoot, spec, options) {
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.suspended) throw typedError("WORKFLOW", "Only a suspended module can be resumed.");
  await assertNoOtherActiveState(repoRoot, stateLocation);
  let activeState = loaded.state;
  const result = await executeReview(repoRoot, spec, activeState, "rehydrate", options, async (details) => {
    activeState = activateReviewerFailover(activeState, details);
    await writeStateFile(stateLocation, activeState, loaded.userNotes);
    return activeState;
  });
  let state = applyReviewToState(activeState, result, null);
  if (!isBlocking(result.envelope.status)) {
    state = applyStateEvent(state, "resume", {});
    state = rollbackStaleMilestoneIfNeeded(state, repoRoot);
  }
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emitResult(result, state, repoRoot, stateLocation);
}

async function suspend(repoRoot, spec, options) {
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  const reason = requireOption(options, "reason");
  const state = applyStateEvent(loaded.state, "suspend", {
    reason,
    implementation_fingerprint: repositoryFingerprint(repoRoot),
    git_baseline: gitBaseline(repoRoot),
  });
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({ schema_version: 1, status: "SUSPENDED", run_id: state.run_id, state_path: relative(repoRoot, stateLocation) });
}

async function enableFallback(repoRoot, spec, options) {
  validateFallbackOptions(options, { required: true });
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.active) throw typedError("WORKFLOW", "Reviewer fallback can only be enabled for an active run.");
  await preflightClaude();
  const state = enableReviewerFallback(loaded.state);
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({
    schema_version: 1,
    status: "REVIEWER_FALLBACK_ENABLED",
    run_id: state.run_id,
    fallback_reviewer: "claude-code",
    required_context_tokens: 1_048_576,
    state_path: relative(repoRoot, stateLocation),
  });
}

async function retryKimi(repoRoot, spec) {
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.active) throw typedError("WORKFLOW", "Kimi can only be retried for an active run.");
  if (!fallbackEnabled(loaded.state)) throw typedError("WORKFLOW", "Reviewer fallback is not enabled for this run.");
  const preflight = await preflightKimi();
  await probeKimiAvailability({ repoRoot, preflight, signal: controller.signal, onProgress: progress });
  const state = clearReviewerFailover(loaded.state);
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({ schema_version: 1, status: "KIMI_READY", run_id: state.run_id, state_path: relative(repoRoot, stateLocation) });
}

async function recordEvidence(repoRoot, spec, event, options) {
  if (!event) throw typedError("USAGE", "record requires an event name.");
  const stateLocation = stateFileLocation(repoRoot, spec.relative_path);
  const loaded = await requireState(repoRoot, spec, stateLocation);
  if (!loaded.state.active) throw typedError("WORKFLOW", "Cannot record evidence for an inactive module.");
  const details = await eventDetails(event, options, spec, loaded.state);
  let state = applyStateEvent(loaded.state, event, details);
  state.implementation_fingerprint = repositoryFingerprint(repoRoot);
  await writeStateFile(stateLocation, state, loaded.userNotes);
  emit({ schema_version: 1, status: "RECORDED", event, run_id: state.run_id, module_status: state.status, state_path: relative(repoRoot, stateLocation) });
}

async function executeReview(repoRoot, spec, state, mode, options, onFailover = async () => state) {
  let activeState = state;
  let kimiPreflight = null;
  let claudePreflight = null;
  let stickyFallback = shouldUseStickyFallback(activeState);
  const runReviewerNode = async (node) => {
    if (!stickyFallback) {
      try {
        kimiPreflight ??= await preflightKimi();
        progress(`Kimi ${kimiPreflight.version}; model ${kimiPreflight.model_alias}; mode ${node.mode}`);
        const result = await runKimiNode({ ...node, preflight: kimiPreflight });
        result.envelope.reviewer = "kimi";
        return result;
      } catch (error) {
        const fallback = fallbackEnabled(activeState) ? classifyKimiFallback(error) : null;
        if (!fallback) {
          error.reviewer = "kimi";
          throw error;
        }
        const details = {
          scope: fallback.scope,
          reasonCode: fallback.reason_code,
          message: error.message,
        };
        activeState = await onFailover(details);
        stickyFallback = fallback.scope === "RUN";
        progress(`Kimi unavailable (${fallback.reason_code}); using Claude Code for ${fallback.scope === "RUN" ? "this run" : "this node"}`);
      }
    }
    claudePreflight ??= await preflightClaude();
    progress(`Claude Code ${claudePreflight.version}; configured default provider/model; mode ${node.mode}`);
    try {
      return await runClaudeNode({ ...node, preflight: claudePreflight });
    } catch (error) {
      error.reviewer = "claude-code";
      error.details = {
        fallback_reviewer: "claude-code",
        kimi_failure: activeState.reviewer_failover?.message ?? null,
      };
      throw error;
    }
  };
  const catalog = await buildRepositoryCatalog(repoRoot, { specPath: spec.relative_path, authorityPaths: spec.authority_paths });
  let selectorPaths = [];
  let selection = selectRepositoryContext(catalog, { budgetTokens: CONTEXT_BUDGET });
  if (selection.status === "BLOCKED") throw typedError("BLOCKED", selection.reason);

  const total = catalog.catalog.reduce((sum, file) => sum + file.estimated_tokens, 0);
  if (total > CONTEXT_BUDGET) {
    const selectorContext = renderSelectorContext(catalog, spec, CONTEXT_BUDGET);
    const selector = await runReviewerNode({
      repoRoot,
      mode: "selector",
      runId: state.run_id,
      specPath: spec.relative_path,
      acIds: spec.ac_ids,
      contextPack: selectorContext,
      signal: controller.signal,
      onProgress: progress,
    });
    const selectedPaths = selector.envelope.selected_paths;
    if (!Array.isArray(selectedPaths)) throw typedError("SCHEMA", "Selector response is missing selected_paths.");
    const reconciledPaths = reconcileSelectorPaths(catalog, selectedPaths);
    if (reconciledPaths.unknownPaths.length > 0) {
      throw typedError("SCHEMA", `Selector returned unknown paths: ${reconciledPaths.unknownPaths.join(", ")}`);
    }
    if (reconciledPaths.ignoredManagedStatePaths.length > 0) {
      progress(`Selector ignored managed state paths: ${reconciledPaths.ignoredManagedStatePaths.join(", ")}`);
    }
    selectorPaths = reconciledPaths.selectedPaths;
    selection = selectRepositoryContext(catalog, { budgetTokens: CONTEXT_BUDGET, selectorPaths });
    if (selection.status === "BLOCKED") throw typedError("BLOCKED", selection.reason);
  }

  const runSelection = (selected) => runReviewerNode({
    repoRoot,
    mode,
    runId: state.run_id,
    specPath: spec.relative_path,
    acIds: spec.ac_ids,
    contextPack: renderReviewContext(catalog, selected, activeState, spec, mode),
    question: options.question,
    signal: controller.signal,
    onProgress: progress,
  });

  try {
    return await runSelection(selection);
  } catch (error) {
    if (!["CONTEXT_COMPACTED", "CONTEXT_OVERSIZE"].includes(error.kind) || error.reviewer === "claude-code") throw error;
    progress(`Kimi context retry after ${error.kind}; shrinking initial pack to ${SHRUNK_CONTEXT_BUDGET} tokens`);
    const shrunk = selectRepositoryContext(catalog, { budgetTokens: SHRUNK_CONTEXT_BUDGET, selectorPaths });
    if (shrunk.status === "BLOCKED") throw typedError("BLOCKED", shrunk.reason);
    try {
      return await runSelection(shrunk);
    } catch (retryError) {
      if (["CONTEXT_COMPACTED", "CONTEXT_OVERSIZE"].includes(retryError.kind)) {
        throw typedError("BLOCKED", `Kimi context remained oversized after one deterministic shrink: ${retryError.message}`);
      }
      throw retryError;
    }
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
      state_summary: buildReviewStateSummary(state),
    },
  );
}

function applyReviewToState(inputState, result, successEvent) {
  let state = structuredClone(inputState);
  if (!isBlocking(result.envelope.status) && state.status === "BLOCKED" && state.previous_status) {
    state.status = state.previous_status;
  }
  state.last_reviewer_review = {
    at: new Date().toISOString(),
    reviewer: result.envelope.reviewer ?? "kimi",
    mode: result.envelope.mode,
    status: result.envelope.status,
    model: result.envelope.model,
    snapshot: result.envelope.snapshot,
    raw_result_ref: result.envelope.raw_result_ref,
    finding_ids: result.envelope.findings.map((finding) => finding.id),
  };
  state.unresolved_findings = result.envelope.findings.filter((finding) => ["CONFLICT", "BLOCKED"].includes(finding.severity)).map(summarizeFinding);
  state.warnings.push(...result.envelope.findings.filter((finding) => finding.severity === "WARNING").map(summarizeFinding));
  if (isBlocking(result.envelope.status)) {
    state = applyStateEvent(state, "blocked", { mode: result.envelope.mode, findings: state.unresolved_findings });
  } else if (successEvent) {
    state = applyStateEvent(state, successEvent, { review_status: result.envelope.status });
  }
  return state;
}

function rollbackStaleMilestoneIfNeeded(state, repoRoot) {
  const current = repositoryFingerprint(repoRoot);
  if (state.implementation_fingerprint && state.implementation_fingerprint !== current && ["GREEN_CONFIRMED", "VERIFIED", "AUDITED"].includes(state.status)) {
    state.history.push({ at: new Date().toISOString(), event: "milestone-rolled-back", status: "IMPLEMENTING", details: { from: state.status, reason: "implementation_fingerprint_changed" } });
    state.status = "IMPLEMENTING";
  }
  state.implementation_fingerprint = current;
  return state;
}

async function inspectFinding(repoRoot, options) {
  const findingId = requireOption(options, "finding");
  const specPath = requireOption(options, "spec");
  const spec = await loadAndValidateSpec(repoRoot, specPath, arrayOption(options, "authority"));
  const loaded = await requireState(repoRoot, spec, stateFileLocation(repoRoot, spec.relative_path));
  const review = loaded.state.last_reviewer_review;
  const ref = review?.raw_result_ref;
  if (!ref) throw typedError("WORKFLOW", "No retained reviewer result is available.");
  const raw = await readFile(ref, "utf8");
  const envelope = validateReviewerEnvelope(extractJsonObject(raw), {
    mode: review.mode,
    runId: loaded.state.run_id,
    acIds: spec.ac_ids,
  });
  await validateEnvelopeEvidence(repoRoot, envelope);
  const finding = envelope.findings.find((item) => item.id === findingId);
  if (!finding) throw typedError("WORKFLOW", `Finding not found: ${findingId}`);
  emit({ schema_version: 1, status: "READY", run_id: loaded.state.run_id, finding });
}

async function setupHook(repoRoot) {
  const asset = path.join(skillDirectory, "assets/codex-hook/implement-with-kimi.mjs");
  const targetDirectory = path.join(repoRoot, ".codex/hooks");
  const target = path.join(targetDirectory, "implement-with-kimi.mjs");
  const configPath = path.join(repoRoot, ".codex/hooks.json");
  const assetContent = await readFile(asset, "utf8");
  const currentScript = await readOptionalText(target);
  if (currentScript !== null && currentScript !== assetContent) {
    throw typedError("WORKFLOW", "Existing project Hook script differs from the Skill asset; refusing to overwrite it.");
  }
  const config = await readJsonOrDefault(configPath, {});
  const command = 'node "$(git rev-parse --show-toplevel)/.codex/hooks/implement-with-kimi.mjs"';
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
  if (targetContent === assetContent) {
    await unlink(target);
    script = "removed";
  }
  emit({ schema_version: 1, status: "REMOVED", config: relative(repoRoot, configPath), script });
}

async function requireState(repoRoot, spec, stateLocation) {
  const loaded = await readOptionalState(stateLocation);
  if (!loaded) throw typedError("WORKFLOW", `No state exists; run bootstrap --spec ${spec.relative_path}.`);
  const currentSpecHash = await sha256File(spec.absolute_path);
  if (loaded.state.spec_sha256 !== currentSpecHash) throw typedError("WORKFLOW", "Specification changed; start a new bootstrap run.");
  if (loaded.state.spec_path !== spec.relative_path) throw typedError("WORKFLOW", "State file is paired with a different specification.");
  if (!(await authorityMatches(repoRoot, loaded.state, spec))) {
    throw typedError("WORKFLOW", "Authority paths or contents changed; start bootstrap with --new-run --reason <reason>.");
  }
  return loaded;
}

async function eventDetails(event, options, spec, state) {
  if (event === "tests-written") {
    const acIds = unique(arrayOption(options, "ac"));
    validateAcIds(acIds, spec);
    const exceptionIds = testExceptionIds(state);
    const overlap = acIds.filter((id) => exceptionIds.includes(id));
    if (overlap.length > 0) throw typedError("WORKFLOW", `AC ids cannot be both tested and excepted: ${overlap.join(", ")}`);
    const missing = spec.ac_ids.filter((id) => !acIds.includes(id) && !exceptionIds.includes(id));
    if (missing.length > 0) throw typedError("WORKFLOW", `Every AC must be mapped to tests or an approved exception; missing: ${missing.join(", ")}`);
    return { ac_ids: acIds, exception_ac_ids: exceptionIds };
  }
  if (event === "red-planned") {
    const acIds = unique(arrayOption(options, "ac"));
    if (acIds.length === 0) throw typedError("USAGE", "red-planned requires at least one --ac.");
    validateAcIds(acIds, spec);
    const excepted = testExceptionIds(state);
    const invalid = acIds.filter((id) => excepted.includes(id));
    if (invalid.length > 0) throw typedError("WORKFLOW", `Cannot plan Red for excepted AC ids: ${invalid.join(", ")}`);
    const mapped = [...state.history].reverse().find((item) => item.event === "tests-written")?.details?.ac_ids ?? [];
    const unmapped = acIds.filter((id) => !mapped.includes(id));
    if (unmapped.length > 0) throw typedError("WORKFLOW", `Red AC ids were not mapped by tests-written: ${unmapped.join(", ")}`);
    return { expected_failure: requireOption(options, "expected-failure"), ac_ids: acIds };
  }
  if (event === "test-exception") {
    const acIds = unique(arrayOption(options, "ac"));
    if (acIds.length === 0) throw typedError("USAGE", "test-exception requires at least one --ac.");
    validateAcIds(acIds, spec);
    return { reason: requireOption(options, "reason"), ac_ids: acIds };
  }
  if (event === "implementation-started") return {};
  if (["red-observed", "green-observed", "verification-observed"].includes(event)) {
    const exitCode = Number(requireOption(options, "exit-code"));
    if (!Number.isInteger(exitCode)) throw typedError("USAGE", "--exit-code must be an integer.");
    return {
      command: requireOption(options, "command"),
      exit_code: exitCode,
      matched_expectation: event === "red-observed" ? options["matched-expectation"] === true : undefined,
      log: options.log ? await summarizeLog(options.log, exitCode) : null,
    };
  }
  throw typedError("USAGE", `Unsupported record event: ${event}`);
}

function testExceptionIds(state) {
  return unique(state.evidence.filter((item) => item.event === "test-exception").flatMap((item) => item.ac_ids ?? []));
}

function hasAllTestExceptions(state, acIds) {
  const excepted = new Set(testExceptionIds(state));
  return acIds.length > 0 && acIds.every((id) => excepted.has(id));
}

function validateAcIds(acIds, spec) {
  const unknown = acIds.filter((id) => !spec.ac_ids.includes(id));
  if (unknown.length > 0) throw typedError("WORKFLOW", `Unknown AC ids: ${unknown.join(", ")}`);
}

function unique(values) {
  return [...new Set(values)];
}

function configureFallbackFromOptions(state, options) {
  const supplied = options["fallback-reviewer"] !== undefined || options["reviewer-context"] !== undefined || options["consent-repository-to-reviewer"] === true;
  if (!supplied) return state;
  validateFallbackOptions(options, { required: true });
  return enableReviewerFallback(state);
}

function validateFallbackOptions(options, { required = false } = {}) {
  const reviewer = options["fallback-reviewer"];
  const context = String(options["reviewer-context"] ?? "").toLowerCase();
  const consent = options["consent-repository-to-reviewer"] === true;
  if (required && reviewer !== "claude-code") throw typedError("USAGE", "--fallback-reviewer must be claude-code.");
  if (required && !["1m", "1048576", "1,048,576"].includes(context)) {
    throw typedError("USAGE", "--reviewer-context must explicitly declare 1m.");
  }
  if (required && !consent) throw typedError("USAGE", "--consent-repository-to-reviewer is required.");
}

async function authorityMatches(repoRoot, state, spec) {
  const expectedPaths = [...(state.authority_paths ?? [])].sort();
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
    excerpt: text.length > max ? `${text.slice(0, max / 2)}\n... TRUNCATED ...\n${text.slice(-max / 2)}` : text,
  };
}

function restoreBlockedState(state, expected) {
  if (state.status === "BLOCKED" && expected.includes(state.previous_status)) {
    const restored = structuredClone(state);
    restored.status = restored.previous_status;
    return restored;
  }
  return state;
}

async function assertNoOtherActiveState(repoRoot, stateLocation) {
  const states = await discoverStateDocuments(repoRoot);
  const conflicts = states.filter((item) => item.state.active && path.resolve(item.absolute) !== path.resolve(stateLocation));
  if (conflicts.length > 0) throw typedError("WORKFLOW", `Another module is active: ${conflicts.map((item) => item.path).join(", ")}`);
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
    throw typedError("WORKFLOW", `Existing ${filePath} is not valid JSON: ${error.message}`);
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function emitResult(result, state, repoRoot, stateLocation) {
  emit({ ...result.capsule, module_status: state.status, state_path: relative(repoRoot, stateLocation) });
  if (isBlocking(result.envelope.status)) process.exitCode = EXIT.BLOCKED;
}

function summarizeFinding(finding) {
  return { id: finding.id, severity: finding.severity, title: finding.title, explanation: finding.explanation };
}

function isBlocking(status) {
  return status === "CONFLICT" || status === "BLOCKED";
}

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function progress(value) {
  process.stderr.write(`[implement-with-kimi] ${String(value)}\n`);
}

function requireOption(options, name) {
  const value = options[name];
  if (value === undefined || value === true || value === "") throw typedError("USAGE", `--${name} is required.`);
  return Array.isArray(value) ? value.at(-1) : value;
}

function arrayOption(options, name) {
  const value = options[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
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
    if (!token.startsWith("--")) throw typedError("USAGE", `Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (["new-run", "matched-expectation", "consent-repository-to-reviewer", "help"].includes(name)) {
      options[name] = true;
      continue;
    }
    if (index >= argv.length || argv[index].startsWith("--")) throw typedError("USAGE", `${token} requires a value.`);
    const value = argv[index++];
    if (["authority", "ac"].includes(name)) {
      options[name] = [...(options[name] ?? []), value];
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
  if (/idle timeout/i.test(error.message) || ["RETRY_EXHAUSTED", "CONTEXT_COMPACTED", "CONTEXT_OVERSIZE"].includes(error.kind)) return EXIT.TRANSIENT;
  if (error.kind === "CANCELLED") return EXIT.CANCELLED;
  return EXIT.GENERAL;
}

function typedError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function usage() {
  return `implement-with-kimi

Usage:
  kimi_context.mjs validate-package --package <file> [--spec <module.md>]
  kimi_context.mjs bootstrap --spec <file> [--authority <file> ...] [--goal active|none]
    [--fallback-reviewer claude-code --reviewer-context 1m --consent-repository-to-reviewer]
  kimi_context.mjs enable-reviewer-fallback --spec <file> --fallback-reviewer claude-code
    --reviewer-context 1m --consent-repository-to-reviewer
  kimi_context.mjs retry-kimi --spec <file> [--authority <file> ...]
  kimi_context.mjs review-tests|rehydrate|audit --spec <file> [--authority <file> ...]
  kimi_context.mjs query --spec <file> --question <text> [--authority <file> ...]
  kimi_context.mjs record <event> --spec <file> [event evidence options]
  kimi_context.mjs suspend|resume --spec <file> [--reason <text>]
  kimi_context.mjs inspect --spec <file> --finding <id>
  kimi_context.mjs setup-hook|remove-hook`;
}
