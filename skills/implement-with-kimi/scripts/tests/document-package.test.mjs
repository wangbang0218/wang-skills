import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PackageValidationError, validateImplementationPackage } from "../lib/document-package.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(testsDirectory, "../kimi_context.mjs");

test("consumer validation emits two exact bootstrap commands without calling a reviewer", async () => {
  const root = await fixture();
  const direct = await validateImplementationPackage(root, "docs/project/implementation-package.json", {
    specPath: "docs/tasks/core.md",
  });
  assert.equal(direct.status, "READY");
  assert.equal(direct.bootstrap_commands.length, 2);
  assert.deepEqual(direct.bootstrap_commands.map((item) => item.reviewer), ["kimi", "claude-code"]);
  const commandPrefix = "volta run node '<skill-directory>/scripts/kimi_context.mjs' bootstrap --spec docs/tasks/core.md --reviewer";
  const authorityArgs = "--authority docs/project/implementation-package.json --authority docs/project/authority.md --authority docs/product/prd.md --authority docs/architecture/architecture.md --goal none";
  assert.equal(direct.bootstrap_commands[0].command, `${commandPrefix} kimi ${authorityArgs}`);
  assert.equal(direct.bootstrap_commands[1].command, `${commandPrefix} claude-code ${authorityArgs}`);

  const cliResult = spawnSync(process.execPath, [
    cli,
    "validate-package",
    "--package",
    "docs/project/implementation-package.json",
    "--spec",
    "docs/tasks/core.md",
  ], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(cliResult.status, 0, cliResult.stderr || cliResult.stdout);
  assert.equal(JSON.parse(cliResult.stdout).status, "READY");
});

test("consumer validation blocks a stale approval", async () => {
  const root = await fixture();
  const packagePath = path.join(root, "docs/project/implementation-package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  manifest.approvals.architecture.status = "needs-review";
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await assert.rejects(
    validateImplementationPackage(root, "docs/project/implementation-package.json"),
    (error) => error instanceof PackageValidationError && error.issues.includes("approvals.architecture.status: expected approved"),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-package-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  const files = {
    "docs/project/authority.md": "# Authority\n\nApproved domain ownership.\n",
    "docs/product/prd.md": "# PRD\n\n- REQ-001: Ship behavior.\n- NFR-001: Remain reliable.\n",
    "docs/architecture/architecture.md": "# Architecture\n\nADR-001 selects the component boundary.\n",
    "docs/tasks/core.md": `# Core module

## Goal
Ship behavior.

## Scope
Core behavior only.

## Non-goals
No UI.

## Dependencies
None.

## Acceptance criteria
- AC-001: Behavior is observable.

## Test requirements
- AC-001: Add a focused automated test.

## Related documents
- [Implementation package](../project/implementation-package.json)
- [Authority](../project/authority.md)
- [PRD](../product/prd.md)
- [Architecture](../architecture/architecture.md)
`,
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const manifest = {
    schema_version: 1,
    project: "package-test",
    mode: "greenfield",
    status: "approved",
    documents: {
      authority: "docs/project/authority.md",
      prd: "docs/product/prd.md",
      architecture: "docs/architecture/architecture.md",
    },
    ui: {
      status: "not-applicable",
      spec: null,
      design_root: null,
      design_meta: null,
      approved_assets: [],
    },
    approvals: {
      requirements: { status: "approved" },
      architecture: { status: "approved" },
      ui: { status: "not-applicable" },
      implementation: { status: "approved" },
    },
    modules: [{ id: "MOD-001", name: "core", spec: "docs/tasks/core.md", status: "approved", depends_on: [] }],
    traceability: [
      {
        requirement_id: "REQ-001",
        flow_ids: [],
        ui_ids: [],
        architecture_refs: ["ADR-001"],
        module_ids: ["MOD-001"],
        acceptance_criteria: ["MOD-001:AC-001"],
        test_requirements: ["Focused automated test"],
      },
      {
        requirement_id: "NFR-001",
        flow_ids: [],
        ui_ids: [],
        architecture_refs: ["ADR-001"],
        module_ids: ["MOD-001"],
        acceptance_criteria: ["MOD-001:AC-001"],
        test_requirements: ["Reliability verification"],
      },
    ],
  };
  await writeFile(
    path.join(root, "docs/project/implementation-package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return root;
}
