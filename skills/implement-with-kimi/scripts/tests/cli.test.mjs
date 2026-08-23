import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyStateEvent,
  createInitialState,
  readStateFile,
  selectReviewer,
  writeStateFile,
} from "../lib/state.mjs";
import { sha256File } from "../lib/evidence.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(testsDirectory, "../kimi_context.mjs");
const hookAsset = path.resolve(testsDirectory, "../../assets/codex-hook/implement-with-kimi.mjs");

const specText = `# Module

## Goal
Ship behavior.

## Scope
One module.

## Non-goals
No unrelated work.

## Dependencies
None.

## Acceptance criteria
- AC-001: Behavior is verified.

## Test requirements
Map tests to AC-001.

## Related architecture and PRD
- [Architecture](architecture.md)
`;

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "iwk-cli-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "spec.md"), specText, "utf8");
  await writeFile(path.join(root, "architecture.md"), "# Architecture\n", "utf8");
  return root;
}

async function fakeClaude(root, { review = false } = {}) {
  const binary = path.join(root, "fake-claude");
  const help = ["--safe-mode", "--no-session-persistence", "--json-schema", "--permission-mode", "--tools", "--allowedTools", "--disallowedTools", "--effort"].join(" ");
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env.FAKE_CLAUDE_MARKER) writeFileSync(process.env.FAKE_CLAUDE_MARKER, "called\\n");
if (process.argv[2] === "--version") console.log("9.9.9");
else if (process.argv[2] === "--help") console.log(${JSON.stringify(help)});
else if (${review ? "true" : "false"}) {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const runId = prompt.match(/Run id: ([^.]+)\./)?.[1];
  const mode = prompt.match(/Mode: ([^.]+)\./)?.[1];
  console.log(JSON.stringify({
    structured_output: {
      schema_version: 1,
      mode,
      run_id: runId,
      summary: "Claude review complete",
      findings: [],
      ac_coverage: [{ ac_id: "AC-001", status: "COVERED", test_refs: ["spec.md"] }],
      next_actions: [],
      external_research: { status: "NOT_REQUESTED", sources: [] },
      context: { completeness: "FULL", omissions: [], compacted: false }
    },
    modelUsage: { "configured-default": {} }
  }));
} else {
  console.error("Claude review failed");
  process.exit(1);
}
`, "utf8");
  await chmod(binary, 0o755);
  return binary;
}

async function fakeKimi(root) {
  const binary = path.join(root, "fake-kimi");
  const fixture = pathToFileURL(path.join(testsDirectory, "fixtures/fake-acp.mjs")).href;
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env.FAKE_KIMI_MARKER) writeFileSync(process.env.FAKE_KIMI_MARKER, "called\\n");
const command = process.argv[2];
if (command === "--version") console.log("0.0.0-fake");
else if (command === "doctor") process.exit(0);
else if (command === "provider") console.log(JSON.stringify({ models: { "kimi-code/k3": { model: "k3", maxContextSize: 1048576, supportEfforts: ["low", "high", "max"] } } }));
else if (command === "acp") await import(${JSON.stringify(fixture)});
else process.exit(1);
`, "utf8");
  await chmod(binary, 0o755);
  return binary;
}

async function preparedState(root, { runId = "run", reviewer = null, status = "NOT_STARTED", active = true, suspended = false, notes = "" } = {}) {
  const hash = await sha256File(path.join(root, "spec.md"));
  let state = createInitialState({ specPath: "spec.md", specSha256: hash, runId });
  state.authority_paths = ["architecture.md"];
  state.authority_hashes = { "architecture.md": await sha256File(path.join(root, "architecture.md")) };
  state.status = status;
  state.active = active;
  state.suspended = suspended;
  if (reviewer) state = selectReviewer(state, reviewer);
  await writeStateFile(path.join(root, "spec.state.md"), state, notes);
  return state;
}

function run(root, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function assertMissing(filePath) {
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
}

test("setup-hook merges project config and remove-hook removes only the owned script", async () => {
  const root = await repository();
  await mkdir(path.join(root, ".codex"));
  await writeFile(
    path.join(root, ".codex/hooks.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node existing.mjs" }] }] } }),
    "utf8",
  );

  const setup = run(root, ["setup-hook"]);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const configured = JSON.parse(await readFile(path.join(root, ".codex/hooks.json"), "utf8"));
  assert.equal(configured.hooks.Stop.length, 1);
  assert.equal(configured.hooks.SessionStart.length, 1);
  assert.equal(
    configured.hooks.SessionStart[0].hooks[0].command,
    'volta run node "$(git rev-parse --show-toplevel)/.codex/hooks/implement-with-kimi.mjs"',
  );

  const remove = run(root, ["remove-hook"]);
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
  await assertMissing(path.join(root, ".codex/hooks/implement-with-kimi.mjs"));
});

test("setup-hook upgrades the previous v3 Hook to the Volta-backed asset", async () => {
  const root = await repository();
  const currentAsset = await readFile(hookAsset, "utf8");
  const previousAsset = currentAsset.replace("#!/usr/bin/env -S volta run node", "#!/usr/bin/env node");
  assert.notEqual(previousAsset, currentAsset);
  await mkdir(path.join(root, ".codex/hooks"), { recursive: true });
  await writeFile(path.join(root, ".codex/hooks/implement-with-kimi.mjs"), previousAsset, "utf8");

  const setup = run(root, ["setup-hook"]);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  assert.equal(await readFile(path.join(root, ".codex/hooks/implement-with-kimi.mjs"), "utf8"), currentAsset);
});

test("setup-hook upgrades the exact bundled v2 Hook to the v3-aware asset", async () => {
  const root = await repository();
  const currentAsset = await readFile(hookAsset, "utf8");
  const legacyAsset = currentAsset
    .replace("#!/usr/bin/env -S volta run node", "#!/usr/bin/env node")
    .replace('  const reviewer = current.state.reviewer_policy?.selected ?? "未选择（继续审查前需执行 select-reviewer）";\n', "")
    .replaceAll(", reviewer=${reviewer}", "")
    .replace("![1, 2, 3].includes", "![1, 2].includes");
  assert.notEqual(legacyAsset, currentAsset);
  await mkdir(path.join(root, ".codex/hooks"), { recursive: true });
  await writeFile(path.join(root, ".codex/hooks/implement-with-kimi.mjs"), legacyAsset, "utf8");

  const setup = run(root, ["setup-hook"]);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  assert.equal(await readFile(path.join(root, ".codex/hooks/implement-with-kimi.mjs"), "utf8"), currentAsset);
});

test("setup-hook and remove-hook recognize the exact bundled v1 Hook", async () => {
  const currentAsset = await readFile(hookAsset, "utf8");
  const legacyAsset = currentAsset
    .replace("#!/usr/bin/env -S volta run node", "#!/usr/bin/env node")
    .replace('  const reviewer = current.state.reviewer_policy?.selected ?? "未选择（继续审查前需执行 select-reviewer）";\n', "")
    .replaceAll(", reviewer=${reviewer}", "")
    .replace("![1, 2, 3].includes(state.state_schema_version)", "state.state_schema_version !== 1");
  assert.notEqual(legacyAsset, currentAsset);

  const upgradeRoot = await repository();
  await mkdir(path.join(upgradeRoot, ".codex/hooks"), { recursive: true });
  await writeFile(path.join(upgradeRoot, ".codex/hooks/implement-with-kimi.mjs"), legacyAsset, "utf8");
  const setup = run(upgradeRoot, ["setup-hook"]);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  assert.equal(await readFile(path.join(upgradeRoot, ".codex/hooks/implement-with-kimi.mjs"), "utf8"), currentAsset);

  const removeRoot = await repository();
  await mkdir(path.join(removeRoot, ".codex/hooks"), { recursive: true });
  await writeFile(path.join(removeRoot, ".codex/hooks/implement-with-kimi.mjs"), legacyAsset, "utf8");
  const remove = run(removeRoot, ["remove-hook"]);
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
  await assertMissing(path.join(removeRoot, ".codex/hooks/implement-with-kimi.mjs"));
});

test("bootstrap requires a valid reviewer before creating state or running a reviewer", async () => {
  for (const reviewerArgs of [[], ["--reviewer", "auto"]]) {
    const root = await repository();
    const result = run(root, ["bootstrap", "--spec", "spec.md", "--authority", "architecture.md", ...reviewerArgs]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /--reviewer (?:is required|must be kimi or claude-code)/);
    await assertMissing(path.join(root, "spec.state.md"));
  }
});

test("bootstrap routes directly to Kimi and never starts Claude Code", async () => {
  const root = await repository();
  const kimi = await fakeKimi(root);
  const claude = await fakeClaude(root, { review: true });
  const kimiMarker = path.join(root, "kimi.marker");
  const claudeMarker = path.join(root, "claude.marker");
  const result = run(
    root,
    ["bootstrap", "--spec", "spec.md", "--authority", "architecture.md", "--goal", "active", "--reviewer", "kimi"],
    { KIMI_BIN: kimi, CLAUDE_BIN: claude, FAKE_REVIEW_RESPONSE: "1", FAKE_KIMI_MARKER: kimiMarker, FAKE_CLAUDE_MARKER: claudeMarker },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((await readFile(kimiMarker, "utf8")).trim(), "called");
  await assertMissing(claudeMarker);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.reviewer_policy.selected, "kimi");
  assert.equal(loaded.state.reviewer_policy.repository_access_authorized, true);
  assert.equal(loaded.state.last_reviewer_review.reviewer, "kimi");
});

test("bootstrap routes directly to Claude Code and never starts Kimi", async () => {
  const root = await repository();
  const kimi = await fakeKimi(root);
  const claude = await fakeClaude(root, { review: true });
  const kimiMarker = path.join(root, "kimi.marker");
  const claudeMarker = path.join(root, "claude.marker");
  const result = run(
    root,
    ["bootstrap", "--spec", "spec.md", "--authority", "architecture.md", "--goal", "active", "--reviewer", "claude-code"],
    { KIMI_BIN: kimi, CLAUDE_BIN: claude, FAKE_KIMI_MARKER: kimiMarker, FAKE_CLAUDE_MARKER: claudeMarker },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((await readFile(claudeMarker, "utf8")).trim(), "called");
  await assertMissing(kimiMarker);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.reviewer_policy.selected, "claude-code");
  assert.equal(loaded.state.reviewer_policy.required_context_tokens, 1_048_576);
  assert.equal(loaded.state.last_reviewer_review.reviewer, "claude-code");
});

test("a selected reviewer failure never falls back to the other reviewer", async () => {
  const kimiRoot = await repository();
  const kimi = await fakeKimi(kimiRoot);
  const claude = await fakeClaude(kimiRoot, { review: true });
  const claudeMarker = path.join(kimiRoot, "claude.marker");
  const kimiFailure = run(
    kimiRoot,
    ["bootstrap", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", "kimi"],
    {
      KIMI_BIN: kimi,
      CLAUDE_BIN: claude,
      FAKE_CLAUDE_MARKER: claudeMarker,
      FAKE_PROMPT_ERROR: JSON.stringify({ code: -32000, message: "Authentication required" }),
    },
  );
  assert.notEqual(kimiFailure.status, 0);
  assert.match(kimiFailure.stdout, /automatic_fallback.*false/s);
  await assertMissing(claudeMarker);

  const claudeRoot = await repository();
  const failingClaude = await fakeClaude(claudeRoot);
  const unusedKimi = await fakeKimi(claudeRoot);
  const kimiMarker = path.join(claudeRoot, "kimi.marker");
  const claudeFailure = run(
    claudeRoot,
    ["bootstrap", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", "claude-code"],
    { CLAUDE_BIN: failingClaude, KIMI_BIN: unusedKimi, FAKE_KIMI_MARKER: kimiMarker },
  );
  assert.notEqual(claudeFailure.status, 0);
  assert.match(claudeFailure.stdout, /automatic_fallback.*false/s);
  await assertMissing(kimiMarker);
});

test("a failed bootstrap run cannot change reviewer without select-reviewer", async () => {
  const root = await repository();
  const kimi = await fakeKimi(root);
  const claude = await fakeClaude(root, { review: true });
  const first = run(
    root,
    ["bootstrap", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", "kimi"],
    { KIMI_BIN: kimi, FAKE_PROMPT_ERROR: JSON.stringify({ code: -32000, message: "Authentication required" }) },
  );
  assert.notEqual(first.status, 0);
  const statePath = path.join(root, "spec.state.md");
  const before = await readFile(statePath, "utf8");
  const claudeMarker = path.join(root, "claude.marker");

  const retry = run(
    root,
    ["bootstrap", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", "claude-code"],
    { CLAUDE_BIN: claude, FAKE_CLAUDE_MARKER: claudeMarker },
  );
  assert.equal(retry.status, 2);
  assert.match(retry.stdout, /already selected kimi.*select-reviewer/s);
  assert.equal(await readFile(statePath, "utf8"), before);
  await assertMissing(claudeMarker);
});

test("--new-run starts a fresh run and archives a failed bootstrap run", async () => {
  const root = await repository();
  await preparedState(root, { runId: "failed-run", reviewer: "kimi", status: "NOT_STARTED", notes: "keep\n" });
  const claude = await fakeClaude(root, { review: true });
  const result = run(
    root,
    [
      "bootstrap", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", "claude-code",
      "--new-run", "--reason", "explicit restart",
    ],
    { CLAUDE_BIN: claude },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.notEqual(loaded.state.run_id, "failed-run");
  assert.equal(loaded.state.reviewer_policy.selected, "claude-code");
  assert.equal(loaded.state.past_runs.at(-1).run_id, "failed-run");
  assert.equal(loaded.state.past_runs.at(-1).reviewer_policy.selected, "kimi");
  assert.equal(loaded.userNotes, "keep\n");
});

test("select-reviewer preflights then preserves the active run, evidence, and user notes", async () => {
  const root = await repository();
  let state = await preparedState(root, { runId: "run-selection", reviewer: "kimi", status: "RED_CONFIRMED", notes: "keep\n" });
  state.evidence.push({ event: "red-observed", exit_code: 1 });
  state.unresolved_findings.push({ id: "F-001" });
  await writeStateFile(path.join(root, "spec.state.md"), state, "keep\n");
  const claude = await fakeClaude(root);
  const result = run(
    root,
    ["select-reviewer", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", "claude-code"],
    { CLAUDE_BIN: claude },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.run_id, "run-selection");
  assert.equal(loaded.state.status, "RED_CONFIRMED");
  assert.equal(loaded.state.reviewer_policy.selected, "claude-code");
  assert.deepEqual(loaded.state.evidence, state.evidence);
  assert.deepEqual(loaded.state.unresolved_findings, state.unresolved_findings);
  assert.equal(loaded.state.history.at(-1).details.previous, "kimi");
  assert.equal(loaded.userNotes, "keep\n");
});

test("failed reviewer preflight leaves the state file byte-for-byte unchanged", async () => {
  const root = await repository();
  await preparedState(root, { runId: "run-preflight", reviewer: "kimi", notes: "keep\n" });
  const statePath = path.join(root, "spec.state.md");
  const before = await readFile(statePath, "utf8");
  const brokenClaude = path.join(root, "broken-claude");
  await writeFile(brokenClaude, "#!/bin/sh\nexit 1\n", "utf8");
  await chmod(brokenClaude, 0o755);
  const result = run(
    root,
    ["select-reviewer", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", "claude-code"],
    { CLAUDE_BIN: brokenClaude },
  );
  assert.equal(result.status, 3);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("select-reviewer rejects an inactive run before reviewer preflight", async () => {
  const root = await repository();
  await preparedState(root, { runId: "run-inactive", status: "COMPLETED", active: false });
  const claude = await fakeClaude(root);
  const marker = path.join(root, "claude.marker");
  const result = run(
    root,
    ["select-reviewer", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", "claude-code"],
    { CLAUDE_BIN: claude, FAKE_CLAUDE_MARKER: marker },
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /active run/);
  await assertMissing(marker);
});

test("legacy reviewer commands and options return migration guidance", async () => {
  const root = await repository();
  const oldCommand = run(root, ["enable-reviewer-fallback"]);
  assert.equal(oldCommand.status, 2);
  assert.match(oldCommand.stdout, /was removed.*select-reviewer/s);
  const oldOption = run(root, [
    "bootstrap", "--spec", "spec.md", "--fallback-reviewer", "claude-code", "--reviewer-context", "1m", "--consent-repository-to-reviewer",
  ]);
  assert.equal(oldOption.status, 2);
  assert.match(oldOption.stdout, /Legacy reviewer options were removed/);
});

test("per-node reviewer overrides are rejected in favor of select-reviewer", async () => {
  const root = await repository();
  const result = run(root, ["review-tests", "--reviewer", "kimi"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /select-reviewer/);
});

test("review commands fail closed on a corrupted reviewer authorization", async () => {
  const root = await repository();
  const state = await preparedState(root, { reviewer: "kimi", status: "RED_CONFIRMED" });
  state.reviewer_policy.repository_access_authorized = false;
  await writeStateFile(path.join(root, "spec.state.md"), state, "");
  const kimi = await fakeKimi(root);
  const marker = path.join(root, "kimi.marker");
  const result = run(
    root,
    ["review-tests", "--spec", "spec.md", "--authority", "architecture.md"],
    { KIMI_BIN: kimi, FAKE_KIMI_MARKER: marker },
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /not authorized/);
  await assertMissing(marker);
});

test("a migrated suspended run can select its reviewer explicitly while resuming", async () => {
  const root = await repository();
  const state = await preparedState(root, { runId: "run-suspended", status: "BOOTSTRAP_READY", active: false, suspended: true, notes: "keep\n" });
  state.state_schema_version = 2;
  state.reviewer_policy = {
    preferred: "kimi",
    fallback: null,
    repository_consent: false,
    required_context_tokens: null,
    enabled_at: null,
  };
  state.reviewer_failover = { active: false, scope: null, reason_code: null, message: null, activated_at: null };
  await writeStateFile(path.join(root, "spec.state.md"), state, "keep\n");
  const claude = await fakeClaude(root, { review: true });
  const missing = run(root, ["resume", "--spec", "spec.md", "--authority", "architecture.md"], { CLAUDE_BIN: claude });
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /No reviewer is selected/);
  const resumed = run(
    root,
    ["resume", "--spec", "spec.md", "--authority", "architecture.md", "--reviewer", "claude-code"],
    { CLAUDE_BIN: claude },
  );
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.state_schema_version, 3);
  assert.equal(loaded.state.active, true);
  assert.equal(loaded.state.suspended, false);
  assert.equal(loaded.state.reviewer_policy.selected, "claude-code");
  assert.equal(loaded.state.run_id, "run-suspended");
  assert.equal(loaded.userNotes, "keep\n");
});

test("record command advances a prepared state without running tests itself", async () => {
  const root = await repository();
  let state = await preparedState(root, { runId: "run-cli", status: "BOOTSTRAP_READY", notes: "human note\n" });
  await writeStateFile(path.join(root, "spec.state.md"), state, "human note\n");
  const result = run(root, ["record", "tests-written", "--spec", "spec.md", "--ac", "AC-001"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.status, "TESTS_WRITTEN");
  assert.equal(loaded.userNotes, "human note\n");
});

test("tests-written requires every AC to be mapped or excepted", async () => {
  const root = await repository();
  const expandedSpec = specText.replace(
    "- AC-001: Behavior is verified.",
    "- AC-001: Behavior is verified.\n- AC-002: Edge behavior is verified.",
  );
  await writeFile(path.join(root, "spec.md"), expandedSpec, "utf8");
  await preparedState(root, { runId: "run-mapping", status: "BOOTSTRAP_READY" });
  const result = run(root, ["record", "tests-written", "--spec", "spec.md", "--ac", "AC-001"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AC-002/);
});

test("an explicit test exception can cover an AC without fabricating Red", async () => {
  const root = await repository();
  await preparedState(root, { runId: "run-exception", status: "BOOTSTRAP_READY" });
  const exception = run(root, [
    "record", "test-exception", "--spec", "spec.md", "--ac", "AC-001", "--reason", "documentation-only change",
  ]);
  assert.equal(exception.status, 0, exception.stderr || exception.stdout);
  const written = run(root, ["record", "tests-written", "--spec", "spec.md"]);
  assert.equal(written.status, 0, written.stderr || written.stdout);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.status, "TESTS_WRITTEN");
  assert.deepEqual(loaded.state.history.at(-1).details.exception_ac_ids, ["AC-001"]);
});

test("recording stops when an authority document changes", async () => {
  const root = await repository();
  await preparedState(root, { runId: "run-authority", status: "BOOTSTRAP_READY" });
  await writeFile(path.join(root, "architecture.md"), "# Changed architecture\n", "utf8");
  const result = run(root, ["record", "tests-written", "--spec", "spec.md", "--ac", "AC-001"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Authority paths or contents changed/);
});

test("project Hook observes a v3 active state and injects compact recovery context", async () => {
  const root = await repository();
  await preparedState(root, { runId: "run-hook", reviewer: "kimi", notes: "keep\n" });
  const hook = spawnSync(process.execPath, [hookAsset], {
    cwd: root,
    input: JSON.stringify({ cwd: root, source: "compact", session_id: "session-1" }),
    encoding: "utf8",
  });
  assert.equal(hook.status, 0, hook.stderr || hook.stdout);
  const output = JSON.parse(hook.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /rehydrate/);
  assert.match(output.hookSpecificOutput.additionalContext, /reviewer=kimi/);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.hook.status, "OBSERVED_ACTIVE");
  assert.equal(loaded.state.hook.last_event, "compact");
  assert.equal(loaded.userNotes, "keep\n");
});
