import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { claudeArguments, claudeEnvironment, preflightClaude, resolveClaudeBinary, runClaudeNode } from "../lib/claude-runner.mjs";

function envelope(runId, compacted = false) {
  return {
    schema_version: 1,
    mode: "bootstrap",
    run_id: runId,
    summary: "审查完成。",
    findings: [],
    ac_coverage: [],
    next_actions: [],
    external_research: { status: "NOT_REQUESTED", sources: [] },
    context: { completeness: "FULL", omissions: [], compacted },
  };
}

async function fakeClaude(root, response) {
  const binary = path.join(root, "claude");
  const help = ["--safe-mode", "--no-session-persistence", "--json-schema", "--permission-mode", "--tools", "--allowedTools", "--disallowedTools", "--effort"].join(" ");
  await writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9"); process.exit(0); }
if (args[0] === "--help") { console.log(${JSON.stringify(help)}); process.exit(0); }
for await (const _ of process.stdin) {}
console.log(JSON.stringify(${JSON.stringify(response)}));
`, "utf8");
  await chmod(binary, 0o755);
  return binary;
}

test("Claude runner uses safe mode, max effort, no persistence, and a read-only tool surface", () => {
  const args = claudeArguments();
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(args[args.indexOf("--effort") + 1], "max");
  assert.match(args[args.indexOf("--tools") + 1], /Read,Grep,Glob,WebFetch,WebSearch/);
  assert.match(args[args.indexOf("--disallowedTools") + 1], /Bash,Edit,Write,.*Agent,Skill,AskUserQuestion/);
  assert.equal(claudeEnvironment({ PATH: "/bin" }).DISABLE_COMPACT, "1");
  assert.equal(claudeEnvironment({ PATH: "/bin" }).CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
});

test("Claude output Schema mirrors validator-required nested collection types", () => {
  const args = claudeArguments();
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  assert.deepEqual(schema.properties.next_actions.items, {
    type: "string",
    minLength: 1,
  });
  assert.deepEqual(schema.properties.context.required, [
    "completeness",
    "omissions",
    "compacted",
  ]);
  assert.deepEqual(schema.properties.context.properties.omissions, {
    type: "array",
    items: { type: "string" },
  });
  assert.equal("additionalProperties" in schema.properties.context, false);
  assert.deepEqual(schema.properties.findings.items.required, [
    "id",
    "severity",
    "title",
    "explanation",
    "evidence",
  ]);
  assert.deepEqual(schema.properties.ac_coverage.items.required, [
    "ac_id",
    "status",
    "test_refs",
  ]);
  assert.deepEqual(schema.properties.external_research.required, [
    "status",
    "sources",
  ]);
  assert.deepEqual(schema.properties.findings.items.properties.evidence, {
    type: "array",
  });
  assert.deepEqual(schema.properties.external_research.properties.sources, {
    type: "array",
  });
});

test("Claude preflight feature-detects isolation flags and runs a structured review", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-claude-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  const response = { structured_output: envelope("run-claude"), modelUsage: { "configured-default": { inputTokens: 10 } } };
  const binary = await fakeClaude(root, response);
  const preflight = await preflightClaude({ env: { ...process.env, CLAUDE_BIN: binary } });
  const result = await runClaudeNode({
    repoRoot: root,
    mode: "bootstrap",
    runId: "run-claude",
    specPath: "spec.md",
    contextPack: "<context />",
    acIds: [],
    preflight,
  });
  assert.equal(result.envelope.reviewer, "claude-code");
  assert.equal(result.envelope.model.requested_effort, "max");
  assert.equal(result.envelope.model.binary_path, binary);
  assert.equal(result.envelope.model.binary_source, "explicit");
  assert.deepEqual(result.envelope.model.reported_models, ["configured-default"]);
});

test("Claude resolution prefers the Volta shim over a Node image binary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-claude-resolution-"));
  const voltaHome = path.join(root, "volta");
  const shim = path.join(voltaHome, "bin", "claude");
  const nodeImage = path.join(root, "tools", "image", "node", "24.14.1", "bin");
  const stale = path.join(nodeImage, "claude");
  await mkdir(path.dirname(shim), { recursive: true });
  await mkdir(nodeImage, { recursive: true });
  await writeFile(shim, "#!/bin/sh\n", "utf8");
  await writeFile(stale, "#!/bin/sh\n", "utf8");
  await chmod(shim, 0o755);
  await chmod(stale, 0o755);

  const resolved = await resolveClaudeBinary({
    VOLTA_HOME: voltaHome,
    PATH: `${nodeImage}${path.delimiter}${path.join(voltaHome, "bin")}`,
  });
  assert.deepEqual(resolved, { binary: shim, source: "volta-shim" });
});

test("Claude resolution rejects a Node image binary when no Volta Claude is available", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-claude-stale-"));
  const nodeImage = path.join(root, "tools", "image", "node", "24.14.1", "bin");
  const stale = path.join(nodeImage, "claude");
  await mkdir(nodeImage, { recursive: true });
  await writeFile(stale, "#!/bin/sh\n", "utf8");
  await chmod(stale, 0o755);

  await assert.rejects(
    resolveClaudeBinary({ VOLTA_HOME: path.join(root, "missing-volta"), PATH: nodeImage }),
    (error) => error.kind === "CONFIG" && /Node image binary/.test(error.message),
  );
});

test("Claude compaction fails closed instead of shrinking the context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-claude-context-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  const binary = await fakeClaude(root, { structured_output: envelope("run-context", true) });
  await assert.rejects(
    runClaudeNode({
      repoRoot: root,
      mode: "bootstrap",
      runId: "run-context",
      specPath: "spec.md",
      contextPack: "<context />",
      acIds: [],
      preflight: { binary, version: "9.9.9" },
    }),
    (error) => error.kind === "CONTEXT_OVERSIZE",
  );
});

test("Claude selector omissions enter Schema repair instead of failing after the runner returns", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-claude-selector-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  const output = envelope("run-selector");
  output.mode = "selector";
  const binary = await fakeClaude(root, { structured_output: output });
  await assert.rejects(
    runClaudeNode({
      repoRoot: root,
      mode: "selector",
      runId: "run-selector",
      specPath: "spec.md",
      contextPack: "<context />",
      acIds: [],
      preflight: { binary, version: "9.9.9" },
    }),
    (error) => error.kind === "SCHEMA" && /selected_paths/.test(error.message),
  );
});

test("Claude evidence-shape failures remain EVIDENCE and never consume Schema repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-claude-evidence-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  const output = envelope("run-evidence");
  output.findings = [{
    id: "F-001",
    severity: "WARNING",
    title: "外部证据不完整",
    explanation: "缺少标题与访问时间。",
    evidence: [{ url: "https://example.com", claim: "示例声明" }],
  }];
  const binary = await fakeClaude(root, { structured_output: output });
  await assert.rejects(
    runClaudeNode({
      repoRoot: root,
      mode: "bootstrap",
      runId: "run-evidence",
      specPath: "spec.md",
      contextPack: "<context />",
      acIds: [],
      preflight: { binary, version: "9.9.9" },
    }),
    (error) => error.kind === "EVIDENCE" && /missing title/.test(error.message),
  );
});
