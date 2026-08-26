import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { estimateTokens } from "./context-pack.mjs";

export const LARGE_RUN_CONTEXT_BUDGET = 1_000_000;
export const LARGE_RUN_RESPONSE_RESERVE = 32_000;

const REVIEWER_CONTEXT_CAPABILITY = 1_048_576;
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

export function buildLargeRunContext(repoRoot, catalogResult, {
  baseline,
  fullPaths = [],
  metadata = {},
  ordinaryBlock = null,
  budgetTokens = LARGE_RUN_CONTEXT_BUDGET,
} = {}) {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    throw new Error("budgetTokens must be positive.");
  }

  const runDelta = structuredClone(catalogResult.run_delta ?? []);
  const catalogByPath = new Map(catalogResult.catalog.map((entry) => [entry.path, entry]));
  const currentTracked = new Set(splitNull(gitText(repoRoot, ["ls-files", "--cached", "-z"])));
  const baselineHead = baseline?.head ?? null;
  let baselineEntries = new Map();
  if (baselineHead) {
    const valid = gitTextResult(repoRoot, ["cat-file", "-e", `${baselineHead}^{commit}`]);
    if (valid.status !== 0) {
      return blocked(`The captured baseline commit is unavailable: ${baselineHead}.`, budgetTokens);
    }
    baselineEntries = listBaselineEntries(repoRoot, baselineHead);
  }

  const trackedDelta = [];
  const fullDelta = [];
  const unavailableDelta = [];
  for (const entry of runDelta) {
    const tracked = Boolean(baselineHead) &&
      (baselineEntries.has(entry.path) || currentTracked.has(entry.path));
    if (tracked) trackedDelta.push(entry);
    else if (entry.kind === "missing") unavailableDelta.push(entry);
    else fullDelta.push(entry);
  }
  if (unavailableDelta.length > 0) {
    return blocked(
      "Large-run context cannot reconstruct deleted untracked baseline content: " +
        unavailableDelta.map((entry) => entry.path).join(", ") + ".",
      budgetTokens,
    );
  }

  for (const entry of trackedDelta) {
    if (entry.kind !== "missing" && entry.kind !== "file") {
      return blocked(`Large-run tracked delta must be regular UTF-8 text: ${entry.path}.`, budgetTokens);
    }
    if (entry.kind !== "missing" && !catalogByPath.has(entry.path)) {
      return blocked(`Large-run tracked delta is not eligible UTF-8 text: ${entry.path}.`, budgetTokens);
    }
    const baselineEntry = baselineEntries.get(entry.path);
    if (!baselineEntry) continue;
    if (baselineEntry.type !== "blob" || baselineEntry.mode === "120000") {
      return blocked(`Large-run baseline delta must be a regular text blob: ${entry.path}.`, budgetTokens);
    }
    const baselineBody = gitBuffer(repoRoot, ["cat-file", "blob", baselineEntry.object]);
    if (!isUtf8Text(baselineBody)) {
      return blocked(`Large-run baseline delta is not eligible UTF-8 text: ${entry.path}.`, budgetTokens);
    }
    baselineEntry.sha256 = sha256(baselineBody);
  }

  const requiredFullPaths = new Set([...fullPaths, ...fullDelta.map((entry) => entry.path)]);
  const missingFullPaths = [...requiredFullPaths].filter((file) => !catalogByPath.has(file)).sort();
  if (missingFullPaths.length > 0) {
    return blocked(`Missing mandatory large-run full text: ${missingFullPaths.join(", ")}.`, budgetTokens);
  }
  const selected = [...requiredFullPaths]
    .map((file) => catalogByPath.get(file))
    .sort((left, right) => left.path.localeCompare(right.path));
  const selectedPaths = new Set(selected.map((entry) => entry.path));
  const trackedPaths = trackedDelta.map((entry) => entry.path).sort();
  const trackedPathSet = new Set(trackedPaths);
  const represented = trackedDelta
    .map((entry) => {
      const current = catalogByPath.get(entry.path);
      const baselineEntry = baselineEntries.get(entry.path);
      return {
        path: entry.path,
        current_sha256: current?.sha256 ?? null,
        baseline_sha256: baselineEntry?.sha256 ?? null,
        status: entry.status,
        baseline_status: entry.baseline_status,
        kind: entry.kind,
        representation: "complete_unified_diff",
        full_body_included: selectedPaths.has(entry.path),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const diffText = trackedPaths.length === 0
    ? ""
    : gitText(repoRoot, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        "--unified=0",
        "--no-renames",
        baselineHead,
        "--",
        ...trackedPaths.map(literalPathspec),
      ]);
  const diff = {
    baseline_head: baselineHead,
    sha256: sha256(diffText),
    bytes: Buffer.byteLength(diffText, "utf8"),
    estimated_tokens: estimateTokens(diffText),
    path_count: trackedPaths.length,
    paths: trackedPaths,
    complete: true,
    context_lines: 0,
    binary_capable: true,
    renames: false,
  };

  const omitted = catalogResult.catalog
    .filter((entry) => !selectedPaths.has(entry.path) && !trackedPathSet.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      reason: "large_run_initial_pack",
      estimated_tokens: entry.estimated_tokens,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const mandatoryPaths = [...new Set([...selectedPaths, ...trackedPaths])].sort();
  const manifestOmitted = omitted.map((entry) => [
    entry.path,
    entry.sha256,
    entry.estimated_tokens,
    entry.reason,
  ]);
  const manifestExcluded = (catalogResult.excluded ?? [])
    .filter((entry) => !trackedPathSet.has(entry.path))
    .map((entry) => [entry.path, entry.reason]);
  const untrackedDelta = fullDelta
    .map((entry) => [
      entry.path,
      entry.status,
      entry.baseline_status,
      entry.baseline_sha256,
      entry.sha256,
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
  const manifest = {
    version: 3,
    representation: "large_run_unified_diff",
    mandatory_completeness: "FULL",
    completeness: omitted.length === 0 ? "FULL" : "PARTIAL",
    budget_tokens: budgetTokens,
    estimated_tokens: 0,
    mandatory_tokens: 0,
    reviewer_context_capability_tokens: REVIEWER_CONTEXT_CAPABILITY,
    response_reserve_tokens: LARGE_RUN_RESPONSE_RESERVE,
    ordinary_full_file_block: ordinaryBlock,
    selected: selected.map(({ path, sha256: hash, bytes, estimated_tokens, tier, mandatory, run_delta }) => ({
      path,
      sha256: hash,
      bytes,
      estimated_tokens,
      tier,
      mandatory: mandatory === true || requiredFullPaths.has(path),
      run_delta: run_delta === true,
      representation: "full_text",
    })),
    represented,
    omitted_schema: ["path", "sha256", "estimated_tokens", "reason"],
    omitted: manifestOmitted,
    excluded_schema: ["path", "reason"],
    excluded: manifestExcluded,
    untracked_delta_schema: ["path", "status", "baseline_status", "baseline_sha256", "current_sha256"],
    untracked_delta: untrackedDelta,
    run_delta_count: runDelta.length,
    tracked_delta_diff: diff,
    ...metadata,
  };
  const rendered = renderStablePack(manifest, selected, diffText);
  if (rendered.estimatedTokens > budgetTokens) {
    return {
      ...blocked(
        `The lossless large-run context requires ${rendered.estimatedTokens} tokens, exceeding the ${budgetTokens} token budget; no file or diff was truncated.`,
        budgetTokens,
      ),
      estimated_tokens: rendered.estimatedTokens,
      mandatory_tokens: rendered.estimatedTokens,
      full_file_count: selected.length,
      tracked_delta_count: trackedPaths.length,
      diff_bytes: diff.bytes,
    };
  }

  return {
    status: "READY",
    representation: "large_run_unified_diff",
    selected,
    represented,
    omitted,
    estimated_tokens: rendered.estimatedTokens,
    mandatory_tokens: rendered.estimatedTokens,
    budget_tokens: budgetTokens,
    mandatory_paths: mandatoryPaths,
    full_file_paths: [...selectedPaths].sort(),
    untracked_delta_full_paths: fullDelta.map((entry) => entry.path).sort(),
    diff: { ...diff, text: diffText },
    context_pack: rendered.contextPack,
    context_pack_sha256: sha256(rendered.contextPack),
  };
}

function renderStablePack(manifest, selected, diffText) {
  let estimatedTokens = 0;
  let contextPack = "";
  for (let iteration = 0; iteration < 12; iteration += 1) {
    manifest.estimated_tokens = estimatedTokens;
    manifest.mandatory_tokens = estimatedTokens;
    contextPack = renderPack(manifest, selected, diffText);
    const next = estimateTokens(contextPack);
    if (next === estimatedTokens) return { contextPack, estimatedTokens };
    estimatedTokens = next;
  }
  manifest.estimated_tokens = estimatedTokens;
  manifest.mandatory_tokens = estimatedTokens;
  contextPack = renderPack(manifest, selected, diffText);
  return { contextPack, estimatedTokens: estimateTokens(contextPack) };
}

function renderPack(manifest, selected, diffText) {
  const sections = selected.map(
    (file) => `\n<repository-file path=${JSON.stringify(file.path)} sha256=${JSON.stringify(file.sha256)}>\n${file.text}\n</repository-file>`,
  );
  const diffSection = [
    "",
    `<run-delta-unified-diff baseline_head=${JSON.stringify(manifest.tracked_delta_diff.baseline_head)} sha256=${JSON.stringify(manifest.tracked_delta_diff.sha256)} complete=\"true\" context_lines=\"0\">`,
    diffText,
    "</run-delta-unified-diff>",
  ].join("\n");
  return `<implement-with-kimi-context>\n${JSON.stringify(manifest)}${sections.join("\n")}${diffSection}\n</implement-with-kimi-context>`;
}

function listBaselineEntries(repoRoot, baselineHead) {
  const records = splitNull(gitText(repoRoot, ["ls-tree", "-r", "-z", baselineHead]));
  const entries = new Map();
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object] = record.slice(0, tab).split(" ");
    entries.set(record.slice(tab + 1), { mode, type, object, sha256: null });
  }
  return entries;
}

function isUtf8Text(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function literalPathspec(file) {
  return `:(top,literal)${file}`;
}

function blocked(reason, budgetTokens) {
  return { status: "BLOCKED", reason, selected: [], omitted: [], budget_tokens: budgetTokens };
}

function gitText(repoRoot, args) {
  const result = gitTextResult(repoRoot, args);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Git command failed: git ${args.join(" ")}`);
  return result.stdout;
}

function gitTextResult(repoRoot, args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: MAX_GIT_BUFFER });
}

function gitBuffer(repoRoot, args) {
  const result = spawnSync("git", args, { cwd: repoRoot, maxBuffer: MAX_GIT_BUFFER });
  if (result.status !== 0) throw new Error(String(result.stderr || "").trim() || `Git command failed: git ${args.join(" ")}`);
  return result.stdout;
}

function splitNull(value) {
  return String(value || "").split("\0").filter(Boolean);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
