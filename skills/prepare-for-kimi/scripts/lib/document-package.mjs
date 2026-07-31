import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const ID_PATTERNS = {
  requirement: /\b(?:REQ|NFR)-\d{3,}\b/g,
  functional: /\bREQ-\d{3,}\b/g,
  nfr: /\bNFR-\d{3,}\b/g,
  flow: /\bFLOW-\d{3,}\b/g,
  ui: /\bUI-\d{3,}\b/g,
  adr: /\bADR-\d{3,}\b/g,
  module: /^MOD-\d{3,}$/,
  acceptance: /\bAC-\d{3,}\b/g,
};

const SECTION_CONTRACTS = {
  authority: [
    ["document status", /status|状态/i],
    ["document map", /document map|文档映射|文档地图/i],
    ["authority ownership", /authority|ownership|权威|归属|职责/i],
    ["conflict policy", /conflict|冲突/i],
    ["change invalidation", /invalidation|变更失效|失效规则/i],
  ],
  prd: [
    ["document status", /status|状态/i],
    ["product summary", /summary|概述|简介/i],
    ["goals", /goals?|目标/i],
    ["non-goals", /non[- ]?goals?|非目标|范围外/i],
    ["users", /users?|用户/i],
    ["scope", /scope|范围/i],
    ["functional requirements", /functional requirements?|功能需求/i],
    ["non-functional requirements", /non[- ]?functional|非功能/i],
    ["user flows", /user flows?|用户流程/i],
    ["product acceptance", /acceptance|验收/i],
  ],
  architecture: [
    ["document status", /status|状态/i],
    ["context", /context|背景|上下文/i],
    ["constraints", /constraints?|约束/i],
    ["components", /components?|组件/i],
    ["data", /data|数据/i],
    ["interfaces", /interfaces?|接口|协议/i],
    ["security and privacy", /security|privacy|安全|隐私/i],
    ["reliability and observability", /reliability|observability|可靠性|可观测/i],
    ["testing strategy", /testing|tests?|测试/i],
    ["decisions", /decisions?|ADR|决策/i],
  ],
  ui: [
    ["document status", /status|状态/i],
    ["approved design source", /design source|设计来源|设计源/i],
    ["screens", /screens?|页面|界面/i],
    ["states", /states?|状态/i],
    ["interactions", /interactions?|交互/i],
    ["responsive behavior", /responsive|响应式|适配/i],
    ["accessibility", /accessibility|无障碍|可访问/i],
    ["traceability", /traceability|追踪|追溯/i],
  ],
  module: [
    ["goal", /goal|objective|目标|目的/i],
    ["scope", /scope|范围/i],
    ["non-goals", /non[- ]?goals?|out of scope|非目标|不包含|范围外/i],
    ["dependencies", /dependenc|依赖/i],
    ["acceptance criteria", /acceptance|验收/i],
    ["test requirements", /tests?|testing|测试/i],
    ["related documents", /related|architecture|prd|架构|产品需求|关联文档|相关文档/i],
  ],
};

export class PackageValidationError extends Error {
  constructor(issues) {
    super(`Implementation package is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}).`);
    this.name = "PackageValidationError";
    this.kind = "PACKAGE_INVALID";
    this.issues = issues;
  }
}

export async function validateImplementationPackage(repoRoot, packagePath, { specPath = null } = {}) {
  const root = await realpath(repoRoot);
  const issues = [];
  const packageFile = await readRepoFile(root, packagePath, "package", issues);
  let manifest = null;
  if (packageFile) manifest = parseJson(packageFile.text, packageFile.relative, issues);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new PackageValidationError(issues.length > 0 ? issues : ["package: expected a JSON object"]);
  }

  validateManifestHeader(manifest, issues);
  const documents = manifest.documents && typeof manifest.documents === "object" ? manifest.documents : {};
  const authorityFile = await readMarkdown(root, documents.authority, "documents.authority", issues);
  const prdFile = await readMarkdown(root, documents.prd, "documents.prd", issues);
  const architectureFile = await readMarkdown(root, documents.architecture, "documents.architecture", issues);

  const authoritySections = validateSections(authorityFile, "authority", issues);
  const prdSections = validateSections(prdFile, "prd", issues);
  const architectureSections = validateSections(architectureFile, "architecture", issues);
  validateApprovedStatus(authoritySections, "authority", issues);
  validateApprovedStatus(prdSections, "PRD", issues);
  validateApprovedStatus(architectureSections, "architecture", issues);

  const requirementIds = extractIds(prdFile?.text, ID_PATTERNS.requirement);
  const functionalIds = extractIds(prdFile?.text, ID_PATTERNS.functional);
  const nfrIds = extractIds(prdFile?.text, ID_PATTERNS.nfr);
  const prdFlowIds = extractIds(prdFile?.text, ID_PATTERNS.flow);
  const adrIds = extractIds(architectureFile?.text, ID_PATTERNS.adr);
  if (functionalIds.size === 0) issues.push("PRD: expected at least one stable REQ-### id");
  if (nfrIds.size === 0 && !hasExplicitNone(findSection(prdSections, /non[- ]?functional|非功能/i)?.body)) {
    issues.push("PRD: expected at least one NFR-### id or an explicit not-applicable statement");
  }
  if (adrIds.size === 0) issues.push("architecture: expected at least one stable ADR-### id");

  const uiResult = await validateUi(root, manifest.ui, manifest.approvals, issues);
  const allFlowIds = new Set([...prdFlowIds, ...uiResult.flowIds]);
  const uiIds = uiResult.uiIds;

  const authorities = unique([
    packageFile?.relative,
    authorityFile?.relative,
    prdFile?.relative,
    architectureFile?.relative,
    uiResult.specFile?.relative,
  ].filter(Boolean));

  const modules = await validateModules(root, manifest.modules, authorities, issues);
  validateApprovals(manifest, issues);
  validateTraceability({
    traceability: manifest.traceability,
    requirementIds,
    allFlowIds,
    uiIds,
    adrIds,
    modules,
    uiStatus: manifest.ui?.status,
    issues,
  });

  let selectedSpec = null;
  if (specPath) {
    const normalized = normalizeRepoPath(specPath, "--spec", issues);
    selectedSpec = modules.find((item) => item.spec === normalized) ?? null;
    if (normalized && !selectedSpec) issues.push(`--spec: ${normalized} is not an approved module in the package`);
  }

  if (issues.length > 0) throw new PackageValidationError(unique(issues));

  const selectedModules = selectedSpec ? [selectedSpec] : modules;
  const bootstrapCommands = selectedModules.map((module) => ({
    module_id: module.id,
    spec: module.spec,
    command: renderBootstrapCommand(module.spec, authorities),
  }));
  const recommended = modules.find((module) => module.depends_on.length === 0) ?? modules[0];
  return {
    schema_version: 1,
    status: "READY",
    package_path: packageFile.relative,
    project: manifest.project,
    mode: manifest.mode,
    authority_paths: authorities,
    module_specs: modules.map(({ id, name, spec, depends_on }) => ({ id, name, spec, depends_on })),
    recommended_module: recommended?.id ?? null,
    bootstrap_commands: bootstrapCommands,
    traceability: {
      requirements: requirementIds.size,
      modules: modules.length,
      acceptance_criteria: modules.reduce((sum, module) => sum + module.acIds.size, 0),
    },
  };
}

function validateManifestHeader(manifest, issues) {
  if (manifest.schema_version !== 1) issues.push("schema_version: expected 1");
  if (typeof manifest.project !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.project)) {
    issues.push("project: expected a lowercase hyphen-case name");
  }
  if (!["greenfield", "existing-project"].includes(manifest.mode)) {
    issues.push("mode: expected greenfield or existing-project");
  }
  if (manifest.status !== "approved") issues.push("status: expected approved before handoff");
  if (!manifest.documents || typeof manifest.documents !== "object" || Array.isArray(manifest.documents)) {
    issues.push("documents: expected an object");
  }
}

async function validateUi(root, ui, approvals, issues) {
  const empty = { specFile: null, flowIds: new Set(), uiIds: new Set() };
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
    issues.push("ui: expected an object");
    return empty;
  }
  if (!["approved", "not-applicable"].includes(ui.status)) {
    issues.push("ui.status: expected approved or not-applicable");
    return empty;
  }
  if (approvals?.ui?.status !== ui.status) issues.push("approvals.ui.status: must match ui.status");
  if (ui.status === "not-applicable") {
    if (ui.spec !== null || ui.design_root !== null || ui.design_meta !== null) {
      issues.push("ui: not-applicable requires spec, design_root, and design_meta to be null");
    }
    if (!Array.isArray(ui.approved_assets) || ui.approved_assets.length !== 0) {
      issues.push("ui.approved_assets: not-applicable requires an empty array");
    }
    return empty;
  }

  const specFile = await readMarkdown(root, ui.spec, "ui.spec", issues);
  const sections = validateSections(specFile, "ui", issues);
  validateApprovedStatus(sections, "UI specification", issues);
  const flowIds = extractIds(specFile?.text, ID_PATTERNS.flow);
  const uiIds = extractIds(specFile?.text, ID_PATTERNS.ui);
  if (flowIds.size === 0) issues.push("UI specification: expected at least one FLOW-### id");
  if (uiIds.size === 0) issues.push("UI specification: expected at least one UI-### id");

  const designRoot = normalizeRepoPath(ui.design_root, "ui.design_root", issues);
  const designMeta = await readRepoFile(root, ui.design_meta, "ui.design_meta", issues);
  if (designRoot && designMeta && path.posix.dirname(designMeta.relative) !== designRoot) {
    issues.push("ui.design_meta: expected _d_meta.json directly inside ui.design_root");
  }
  if (designMeta && path.posix.basename(designMeta.relative) !== "_d_meta.json") {
    issues.push("ui.design_meta: expected a _d_meta.json file");
  }
  const meta = designMeta ? parseJson(designMeta.text, designMeta.relative, issues) : null;
  if (!Array.isArray(ui.approved_assets) || ui.approved_assets.length === 0) {
    issues.push("ui.approved_assets: expected at least one approved HTML entry point");
  } else if (designRoot && meta) {
    const approvedVersions = new Set(
      Object.values(meta.assets ?? {}).flatMap((asset) => Array.isArray(asset?.versions) ? asset.versions : [])
        .filter((version) => version?.status === "approved" && typeof version.path === "string")
        .map((version) => normalizeAssetPath(version.path)),
    );
    for (const asset of ui.approved_assets) {
      const normalizedAsset = normalizeAssetPath(asset);
      if (!normalizedAsset || !normalizedAsset.toLowerCase().endsWith(".html")) {
        issues.push(`ui.approved_assets: expected an HTML path, received ${String(asset)}`);
        continue;
      }
      if (!approvedVersions.has(normalizedAsset)) {
        issues.push(`ui.approved_assets: ${normalizedAsset} is not approved in _d_meta.json`);
      }
      await readRepoFile(root, path.posix.join(designRoot, normalizedAsset), `ui asset ${normalizedAsset}`, issues);
    }
  }
  return { specFile, flowIds, uiIds };
}

async function validateModules(root, rawModules, authorities, issues) {
  if (!Array.isArray(rawModules) || rawModules.length === 0) {
    issues.push("modules: expected at least one module");
    return [];
  }
  const modules = [];
  const ids = new Set();
  const specs = new Set();
  for (const [index, raw] of rawModules.entries()) {
    const label = `modules[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(`${label}: expected an object`);
      continue;
    }
    if (typeof raw.id !== "string" || !ID_PATTERNS.module.test(raw.id)) issues.push(`${label}.id: expected MOD-###`);
    else if (ids.has(raw.id)) issues.push(`${label}.id: duplicate ${raw.id}`);
    else ids.add(raw.id);
    if (typeof raw.name !== "string" || raw.name.trim() === "") issues.push(`${label}.name: expected a non-empty name`);
    if (raw.status !== "approved") issues.push(`${label}.status: expected approved`);
    if (!Array.isArray(raw.depends_on)) issues.push(`${label}.depends_on: expected an array`);
    const specFile = await readMarkdown(root, raw.spec, `${label}.spec`, issues);
    if (specFile && specs.has(specFile.relative)) issues.push(`${label}.spec: duplicate ${specFile.relative}`);
    if (specFile) specs.add(specFile.relative);
    const sections = validateSections(specFile, "module", issues);
    const acIds = extractIds(findSection(sections, /acceptance|验收/i)?.body, ID_PATTERNS.acceptance);
    if (acIds.size === 0) issues.push(`${label}.spec: expected at least one stable AC-### id in acceptance criteria`);
    const related = extractRelatedPaths(findSection(sections, /related|architecture|prd|架构|产品需求|关联文档|相关文档/i)?.body, specFile?.relative);
    for (const authority of authorities) {
      if (!related.has(authority)) issues.push(`${label}.spec: Related documents must link ${authority}`);
    }
    modules.push({
      id: raw.id,
      name: raw.name,
      spec: specFile?.relative ?? normalizeRepoPath(raw.spec, `${label}.spec`, issues),
      status: raw.status,
      depends_on: Array.isArray(raw.depends_on) ? raw.depends_on : [],
      acIds,
    });
  }
  const known = new Set(modules.map((item) => item.id));
  for (const module of modules) {
    for (const dependency of module.depends_on) {
      if (!known.has(dependency)) issues.push(`${module.id}.depends_on: unknown module ${dependency}`);
      if (dependency === module.id) issues.push(`${module.id}.depends_on: a module cannot depend on itself`);
    }
  }
  return modules;
}

function validateApprovals(manifest, issues) {
  if (!manifest.approvals || typeof manifest.approvals !== "object" || Array.isArray(manifest.approvals)) {
    issues.push("approvals: expected an object");
    return;
  }
  for (const name of ["requirements", "architecture", "implementation"]) {
    if (manifest.approvals[name]?.status !== "approved") issues.push(`approvals.${name}.status: expected approved`);
  }
}

function validateTraceability({ traceability, requirementIds, allFlowIds, uiIds, adrIds, modules, uiStatus, issues }) {
  if (!Array.isArray(traceability) || traceability.length === 0) {
    issues.push("traceability: expected at least one mapping row");
    return;
  }
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  const mappedRequirements = new Set();
  const mappedAcceptance = new Set();
  for (const [index, row] of traceability.entries()) {
    const label = `traceability[${index}]`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      issues.push(`${label}: expected an object`);
      continue;
    }
    if (!requirementIds.has(row.requirement_id)) issues.push(`${label}.requirement_id: unknown ${String(row.requirement_id)}`);
    else if (mappedRequirements.has(row.requirement_id)) issues.push(`${label}.requirement_id: duplicate ${row.requirement_id}`);
    else mappedRequirements.add(row.requirement_id);
    validateKnownIds(row.flow_ids, allFlowIds, `${label}.flow_ids`, issues);
    validateKnownIds(row.ui_ids, uiIds, `${label}.ui_ids`, issues);
    if (uiStatus === "not-applicable" && (row.ui_ids?.length ?? 0) > 0) issues.push(`${label}.ui_ids: UI is not-applicable`);
    if (!nonEmptyStringArray(row.architecture_refs)) issues.push(`${label}.architecture_refs: expected at least one ADR-### reference`);
    else for (const ref of row.architecture_refs) if (!adrIds.has(ref)) issues.push(`${label}.architecture_refs: unknown ${ref}`);
    if (!nonEmptyStringArray(row.module_ids)) issues.push(`${label}.module_ids: expected at least one module`);
    else for (const id of row.module_ids) if (!modulesById.has(id)) issues.push(`${label}.module_ids: unknown ${id}`);
    if (!nonEmptyStringArray(row.acceptance_criteria)) {
      issues.push(`${label}.acceptance_criteria: expected at least one MOD-###:AC-### reference`);
    } else {
      for (const ref of row.acceptance_criteria) {
        const match = ref.match(/^(MOD-\d{3,}):(AC-\d{3,})$/);
        if (!match || !modulesById.get(match[1])?.acIds.has(match[2])) issues.push(`${label}.acceptance_criteria: unknown ${ref}`);
        else mappedAcceptance.add(ref);
      }
    }
    if (!nonEmptyStringArray(row.test_requirements)) issues.push(`${label}.test_requirements: expected at least one planned test`);
  }
  for (const id of requirementIds) if (!mappedRequirements.has(id)) issues.push(`traceability: missing requirement ${id}`);
  for (const module of modules) {
    for (const acId of module.acIds) {
      const qualified = `${module.id}:${acId}`;
      if (!mappedAcceptance.has(qualified)) issues.push(`traceability: missing acceptance criterion ${qualified}`);
    }
  }
}

async function readMarkdown(root, repoPath, label, issues) {
  const file = await readRepoFile(root, repoPath, label, issues);
  if (file && !file.relative.toLowerCase().endsWith(".md")) issues.push(`${label}: expected a Markdown file`);
  return file;
}

async function readRepoFile(root, repoPath, label, issues) {
  const relative = normalizeRepoPath(repoPath, label, issues);
  if (!relative) return null;
  const absolute = path.resolve(root, ...relative.split("/"));
  try {
    const actual = await realpath(absolute);
    if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) {
      issues.push(`${label}: path resolves outside the repository`);
      return null;
    }
    const info = await stat(actual);
    if (!info.isFile()) {
      issues.push(`${label}: expected a file at ${relative}`);
      return null;
    }
    return { absolute: actual, relative, text: await readFile(actual, "utf8") };
  } catch (error) {
    issues.push(`${label}: cannot read ${relative}: ${error.code ?? error.message}`);
    return null;
  }
}

function normalizeRepoPath(value, label, issues) {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${label}: expected a repository-relative path`);
    return null;
  }
  const portable = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(portable);
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized === ".") {
    issues.push(`${label}: path must stay inside the repository`);
    return null;
  }
  return normalized;
}

function normalizeAssetPath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized === ".") return null;
  return normalized;
}

function parseJson(text, label, issues) {
  try {
    return JSON.parse(text);
  } catch (error) {
    issues.push(`${label}: invalid JSON: ${error.message}`);
    return null;
  }
}

function validateSections(file, contractName, issues) {
  if (!file) return [];
  const sections = parseSections(file.text);
  for (const [label, pattern] of SECTION_CONTRACTS[contractName]) {
    if (!findSection(sections, pattern)) issues.push(`${file.relative}: missing non-empty ${label} section`);
  }
  return sections;
}

function validateApprovedStatus(sections, label, issues) {
  const body = findSection(sections, /status|状态/i)?.body ?? "";
  if (!/approved|已批准|已确认|确认通过/i.test(body)) issues.push(`${label}: document status must be approved`);
}

function parseSections(markdown) {
  const headings = [];
  const lines = String(markdown || "").split(/\r?\n/);
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

function findSection(sections, pattern) {
  return sections.find((section) => pattern.test(section.title) && section.body.length > 0);
}

function extractIds(text, pattern) {
  return new Set(String(text || "").match(pattern) ?? []);
}

function extractRelatedPaths(text, specPath) {
  const result = new Set();
  if (!specPath) return result;
  const base = path.posix.dirname(specPath);
  const add = (value) => {
    const cleaned = value.trim().replaceAll("\\", "/");
    if (path.posix.isAbsolute(cleaned)) return;
    const normalized = path.posix.normalize(path.posix.join(base, cleaned));
    if (normalized === ".." || normalized.startsWith("../")) return;
    result.add(normalized);
  };
  for (const match of String(text || "").matchAll(/\[[^\]]*\]\(([^)#?]+\.(?:md|json))\)/gi)) add(match[1]);
  for (const match of String(text || "").matchAll(/`([^`]+\.(?:md|json))`/gi)) add(match[1]);
  return result;
}

function validateKnownIds(values, known, label, issues) {
  if (!Array.isArray(values)) {
    issues.push(`${label}: expected an array`);
    return;
  }
  for (const value of values) if (!known.has(value)) issues.push(`${label}: unknown ${String(value)}`);
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim() !== "");
}

function hasExplicitNone(value) {
  return /\bnone\b|not applicable|n\/a|无|不适用/i.test(String(value || ""));
}

function renderBootstrapCommand(spec, authorities) {
  const args = [
    "node",
    "<implement-with-kimi-directory>/scripts/kimi_context.mjs",
    "bootstrap",
    "--spec",
    spec,
    ...authorities.flatMap((authority) => ["--authority", authority]),
    "--goal",
    "none",
  ];
  return args.map(shellQuote).join(" ");
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function unique(values) {
  return [...new Set(values)];
}
