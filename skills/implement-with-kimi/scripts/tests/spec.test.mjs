import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAndValidateSpec } from "../lib/spec.mjs";

const validSpec = `# Payment module

## Goal
Implement payment capture.

## Scope
Capture only.

## Non-goals
No refunds.

## Dependencies
None.

## Acceptance criteria
- AC-001: A valid capture succeeds.

## Test requirements
Map every test to an AC id.

## Related architecture and PRD
- [Architecture](architecture.md)
`;

test("spec validation requires stable AC ids and mandatory sections", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-spec-"));
  await writeFile(path.join(root, "spec.md"), validSpec, "utf8");
  await writeFile(path.join(root, "architecture.md"), "# Architecture\n", "utf8");

  const spec = await loadAndValidateSpec(root, "spec.md");
  assert.deepEqual(spec.ac_ids, ["AC-001"]);
  assert.deepEqual(spec.authority_paths, ["architecture.md"]);
});

test("spec validation blocks incomplete specifications", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-spec-invalid-"));
  await writeFile(path.join(root, "spec.md"), "# Task\n\n## Goal\nSomething.\n", "utf8");
  await assert.rejects(loadAndValidateSpec(root, "spec.md"), /incomplete/);
});
