import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

const SECTION_PATTERNS = {
  goal: /(^|\b)(goal|objective|目标|目的)(\b|$)/i,
  scope: /scope|范围/i,
  non_goals: /non[- ]?goals?|out of scope|非目标|不包含|范围外/i,
  dependencies: /dependenc|依赖/i,
  acceptance: /acceptance|验收/i,
  tests: /tests?|testing|测试/i,
  related_docs: /related|architecture|prd|架构|产品需求|关联文档|相关文档/i,
};

export async function loadAndValidateSpec(repoRoot, specPath, authorityPaths = []) {
  const root = await realpath(repoRoot);
  const absolute = path.resolve(root, specPath);
  const actual = await realpath(absolute);
  if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) throw new Error("Specification is outside the repository.");
  if (!actual.toLowerCase().endsWith(".md")) throw new Error("Specification must be Markdown.");
  const text = await readFile(actual, "utf8");
  const sections = parseSections(text);
  const missing = Object.entries(SECTION_PATTERNS)
    .filter(([name]) => !findSection(sections, name))
    .map(([name]) => name);
  const acceptanceBody = findSection(sections, "acceptance")?.body ?? "";
  const acIds = [...new Set(acceptanceBody.match(/\bAC-\d{3,}\b/g) ?? [])];
  if (acIds.length === 0) missing.push("stable AC ids such as AC-001");

  const specRelative = path.relative(root, actual).split(path.sep).join("/");
  const related = extractMarkdownPaths(findSection(sections, "related_docs")?.body ?? "").map((item) =>
    path.posix.normalize(path.posix.join(path.posix.dirname(specRelative), item)),
  );
  const authorities = [...new Set([...authorityPaths.map((item) => path.posix.normalize(item)), ...related])];
  if (authorities.length === 0 && !missing.includes("related_docs")) missing.push("related architecture/PRD paths");
  if (missing.length > 0) {
    const error = new Error(`Specification is incomplete; missing: ${missing.join(", ")}.`);
    error.kind = "SPEC_INVALID";
    error.missing = missing;
    throw error;
  }
  return {
    absolute_path: actual,
    relative_path: specRelative,
    text,
    sections,
    ac_ids: acIds,
    authority_paths: authorities,
  };
}

export function parseSections(markdown) {
  const headings = [];
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match) headings.push({ level: match[1].length, title: match[2], line: index });
  }
  return headings.map((heading, index) => {
    let end = lines.length;
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) {
        end = headings[next].line;
        break;
      }
    }
    return { ...heading, body: lines.slice(heading.line + 1, end).join("\n").trim() };
  });
}

function findSection(sections, name) {
  return sections.find((section) => SECTION_PATTERNS[name].test(section.title) && section.body.length > 0);
}

function extractMarkdownPaths(text) {
  const paths = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)#?]+\.md)\)/gi)) paths.push(match[1]);
  for (const match of text.matchAll(/`([^`]+\.md)`/gi)) paths.push(match[1]);
  return paths;
}
