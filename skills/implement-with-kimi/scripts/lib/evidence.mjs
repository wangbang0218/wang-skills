import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export async function validateLocalEvidence(repoRoot, evidence) {
  validateEvidenceShape(evidence);
  const relative = normalizeRelativePath(evidence.path);
  const rootReal = await realpath(repoRoot);
  const candidate = path.resolve(rootReal, relative);
  const stat = await lstat(candidate);
  const candidateReal = await realpath(candidate);
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`Evidence path resolves outside the repository through a symlink: ${evidence.path}`);
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Evidence path is not a file: ${evidence.path}`);

  const actualHash = await sha256File(candidateReal);
  if (actualHash !== evidence.sha256) throw new Error(`Evidence sha256 mismatch for ${evidence.path}.`);

  const text = await readFile(candidateReal, "utf8");
  const lines = text.split(/\r?\n/);
  const validRange = evidence.line_start >= 1 && evidence.line_end >= evidence.line_start && evidence.line_end <= lines.length;
  const actualExcerpt = validRange ? lines.slice(evidence.line_start - 1, evidence.line_end).join("\n") : null;
  if (actualExcerpt !== evidence.excerpt) {
    normalizeUniqueExcerptRange(lines, evidence);
  }
  return { valid: true, path: relative, sha256: actualHash };
}

function normalizeUniqueExcerptRange(lines, evidence) {
  const excerptLines = evidence.excerpt.split("\n");
  const matches = [];
  for (let index = 0; index + excerptLines.length <= lines.length; index += 1) {
    if (lines.slice(index, index + excerptLines.length).join("\n") === evidence.excerpt) matches.push(index);
  }
  if (matches.length !== 1) throw new Error(`Evidence excerpt mismatch for ${evidence.path}.`);
  const original = { line_start: evidence.line_start, line_end: evidence.line_end };
  evidence.line_start = matches[0] + 1;
  evidence.line_end = evidence.line_start + excerptLines.length - 1;
  evidence.normalized_range = { ...original, reason: "unique_exact_excerpt" };
}

export function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value) throw new Error("Evidence path is required.");
  if (path.isAbsolute(value)) throw new Error("Evidence path must be repository-relative.");
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Evidence path is outside the repository.");
  }
  return normalized.split(path.sep).join("/");
}

function validateEvidenceShape(evidence) {
  if (!evidence || typeof evidence !== "object") throw new Error("Evidence must be an object.");
  if (!/^[a-f0-9]{64}$/.test(evidence.sha256 ?? "")) throw new Error("Evidence sha256 must be lowercase hex.");
  if (!Number.isInteger(evidence.line_start) || !Number.isInteger(evidence.line_end)) {
    throw new Error("Evidence line range must use integers.");
  }
  if (typeof evidence.excerpt !== "string" || !evidence.excerpt || typeof evidence.claim !== "string" || !evidence.claim) {
    throw new Error("Evidence excerpt and claim are required non-empty strings.");
  }
}
