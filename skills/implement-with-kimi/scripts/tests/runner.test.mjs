import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sha256File } from "../lib/evidence.mjs";
import { runKimiNode } from "../lib/runner.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(testsDirectory, "fixtures/fake-acp.mjs");

function envelope({ runId, sha256, excerpt, evidencePath = "source.txt" }) {
  return {
    schema_version: 1,
    mode: "bootstrap",
    run_id: runId,
    summary: "Review complete.",
    findings: [
      {
        id: "F-001",
        severity: "WARNING",
        title: "Evidence fixture",
        explanation: "The fixture exercises local evidence validation.",
        evidence: [
          {
            path: evidencePath,
            sha256,
            line_start: 2,
            line_end: 2,
            excerpt,
            claim: "The nested line exists.",
          },
        ],
      },
    ],
    ac_coverage: [],
    next_actions: [],
    external_research: { status: "NOT_REQUESTED", sources: [] },
    context: { completeness: "FULL", omissions: [], compacted: false },
  };
}

test("runner canonicalizes omitted source indentation and does not Schema-retry material evidence failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-runner-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "source.txt"), "root\n  nested\n", "utf8");
  const sha256 = await sha256File(path.join(root, "source.txt"));
  const wrapper = path.join(root, "fake-kimi");
  await writeFile(wrapper, `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fakeAgent).href)};\n`, "utf8");
  await chmod(wrapper, 0o755);
  const preflight = {
    binary: wrapper,
    model_alias: "kimi-code/k3",
    model: "k3",
    max_context_size: 1_048_576,
  };

  const previous = process.env.FAKE_RESPONSE_TEXT;
  try {
    process.env.FAKE_RESPONSE_TEXT = JSON.stringify(envelope({ runId: "run-indent", sha256, excerpt: "nested" }));
    const result = await runKimiNode({
      repoRoot: root,
      mode: "bootstrap",
      runId: "run-indent",
      specPath: "spec.md",
      contextPack: "<context />",
      preflight,
    });
    assert.equal(result.envelope.attempts, 1);
    assert.equal(result.envelope.findings[0].evidence[0].excerpt, "  nested");

    process.env.FAKE_RESPONSE_TEXT = JSON.stringify(envelope({ runId: "run-mismatch", sha256, excerpt: "different" }));
    await assert.rejects(
      runKimiNode({
        repoRoot: root,
        mode: "bootstrap",
        runId: "run-mismatch",
        specPath: "spec.md",
        contextPack: "<context />",
        preflight,
      }),
      (error) => error.kind === "EVIDENCE" && /excerpt mismatch/.test(error.message),
    );

    process.env.FAKE_RESPONSE_TEXT = JSON.stringify(envelope({
      runId: "run-absolute",
      sha256,
      excerpt: "  nested",
      evidencePath: "/tmp/red.log",
    }));
    await assert.rejects(
      runKimiNode({
        repoRoot: root,
        mode: "bootstrap",
        runId: "run-absolute",
        specPath: "spec.md",
        contextPack: "<context />",
        preflight,
      }),
      (error) => error.kind === "EVIDENCE" && /repository-relative/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.FAKE_RESPONSE_TEXT;
    else process.env.FAKE_RESPONSE_TEXT = previous;
  }
});
