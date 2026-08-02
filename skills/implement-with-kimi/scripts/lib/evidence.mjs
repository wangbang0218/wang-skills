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
    if (validRange && hasNonIndentationContent(evidence.excerpt) && hasEquivalentLeadingWhitespace(actualExcerpt, evidence.excerpt)) {
      normalizeExcerpt(evidence, actualExcerpt);
    } else {
      normalizeUniqueExcerpt(lines, evidence);
    }
  }
  return { valid: true, path: relative, sha256: actualHash };
}

function normalizeUniqueExcerpt(lines, evidence) {
  const excerptLines = evidence.excerpt.split("\n");
  const exactMatches = [];
  for (let index = 0; index + excerptLines.length <= lines.length; index += 1) {
    if (lines.slice(index, index + excerptLines.length).join("\n") === evidence.excerpt) exactMatches.push(index);
  }
  if (exactMatches.length === 1) {
    normalizeRange(evidence, exactMatches[0], excerptLines.length, "unique_exact_excerpt");
    return;
  }

  const indentationMatches = [];
  if (hasNonIndentationContent(evidence.excerpt)) {
    for (let index = 0; index + excerptLines.length <= lines.length; index += 1) {
      const sourceExcerpt = lines.slice(index, index + excerptLines.length).join("\n");
      if (hasEquivalentLeadingWhitespace(sourceExcerpt, evidence.excerpt)) indentationMatches.push(index);
    }
  }
  if (indentationMatches.length !== 1) throw new Error(`Evidence excerpt mismatch for ${evidence.path}.`);
  const index = indentationMatches[0];
  const sourceExcerpt = lines.slice(index, index + excerptLines.length).join("\n");
  normalizeRange(evidence, index, excerptLines.length, "unique_source_excerpt");
  normalizeExcerpt(evidence, sourceExcerpt);
}

function normalizeRange(evidence, zeroBasedStart, lineCount, reason) {
  const original = { line_start: evidence.line_start, line_end: evidence.line_end };
  evidence.line_start = zeroBasedStart + 1;
  evidence.line_end = evidence.line_start + lineCount - 1;
  evidence.normalized_range = { ...original, reason };
}

function normalizeExcerpt(evidence, sourceExcerpt) {
  const original = evidence.excerpt;
  evidence.excerpt = sourceExcerpt;
  evidence.normalized_excerpt = { original, reason: "source_leading_whitespace" };
}

function hasEquivalentLeadingWhitespace(left, right) {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  return leftLines.length === rightLines.length
    && leftLines.every((line, index) => stripLeadingWhitespace(line) === stripLeadingWhitespace(rightLines[index]));
}

function stripLeadingWhitespace(value) {
  return value.split("\n").map((line) => line.replace(/^[\t ]*/, "")).join("\n");
}

function hasNonIndentationContent(value) {
  return stripLeadingWhitespace(value).split("\n").some(Boolean);
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
