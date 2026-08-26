import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { claudeArguments, claudeEnvironment, preflightClaude, resolveClaudeBinary, runClaudeNode } from "../lib/claude-runner.mjs";

function envelope(runId, { mode = "audit", compacted = false } = {}) {
  return {
    schema_version: 1,
    mode,
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

test("Claude runner uses max effort, 1M context, read-only tools, and no USD cap", () => {
  const args = claudeArguments();
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(args[args.indexOf("--effort") + 1], "max");
  assert.match(args[args.indexOf("--tools") + 1], /Read,Grep,Glob,WebFetch,WebSearch/);
  assert.match(args[args.indexOf("--disallowedTools") + 1], /Bash,Edit,Write,.*Agent,Skill,AskUserQuestion/);
  assert.equal(args.includes("--max-budget-usd"), false);
  assert.equal(claudeEnvironment({ PATH: "/bin" }).DISABLE_COMPACT, "1");
  assert.equal(claudeEnvironment({ PATH: "/bin" }).CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
});

test("Claude output Schema exposes only audit and query modes", () => {
  const args = claudeArguments();
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  assert.deepEqual(schema.properties.mode.enum, ["audit", "query"]);
  assert.deepEqual(schema.properties.next_actions.items, { type: "string", minLength: 1 });
  assert.deepEqual(schema.properties.context.required, ["completeness", "omissions", "compacted"]);
  assert.deepEqual(schema.properties.findings.items.required, ["id", "severity", "title", "explanation", "evidence"]);
  assert.deepEqual(schema.properties.ac_coverage.items.required, ["ac_id", "status", "test_refs"]);
});

test("Claude successful audit preserves raw provider usage in the invocation ledger", async () => {
  const root = await createRepo("iwk-claude-success-");
  const response = {
    structured_output: envelope("run-claude"),
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
    modelUsage: { "configured-default": { inputTokens: 10 } },
    total_cost_usd: 0.42,
    duration_ms: 1200,
    duration_api_ms: 900,
    num_turns: 2,
  };
  const binary = await fakeClaude(root, response);
  const preflight = await preflightClaude({ env: { ...process.env, CLAUDE_BIN: binary } });
  const events = [];
  const result = await runClaudeNode({
    repoRoot: root,
    mode: "audit",
    runId: "run-claude",
    specPath: "spec.md",
    contextPack: "<context />",
    acIds: [],
    preflight,
    estimatedInitialTokens: 700,
    onInvocation: async (event) => events.push(event),
  });

  assert.equal(result.envelope.reviewer, "claude-code");
  assert.equal(result.envelope.model.requested_effort, "max");
  assert.equal(result.envelope.model.binary_path, binary);
  assert.deepEqual(result.envelope.model.reported_models, ["configured-default"]);
  const finished = events.find((event) => event.phase === "finished").entry;
  assert.equal(finished.status, "SUCCEEDED");
  assert.equal(finished.usage.input_tokens, 10);
  assert.equal(finished.usage.cache_read_tokens, 7);
  assert.equal(finished.usage.total_cost_usd, 0.42);
  assert.deepEqual(finished.usage.provider_report.modelUsage, response.modelUsage);
  assert.equal(finished.usage.provider_report.duration_api_ms, 900);
});

test("Claude Schema repair consumes at most two prompt submissions and ledgers both failures", async () => {
  const root = await createRepo("iwk-claude-repair-");
  const binary = await fakeClaude(root, { structured_output: {} });
  const budget = { used: 0, max: 2 };
  const events = [];
  await assert.rejects(runClaudeNode({
    repoRoot: root,
    mode: "audit",
    runId: "run-repair",
    specPath: "spec.md",
    contextPack: "<context />",
    preflight: { binary, version: "9.9.9" },
    submissionBudget: budget,
    onInvocation: async (event) => events.push(event),
  }), (error) => error.kind === "SCHEMA");

  assert.equal(budget.used, 2);
  assert.deepEqual(events.filter((event) => event.phase === "finished").map((event) => [event.entry.attempt, event.entry.status]), [
    [1, "FAILED"],
    [2, "FAILED"],
  ]);
});

test("Claude evidence failures remain EVIDENCE and do not consume Schema repair", async () => {
  const root = await createRepo("iwk-claude-evidence-");
  const output = envelope("run-evidence");
  output.findings = [{
    id: "F-001",
    severity: "WARNING",
    title: "外部证据不完整",
    explanation: "缺少标题与访问时间。",
    evidence: [{ url: "https://example.com", claim: "示例声明" }],
  }];
  const binary = await fakeClaude(root, { structured_output: output, total_cost_usd: 0.01 });
  const budget = { used: 0, max: 2 };
  const events = [];
  await assert.rejects(runClaudeNode({
    repoRoot: root,
    mode: "audit",
    runId: "run-evidence",
    specPath: "spec.md",
    contextPack: "<context />",
    preflight: { binary, version: "9.9.9" },
    submissionBudget: budget,
    onInvocation: async (event) => events.push(event),
  }), (error) => error.kind === "EVIDENCE" && /missing title/.test(error.message));

  assert.equal(budget.used, 1);
  const finished = events.find((event) => event.phase === "finished").entry;
  assert.equal(finished.status, "FAILED");
  assert.equal(finished.usage.total_cost_usd, 0.01);
});

test("Claude compaction fails closed instead of shrinking the selected context", async () => {
  const root = await createRepo("iwk-claude-context-");
  const binary = await fakeClaude(root, { structured_output: envelope("run-context", { compacted: true }) });
  await assert.rejects(runClaudeNode({
    repoRoot: root,
    mode: "audit",
    runId: "run-context",
    specPath: "spec.md",
    contextPack: "<context />",
    preflight: { binary, version: "9.9.9" },
  }), (error) => error.kind === "CONTEXT_OVERSIZE");
});

test("Claude cancellation after submission records a failed ledger entry", async () => {
  const root = await createRepo("iwk-claude-cancel-");
  const binary = path.join(root, "claude-hang");
  await writeFile(binary, `#!/usr/bin/env node
for await (const _ of process.stdin) {}
setInterval(() => {}, 1000);
`, "utf8");
  await chmod(binary, 0o755);
  const controller = new AbortController();
  const budget = { used: 0, max: 2 };
  const events = [];
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(runClaudeNode({
      repoRoot: root,
      mode: "audit",
      runId: "run-cancel",
      specPath: "spec.md",
      contextPack: "<context />",
      preflight: { binary, version: "9.9.9" },
      signal: controller.signal,
      submissionBudget: budget,
      onInvocation: async (event) => events.push(event),
    }), (error) => error.kind === "CANCELLED");
  } finally {
    clearTimeout(timer);
  }

  assert.equal(budget.used, 1);
  const finished = events.find((event) => event.phase === "finished").entry;
  assert.equal(finished.status, "FAILED");
  assert.equal(finished.error.kind, "CANCELLED");
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

async function createRepo(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}
