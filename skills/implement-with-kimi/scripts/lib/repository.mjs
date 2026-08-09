import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { estimateTokens, selectContextFiles } from "./context-pack.mjs";

export function getRepoRoot(cwd = process.cwd()) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) throw new Error("implement-with-kimi requires a Git worktree.");
  return result.stdout.trim();
}

export async function buildRepositoryCatalog(repoRoot, { specPath, authorityPaths = [] } = {}) {
  const files = listGitFiles(repoRoot);
  const changed = new Set(listChangedPaths(repoRoot));
  const required = new Set([specPath, ...authorityPaths, ...(files.includes("AGENTS.md") ? ["AGENTS.md"] : [])]);
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
      tier: determineTier(file, { specPath, authorityPaths, changed }),
      changed: changed.has(file),
      sha256: createHash("sha256").update(content).digest("hex"),
      text,
    });
  }
  return { catalog, excluded, required_paths: [...required] };
}

export function reconcileSelectorPaths(catalogResult, selectorPaths) {
  const knownPaths = new Set(catalogResult.catalog.map((file) => file.path));
  const managedStatePaths = new Set(
    catalogResult.excluded
      .filter((item) => item.reason === "managed_state")
      .map((item) => item.path),
  );
  const result = {
    selectedPaths: [],
    ignoredManagedStatePaths: [],
    unknownPaths: [],
  };

  for (const file of selectorPaths) {
    if (knownPaths.has(file)) result.selectedPaths.push(file);
    else if (managedStatePaths.has(file)) result.ignoredManagedStatePaths.push(file);
    else result.unknownPaths.push(file);
  }
  return result;
}

export function selectRepositoryContext(catalogResult, { budgetTokens = 650_000, selectorPaths = [] } = {}) {
  const required = new Set(catalogResult.required_paths);
  for (const selected of selectorPaths) required.add(selected);
  return selectContextFiles(catalogResult.catalog, { budgetTokens, requiredPaths: [...required] });
}

export function renderContextPack({ selected, omitted = [], excluded = [], estimated_tokens, budget_tokens }, metadata = {}) {
  const manifest = {
    version: 1,
    completeness: omitted.length === 0 ? "FULL" : "PARTIAL",
    estimated_tokens,
    budget_tokens,
    selected: selected.map(({ path: filePath, sha256, bytes, estimated_tokens: tokens, tier }) => ({
      path: filePath,
      sha256,
      bytes,
      estimated_tokens: tokens,
      tier,
    })),
    omitted,
    excluded,
    ...metadata,
  };
  const sections = selected.map((file) => `\n<repository-file path=${JSON.stringify(file.path)} sha256=${JSON.stringify(file.sha256)}>\n${file.text}\n</repository-file>`);
  return `<implement-with-kimi-context>\n${JSON.stringify(manifest, null, 2)}${sections.join("\n")}\n</implement-with-kimi-context>`;
}

export function renderSelectorContext(catalogResult, spec, budgetTokens) {
  const selectorCatalog = catalogResult.catalog.map(({
    path: file,
    sha256,
    bytes,
    estimated_tokens,
    tier,
    changed,
  }) => ({ path: file, sha256, bytes, estimated_tokens, tier, changed }));
  return [
    `<selector-budget tokens="${budgetTokens}">`,
    spec.text,
    JSON.stringify(selectorCatalog, null, 2),
    "</selector-budget>",
  ].join("\n");
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

function listGitFiles(repoRoot) {
  const result = git(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to enumerate repository files.");
  return splitNull(result.stdout);
}

function listChangedPaths(repoRoot) {
  const sets = [
    git(repoRoot, ["diff", "--name-only", "-z"]),
    git(repoRoot, ["diff", "--cached", "--name-only", "-z"]),
    git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ];
  return [...new Set(sets.flatMap((result) => splitNull(result.stdout)))];
}

function determineTier(file, { specPath, authorityPaths, changed }) {
  if (file === specPath) return 1;
  if (file === "AGENTS.md" || authorityPaths.includes(file)) return 2;
  if (changed.has(file)) return 3;
  if (/(contract|schema|types?|api|interface)/i.test(file)) return 4;
  if (/(test|spec|__tests__)/i.test(file)) return 5;
  if (/(example|fixture|snapshot|benchmark|history)/i.test(file)) return 6;
  return 5;
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function splitNull(value) {
  return String(value || "").split("\0").filter(Boolean).map((item) => item.split(path.sep).join("/"));
}
