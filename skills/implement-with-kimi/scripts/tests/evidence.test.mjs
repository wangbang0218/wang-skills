import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256File, validateLocalEvidence } from "../lib/evidence.mjs";

test("local evidence must match path, hash, lines, and excerpt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-evidence-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/example.js"), "first\nsecond\nthird\n", "utf8");
  const hash = await sha256File(path.join(root, "src/example.js"));

  const result = await validateLocalEvidence(root, {
    path: "src/example.js",
    sha256: hash,
    line_start: 2,
    line_end: 3,
    excerpt: "second\nthird",
    claim: "The evidence covers the second and third lines.",
  });
  assert.equal(result.valid, true);

  await assert.rejects(
    validateLocalEvidence(root, {
      path: "src/example.js",
      sha256: hash,
      line_start: 2,
      line_end: 3,
      excerpt: "wrong",
      claim: "Mismatch",
    }),
    /excerpt/i,
  );
});

test("a unique exact excerpt deterministically repairs only an incorrect line range", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-evidence-normalize-"));
  const file = path.join(root, "example.js");
  await writeFile(file, "alpha\n\nbeta\ngamma\n", "utf8");
  const evidence = {
    path: "example.js",
    sha256: await sha256File(file),
    line_start: 1,
    line_end: 3,
    excerpt: "alpha\n\nbeta\ngamma",
    claim: "All four lines establish the behavior.",
  };

  await validateLocalEvidence(root, evidence);
  assert.equal(evidence.line_start, 1);
  assert.equal(evidence.line_end, 4);
  assert.deepEqual(evidence.normalized_range, { line_start: 1, line_end: 3, reason: "unique_exact_excerpt" });
});

test("an ambiguous excerpt cannot repair an incorrect line range", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-evidence-ambiguous-"));
  const file = path.join(root, "example.js");
  await writeFile(file, "same\nother\nsame\n", "utf8");
  await assert.rejects(
    validateLocalEvidence(root, {
      path: "example.js",
      sha256: await sha256File(file),
      line_start: 2,
      line_end: 2,
      excerpt: "same",
      claim: "This is intentionally ambiguous.",
    }),
    /mismatch/,
  );
});

test("evidence cannot escape the repository through a symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-evidence-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "iwk-evidence-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "outside\n", "utf8");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));

  await assert.rejects(
    validateLocalEvidence(root, {
      path: "escape.txt",
      sha256: "0".repeat(64),
      line_start: 1,
      line_end: 1,
      excerpt: "outside",
      claim: "Must not escape",
    }),
    /outside|symlink/i,
  );
});
