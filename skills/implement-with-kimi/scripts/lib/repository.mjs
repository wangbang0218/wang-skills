import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { estimateTokens, selectContextFiles } from "./context-pack.mjs";

export const INITIAL_CONTEXT_BUDGET = 700_000;
export const QUERY_ADDITIONAL_CONTEXT_BUDGET = 150_000;

export function getRepoRoot(cwd = process.cwd()) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) throw new Error("implement-with-kimi requires a Git worktree.");
  return result.stdout.trim();
}

export async function buildRepositoryCatalog(repoRoot, {
  specPath,
  specText = "",
  authorityPaths = [],
  mandatoryPaths = [],
  explicitPaths = [],
  runDelta = [],
} = {}) {
  const files = listGitFiles(repoRoot);
  const agentPaths = files.filter((file) => /(^|\/)AGENTS\.md$/.test(file));
  const required = new Set([specPath, ...authorityPaths, ...agentPaths, ...mandatoryPaths].filter(Boolean));
  const explicit = new Set([...explicitPaths, ...extractSpecPaths(specText, specPath)]);
  const catalog = [];
  const excluded = [];

  for (const file of files) {
    if (file.endsWith(".state.md")) {
      excluded.push({ path: file, reason: "managed_state" });
      continue;
    }
    const absolute = path.join(repoRoot, file);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch {
      excluded.push({ path: file, reason: "deleted_or_unreadable" });
      continue;
    }
    if (stat.isSymbolicLink()) {
      const rootReal = await realpath(repoRoot);
      const target = await realpath(absolute);
      if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) {
        excluded.push({ path: file, reason: "external_symlink" });
        continue;
      }
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const content = await readFile(absolute);
    if (content.includes(0)) {
      excluded.push({ path: file, reason: "binary_nul" });
      continue;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/^\uFEFF/, "");
    } catch {
      excluded.push({ path: file, reason: "non_utf8" });
      continue;
    }
    catalog.push({
      path: file,
      bytes: content.byteLength,
      estimated_tokens: estimateTokens(text),
      tier: determineTier(file, { specPath, required, explicit }),
      mandatory: required.has(file),
      run_delta: runDelta.some((entry) => entry.path === file),
      sha256: createHash("sha256").update(content).digest("hex"),
      text,
    });
  }
  return {
    catalog,
    excluded,
    required_paths: [...required].sort(),
    run_delta: structuredClone(runDelta),
  };
}

export function selectRepositoryContext(catalogResult, { budgetTokens = INITIAL_CONTEXT_BUDGET } = {}) {
  return selectContextFiles(catalogResult.catalog, {
    budgetTokens,
    requiredPaths: catalogResult.required_paths,
  });
}

export function queryContextBudget(catalogResult) {
  const required = new Set(catalogResult.required_paths ?? []);
  const mandatoryTokens = catalogResult.catalog
    .filter((file) => required.has(file.path))
    .reduce((sum, file) => sum + file.estimated_tokens, 0);
  return Math.min(INITIAL_CONTEXT_BUDGET, mandatoryTokens + QUERY_ADDITIONAL_CONTEXT_BUDGET);
}

export function renderContextPack({ selected, omitted = [], excluded = [], estimated_tokens, budget_tokens, mandatory_tokens }, metadata = {}) {
  const manifest = {
    version: 2,
    completeness: omitted.length === 0 ? "FULL" : "PARTIAL",
    estimated_tokens,
    mandatory_tokens,
    budget_tokens,
    selected: selected.map(({ path: filePath, sha256, bytes, estimated_tokens: tokens, tier, mandatory, run_delta }) => ({
      path: filePath,
      sha256,
      bytes,
      estimated_tokens: tokens,
      tier,
      mandatory: mandatory === true,
      run_delta: run_delta === true,
    })),
    omitted,
    excluded,
    ...metadata,
  };
  const sections = selected.map(
    (file) => `\n<repository-file path=${JSON.stringify(file.path)} sha256=${JSON.stringify(file.sha256)}>\n${file.text}\n</repository-file>`,
  );
  return `<implement-with-kimi-context>\n${JSON.stringify(manifest, null, 2)}${sections.join("\n")}\n</implement-with-kimi-context>`;
}

export function captureRunBaseline(repoRoot) {
  const head = currentHead(repoRoot);
  const dirtyPaths = listChangedPaths(repoRoot).filter((file) => !file.endsWith(".state.md")).sort();
  return {
    head,
    dirty: dirtyPaths.map((file) => pathSnapshot(repoRoot, file)),
    full_fingerprint: repositoryFingerprint(repoRoot),
    captured_at: new Date().toISOString(),
  };
}

export function buildRunDelta(repoRoot, baseline) {
  const baselineDirty = new Map((baseline?.dirty ?? []).map((entry) => [entry.path, entry]));
  const candidates = new Set([
    ...listChangedPaths(repoRoot),
    ...baselineDirty.keys(),
    ...listCommittedDeltaPaths(repoRoot, baseline?.head),
  ]);
  const entries = [];
  for (const file of [...candidates].filter((item) => !item.endsWith(".state.md")).sort()) {
    const current = pathSnapshot(repoRoot, file);
    const previous = baselineDirty.get(file);
    if (previous && sameSnapshot(previous, current)) continue;
    entries.push({
      ...current,
      baseline_status: previous?.status ?? "CLEAN",
      baseline_sha256: previous?.sha256 ?? null,
    });
  }
  return entries;
}

export function runScopedFingerprint(repoRoot, baseline) {
  const delta = buildRunDelta(repoRoot, baseline);
  return createHash("sha256")
    .update(JSON.stringify({ baseline_head: baseline?.head ?? null, delta }))
    .digest("hex");
}

export function repositoryFingerprint(repoRoot) {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const diff = head.status === 0
    ? git(repoRoot, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", ".", ":(exclude)**/*.state.md"])
    : git(repoRoot, ["diff", "--cached", "--no-ext-diff", "--binary", "--", ".", ":(exclude)**/*.state.md"]);
  const unstaged = head.status === 0
    ? null
    : git(repoRoot, ["diff", "--no-ext-diff", "--binary", "--", ".", ":(exclude)**/*.state.md"]);
  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const hash = createHash("sha256");
  hash.update(head.status === 0 ? head.stdout.trim() : "NO_HEAD");
  hash.update("\0");
  hash.update(diff.stdout);
  if (unstaged) hash.update(unstaged.stdout);
  for (const file of splitNull(untracked.stdout).filter((item) => !item.endsWith(".state.md")).sort()) {
    hash.update(file);
    try {
      hash.update(readFileSync(path.join(repoRoot, file)));
    } catch {
      hash.update("UNREADABLE");
    }
  }
  return hash.digest("hex");
}

export function gitBaseline(repoRoot) {
  const result = git(repoRoot, ["status", "--short"]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to read Git status.");
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

export function extractSpecPaths(specText, specPath) {
  const base = path.posix.dirname(String(specPath || "").split(path.sep).join("/"));
  const result = new Set();
  const pattern = /\]\(([^)]+)\)/g;
  for (const match of String(specText || "").matchAll(pattern)) {
    addSpecReference(result, match[1], base);
  }
  for (const match of String(specText || "").matchAll(/`([^`\r\n]+)`/g)) {
    const raw = match[1].trim();
    if (/\s/.test(raw) || (!raw.includes("/") && !/\.[A-Za-z0-9_-]{1,12}$/.test(raw))) continue;
    addSpecReference(result, raw, base);
  }
  return [...result].sort();
}

function addSpecReference(result, value, base) {
  const raw = String(value || "").trim().replace(/^<|>$/g, "").split("#", 1)[0];
  if (!raw || path.posix.isAbsolute(raw) || /^(?:https?:|mailto:|#)/i.test(raw)) return;
  const normalized = path.posix.normalize(path.posix.join(base, raw));
  if (!normalized.startsWith("../") && normalized !== "..") result.add(normalized);
}

function listGitFiles(repoRoot) {
  const result = git(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to enumerate repository files.");
  return splitNull(result.stdout);
}

function listChangedPaths(repoRoot) {
  const commands = [
    git(repoRoot, ["diff", "--name-only", "-z"]),
    git(repoRoot, ["diff", "--cached", "--name-only", "-z"]),
    git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ];
  return [...new Set(commands.flatMap((result) => splitNull(result.stdout)))];
}

function listCommittedDeltaPaths(repoRoot, baselineHead) {
  const head = currentHead(repoRoot);
  if (!baselineHead || !head || baselineHead === head) return [];
  const valid = git(repoRoot, ["cat-file", "-e", `${baselineHead}^{commit}`]);
  if (valid.status !== 0) return [];
  const result = git(repoRoot, ["diff", "--name-only", "-z", baselineHead, head]);
  return result.status === 0 ? splitNull(result.stdout) : [];
}

function currentHead(repoRoot) {
  const result = git(repoRoot, ["rev-parse", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function pathSnapshot(repoRoot, file) {
  const normalized = file.split(path.sep).join("/");
  const absolute = path.join(repoRoot, normalized);
  let sha256 = null;
  let kind = "missing";
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const rootReal = realpathSync(repoRoot);
      const target = realpathSync(absolute);
      kind = target === rootReal || target.startsWith(`${rootReal}${path.sep}`) ? "symlink" : "external_symlink";
    } else if (stat.isFile()) {
      kind = "file";
    } else {
      kind = "other";
    }
    if (kind === "file" || kind === "symlink") {
      sha256 = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    }
  } catch {
    kind = "missing";
  }
  const statusResult = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", normalized]);
  return {
    path: normalized,
    status: statusResult.status === 0 && statusResult.stdout.trim() ? statusResult.stdout.trim() : "CLEAN",
    kind,
    sha256,
  };
}

function sameSnapshot(left, right) {
  return left.status === right.status && left.kind === right.kind && left.sha256 === right.sha256;
}

function determineTier(file, { specPath, required, explicit }) {
  if (required.has(file)) return 0;
  if (explicit.has(file)) return 1;
  const specDirectory = path.posix.dirname(String(specPath || ""));
  const specBase = path.posix.basename(String(specPath || ""), path.posix.extname(String(specPath || "")));
  const fileBase = path.posix.basename(file, path.posix.extname(file));
  if (path.posix.dirname(file) === specDirectory || (specBase && fileBase === specBase)) return 2;
  if (/(contract|schema|types?|api|interface)/i.test(file)) return 3;
  if (/(test|spec|__tests__)/i.test(file)) return 4;
  if (/(example|fixture|snapshot|benchmark|history)/i.test(file)) return 6;
  return 5;
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function splitNull(value) {
  return String(value || "").split("\0").filter(Boolean).map((item) => item.split(path.sep).join("/"));
}
