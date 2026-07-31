import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PackageValidationError, validateImplementationPackage } from "../lib/document-package.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const templatesDirectory = path.resolve(testsDirectory, "../../assets/templates");
const cli = path.resolve(testsDirectory, "../validate_package.mjs");

test("the bundled templates become a valid implementation package after explicit approval", async () => {
  const root = await fixture();
  const result = await validateImplementationPackage(root, "docs/project/implementation-package.json");
  assert.equal(result.status, "READY");
  assert.equal(result.recommended_module, "MOD-001");
  assert.deepEqual(result.authority_paths, [
    "docs/project/implementation-package.json",
    "docs/project/authority.md",
    "docs/product/prd.md",
    "docs/architecture/architecture.md",
    "docs/design/ui-spec.md",
  ]);
  assert.match(result.bootstrap_commands[0].command, /--spec docs\/tasks\/module-name\.md/);

  const cliResult = spawnSync(process.execPath, [cli, "--package", "docs/project/implementation-package.json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(cliResult.status, 0, cliResult.stderr || cliResult.stdout);
  assert.equal(JSON.parse(cliResult.stdout).status, "READY");
});

test("validation reports an unmapped requirement", async () => {
  const root = await fixture();
  const packagePath = path.join(root, "docs/project/implementation-package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  manifest.traceability = manifest.traceability.filter((row) => row.requirement_id !== "NFR-001");
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await assert.rejects(
    validateImplementationPackage(root, "docs/project/implementation-package.json"),
    (error) => error instanceof PackageValidationError && error.issues.some((issue) => issue.includes("missing requirement NFR-001")),
  );
});

test("validation rejects an unapproved Baoyu design asset", async () => {
  const root = await fixture();
  const metaPath = path.join(root, "designs/project-name/_d_meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  meta.assets["App Prototype"].versions[0].status = "needs-review";
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  await assert.rejects(
    validateImplementationPackage(root, "docs/project/implementation-package.json"),
    (error) => error instanceof PackageValidationError && error.issues.some((issue) => issue.includes("not approved in _d_meta.json")),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "prepare-for-kimi-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  const copies = [
    ["authority.md", "docs/project/authority.md"],
    ["prd.md", "docs/product/prd.md"],
    ["architecture.md", "docs/architecture/architecture.md"],
    ["ui-spec.md", "docs/design/ui-spec.md"],
    ["module-spec.md", "docs/tasks/module-name.md"],
    ["implementation-package.json", "docs/project/implementation-package.json"],
  ];
  for (const [source, target] of copies) {
    const destination = path.join(root, target);
    await mkdir(path.dirname(destination), { recursive: true });
    const template = await readFile(path.join(templatesDirectory, source), "utf8");
    await writeFile(destination, source.endsWith(".md") ? template.replaceAll("Needs review", "Approved") : template, "utf8");
  }
  const packagePath = path.join(root, "docs/project/implementation-package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  manifest.status = "approved";
  manifest.ui.status = "approved";
  for (const approval of Object.values(manifest.approvals)) approval.status = "approved";
  for (const module of manifest.modules) module.status = "approved";
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const designRoot = path.join(root, "designs/project-name");
  await mkdir(designRoot, { recursive: true });
  await writeFile(path.join(designRoot, "App Prototype.html"), "<!doctype html><title>Prototype</title>\n", "utf8");
  await writeFile(
    path.join(designRoot, "_d_meta.json"),
    `${JSON.stringify({
      type: "design",
      assets: {
        "App Prototype": {
          versions: [{ path: "App Prototype.html", status: "approved" }],
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return root;
}
