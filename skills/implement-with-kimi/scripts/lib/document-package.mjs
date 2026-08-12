import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { loadAndValidateSpec } from "./spec.mjs";

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
  const manifest = packageFile ? parseJson(packageFile.text, packageFile.relative, issues) : null;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new PackageValidationError(issues.length > 0 ? issues : ["package: expected a JSON object"]);
  }

  if (manifest.schema_version !== 1) issues.push("schema_version: expected 1");
  if (typeof manifest.project !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.project)) {
    issues.push("project: expected a lowercase hyphen-case name");
  }
  if (!["greenfield", "existing-project"].includes(manifest.mode)) issues.push("mode: expected greenfield or existing-project");
  if (manifest.status !== "approved") issues.push("status: expected approved before implementation");
  validateApprovals(manifest, issues);

  const documents = manifest.documents && typeof manifest.documents === "object" ? manifest.documents : {};
  const authorityFile = await readMarkdown(root, documents.authority, "documents.authority", issues);
  const prdFile = await readMarkdown(root, documents.prd, "documents.prd", issues);
  const architectureFile = await readMarkdown(root, documents.architecture, "documents.architecture", issues);
  const uiResult = await validateUi(root, manifest.ui, manifest.approvals, issues);
  const authorities = unique([
    packageFile?.relative,
    authorityFile?.relative,
    prdFile?.relative,
    architectureFile?.relative,
    uiResult.specFile?.relative,
  ].filter(Boolean));

  const requirementIds = ids(prdFile?.text, /\b(?:REQ|NFR)-\d{3,}\b/g);
  const adrIds = ids(architectureFile?.text, /\bADR-\d{3,}\b/g);
  if (![...requirementIds].some((id) => id.startsWith("REQ-"))) issues.push("PRD: expected at least one REQ-### id");
  if (adrIds.size === 0) issues.push("architecture: expected at least one ADR-### id");

  const modules = await validateModules(root, manifest.modules, authorities, issues);
  validateTraceability(manifest.traceability, { requirementIds, adrIds, modules, issues });

  let selected = null;
  if (specPath) {
    const normalized = normalizeRepoPath(specPath, "--spec", issues);
    selected = modules.find((module) => module.spec === normalized) ?? null;
    if (normalized && !selected) issues.push(`--spec: ${normalized} is not an approved module in the package`);
  }
  if (issues.length > 0) throw new PackageValidationError(unique(issues));

  const selectedModules = selected ? [selected] : modules;
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
    bootstrap_commands: selectedModules.flatMap((module) => ["kimi", "claude-code"].map((reviewer) => ({
      module_id: module.id,
      spec: module.spec,
      reviewer,
      command: renderBootstrapCommand(module.spec, authorities, reviewer),
    }))),
  };
}

async function validateUi(root, ui, approvals, issues) {
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
    issues.push("ui: expected an object");
    return { specFile: null };
  }
  if (!["approved", "not-applicable"].includes(ui.status)) issues.push("ui.status: expected approved or not-applicable");
  if (approvals?.ui?.status !== ui.status) issues.push("approvals.ui.status: must match ui.status");
  if (ui.status === "not-applicable") {
    if (ui.spec !== null || ui.design_root !== null || ui.design_meta !== null) {
      issues.push("ui: not-applicable requires null spec, design_root, and design_meta");
    }
    if (!Array.isArray(ui.approved_assets) || ui.approved_assets.length !== 0) {
      issues.push("ui.approved_assets: not-applicable requires an empty array");
    }
    return { specFile: null };
  }

  const specFile = await readMarkdown(root, ui.spec, "ui.spec", issues);
  const designRoot = normalizeRepoPath(ui.design_root, "ui.design_root", issues);
  const metaFile = await readRepoFile(root, ui.design_meta, "ui.design_meta", issues);
  if (designRoot && metaFile && (path.posix.dirname(metaFile.relative) !== designRoot || path.posix.basename(metaFile.relative) !== "_d_meta.json")) {
    issues.push("ui.design_meta: expected _d_meta.json directly inside ui.design_root");
  }
  const meta = metaFile ? parseJson(metaFile.text, metaFile.relative, issues) : null;
  if (!Array.isArray(ui.approved_assets) || ui.approved_assets.length === 0) {
    issues.push("ui.approved_assets: expected at least one approved HTML asset");
  } else if (designRoot && meta) {
    const approved = new Set(
      Object.values(meta.assets ?? {}).flatMap((asset) => Array.isArray(asset?.versions) ? asset.versions : [])
        .filter((version) => version?.status === "approved" && typeof version.path === "string")
        .map((version) => normalizeAssetPath(version.path)),
    );
    for (const asset of ui.approved_assets) {
      const normalized = normalizeAssetPath(asset);
      if (!normalized || !normalized.toLowerCase().endsWith(".html")) {
        issues.push(`ui.approved_assets: expected an HTML path, received ${String(asset)}`);
        continue;
      }
      if (!approved.has(normalized)) issues.push(`ui.approved_assets: ${normalized} is not approved in _d_meta.json`);
      await readRepoFile(root, path.posix.join(designRoot, normalized), `ui asset ${normalized}`, issues);
    }
  }
  return { specFile };
}

async function validateModules(root, rawModules, authorities, issues) {
  if (!Array.isArray(rawModules) || rawModules.length === 0) {
    issues.push("modules: expected at least one module");
    return [];
  }
  const modules = [];
  const seenIds = new Set();
  const seenSpecs = new Set();
  for (const [index, raw] of rawModules.entries()) {
    const label = `modules[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(`${label}: expected an object`);
      continue;
    }
    if (typeof raw.id !== "string" || !/^MOD-\d{3,}$/.test(raw.id)) issues.push(`${label}.id: expected MOD-###`);
    else if (seenIds.has(raw.id)) issues.push(`${label}.id: duplicate ${raw.id}`);
    else seenIds.add(raw.id);
    if (typeof raw.name !== "string" || raw.name.trim() === "") issues.push(`${label}.name: expected a non-empty name`);
    if (raw.status !== "approved") issues.push(`${label}.status: expected approved`);
    if (!Array.isArray(raw.depends_on)) issues.push(`${label}.depends_on: expected an array`);
    const normalizedSpec = normalizeRepoPath(raw.spec, `${label}.spec`, issues);
    if (normalizedSpec && seenSpecs.has(normalizedSpec)) issues.push(`${label}.spec: duplicate ${normalizedSpec}`);
    if (normalizedSpec) seenSpecs.add(normalizedSpec);
    let loaded = null;
    if (normalizedSpec) {
      try {
        loaded = await loadAndValidateSpec(root, normalizedSpec);
      } catch (error) {
        issues.push(`${label}.spec: ${error.message}`);
      }
    }
    if (loaded) {
      for (const authority of authorities) {
        if (!loaded.authority_paths.includes(authority)) issues.push(`${label}.spec: Related documents must link ${authority}`);
      }
    }
    modules.push({
      id: raw.id,
      name: raw.name,
      spec: loaded?.relative_path ?? normalizedSpec,
      depends_on: Array.isArray(raw.depends_on) ? raw.depends_on : [],
      acIds: new Set(loaded?.ac_ids ?? []),
    });
  }
  const known = new Set(modules.map((module) => module.id));
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

function validateTraceability(traceability, { requirementIds, adrIds, modules, issues }) {
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
    if (!stringArray(row.architecture_refs)) issues.push(`${label}.architecture_refs: expected at least one ADR-### reference`);
    else for (const ref of row.architecture_refs) if (!adrIds.has(ref)) issues.push(`${label}.architecture_refs: unknown ${ref}`);
    if (!stringArray(row.module_ids)) issues.push(`${label}.module_ids: expected at least one module`);
    else for (const id of row.module_ids) if (!modulesById.has(id)) issues.push(`${label}.module_ids: unknown ${id}`);
    if (!stringArray(row.acceptance_criteria)) {
      issues.push(`${label}.acceptance_criteria: expected at least one MOD-###:AC-### reference`);
    } else {
      for (const ref of row.acceptance_criteria) {
        const match = ref.match(/^(MOD-\d{3,}):(AC-\d{3,})$/);
        if (!match || !modulesById.get(match[1])?.acIds.has(match[2])) issues.push(`${label}.acceptance_criteria: unknown ${ref}`);
        else mappedAcceptance.add(ref);
      }
    }
    if (!stringArray(row.test_requirements)) issues.push(`${label}.test_requirements: expected at least one planned test`);
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
    if (!(await stat(actual)).isFile()) {
      issues.push(`${label}: expected a file at ${relative}`);
      return null;
    }
    return { relative, absolute: actual, text: await readFile(actual, "utf8") };
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
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    issues.push(`${label}: path must stay inside the repository`);
    return null;
  }
  return normalized;
}

function normalizeAssetPath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
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

function ids(text, pattern) {
  return new Set(String(text || "").match(pattern) ?? []);
}

function stringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim() !== "");
}

function renderBootstrapCommand(spec, authorities, reviewer) {
  const args = [
    "node",
    "<skill-directory>/scripts/kimi_context.mjs",
    "bootstrap",
    "--spec",
    spec,
    "--reviewer",
    reviewer,
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
