import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  activateReviewerFailover,
  applyStateEvent,
  createInitialState,
  enableReviewerFallback,
  readStateFile,
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
      summary: "fallback review complete",
      findings: [],
      ac_coverage: [{ ac_id: "AC-001", status: "COVERED", test_refs: ["spec.md"] }],
      next_actions: [],
      external_research: { status: "NOT_REQUESTED", sources: [] },
      context: { completeness: "FULL", omissions: [], compacted: false }
    },
    modelUsage: { "configured-default": {} }
  }));
} else process.exit(1);
`, "utf8");
  await chmod(binary, 0o755);
  return binary;
}

async function fakeKimi(root) {
  const binary = path.join(root, "fake-kimi");
  const fixture = pathToFileURL(path.join(testsDirectory, "fixtures/fake-acp.mjs")).href;
  await writeFile(binary, `#!/usr/bin/env node
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

test("setup-hook merges project config and remove-hook removes only the owned script", async () => {
  const root = await repository();
  await mkdir(path.join(root, ".codex"));
  await writeFile(
    path.join(root, ".codex/hooks.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node existing.mjs" }] }] } }),
    "utf8",
  );

  const setup = spawnSync(process.execPath, [cli, "setup-hook"], { cwd: root, encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const configured = JSON.parse(await readFile(path.join(root, ".codex/hooks.json"), "utf8"));
  assert.equal(configured.hooks.Stop.length, 1);
  assert.equal(configured.hooks.SessionStart.length, 1);

  const remove = spawnSync(process.execPath, [cli, "remove-hook"], { cwd: root, encoding: "utf8" });
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
  await assert.rejects(readFile(path.join(root, ".codex/hooks/implement-with-kimi.mjs")), { code: "ENOENT" });
});

test("record command advances a prepared state without running tests itself", async () => {
  const root = await repository();
  const hash = await sha256File(path.join(root, "spec.md"));
  let state = createInitialState({ specPath: "spec.md", specSha256: hash, runId: "run-cli" });
  state.authority_paths = ["architecture.md"];
  state.authority_hashes = { "architecture.md": await sha256File(path.join(root, "architecture.md")) };
  state = applyStateEvent(state, "bootstrap-ready", {});
  await writeStateFile(path.join(root, "spec.state.md"), state, "human note\n");

  const result = spawnSync(process.execPath, [cli, "record", "tests-written", "--spec", "spec.md", "--ac", "AC-001"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.status, "TESTS_WRITTEN");
  assert.equal(loaded.userNotes, "human note\n");
});

test("existing runs require explicit repository consent and 1M declaration before enabling fallback", async () => {
  const root = await repository();
  const hash = await sha256File(path.join(root, "spec.md"));
  const state = createInitialState({ specPath: "spec.md", specSha256: hash, runId: "run-fallback" });
  state.authority_paths = ["architecture.md"];
  state.authority_hashes = { "architecture.md": await sha256File(path.join(root, "architecture.md")) };
  await writeStateFile(path.join(root, "spec.state.md"), state, "keep\n");
  const binary = await fakeClaude(root);

  const missingConsent = spawnSync(
    process.execPath,
    [cli, "enable-reviewer-fallback", "--spec", "spec.md", "--authority", "architecture.md", "--fallback-reviewer", "claude-code", "--reviewer-context", "1m"],
    { cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_BIN: binary } },
  );
  assert.equal(missingConsent.status, 2);
  assert.match(missingConsent.stdout, /consent-repository-to-reviewer/);

  const enabled = spawnSync(
    process.execPath,
    [cli, "enable-reviewer-fallback", "--spec", "spec.md", "--authority", "architecture.md", "--fallback-reviewer", "claude-code", "--reviewer-context", "1m", "--consent-repository-to-reviewer"],
    { cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_BIN: binary } },
  );
  assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.reviewer_policy.fallback, "claude-code");
  assert.equal(loaded.state.reviewer_policy.repository_consent, true);
  assert.equal(loaded.state.reviewer_policy.required_context_tokens, 1_048_576);
  assert.equal(loaded.userNotes, "keep\n");
});

test("bootstrap falls back from Kimi authentication failure and persists run stickiness", async () => {
  const root = await repository();
  const kimi = await fakeKimi(root);
  const claude = await fakeClaude(root, { review: true });
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "bootstrap",
      "--spec", "spec.md",
      "--authority", "architecture.md",
      "--goal", "active",
      "--fallback-reviewer", "claude-code",
      "--reviewer-context", "1m",
      "--consent-repository-to-reviewer",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        KIMI_BIN: kimi,
        CLAUDE_BIN: claude,
        FAKE_PROMPT_ERROR: JSON.stringify({ code: -32000, message: "Authentication required" }),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "READY");
  assert.equal(output.module_status, "BOOTSTRAP_READY");
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.reviewer_failover.active, true);
  assert.equal(loaded.state.reviewer_failover.scope, "RUN");
  assert.equal(loaded.state.reviewer_failover.reason_code, "KIMI_AUTH_REQUIRED");
  assert.equal(loaded.state.last_reviewer_review.reviewer, "claude-code");
});

test("retry-kimi clears run stickiness only after a fresh ACP probe", async () => {
  const root = await repository();
  const kimi = await fakeKimi(root);
  const hash = await sha256File(path.join(root, "spec.md"));
  let state = createInitialState({ specPath: "spec.md", specSha256: hash, runId: "run-retry" });
  state.authority_paths = ["architecture.md"];
  state.authority_hashes = { "architecture.md": await sha256File(path.join(root, "architecture.md")) };
  state = enableReviewerFallback(state);
  state = activateReviewerFailover(state, {
    scope: "RUN",
    reasonCode: "KIMI_QUOTA_EXHAUSTED",
    message: "quota exhausted",
  });
  await writeStateFile(path.join(root, "spec.state.md"), state, "");

  const result = spawnSync(
    process.execPath,
    [cli, "retry-kimi", "--spec", "spec.md", "--authority", "architecture.md"],
    { cwd: root, encoding: "utf8", env: { ...process.env, KIMI_BIN: kimi, FAKE_RESPONSE_TEXT: "READY" } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.reviewer_failover.active, false);
  assert.equal(loaded.state.history.at(-1).event, "kimi-retry-ready");
});

test("tests-written requires every AC to be mapped or excepted", async () => {
  const root = await repository();
  const expandedSpec = specText.replace(
    "- AC-001: Behavior is verified.",
    "- AC-001: Behavior is verified.\n- AC-002: Edge behavior is verified.",
  );
  await writeFile(path.join(root, "spec.md"), expandedSpec, "utf8");
  const hash = await sha256File(path.join(root, "spec.md"));
  let state = createInitialState({ specPath: "spec.md", specSha256: hash, runId: "run-mapping" });
  state.authority_paths = ["architecture.md"];
  state.authority_hashes = { "architecture.md": await sha256File(path.join(root, "architecture.md")) };
  state = applyStateEvent(state, "bootstrap-ready", {});
  await writeStateFile(path.join(root, "spec.state.md"), state, "");

  const result = spawnSync(process.execPath, [cli, "record", "tests-written", "--spec", "spec.md", "--ac", "AC-001"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /AC-002/);
});

test("an explicit test exception can cover an AC without fabricating Red", async () => {
  const root = await repository();
  const hash = await sha256File(path.join(root, "spec.md"));
  let state = createInitialState({ specPath: "spec.md", specSha256: hash, runId: "run-exception" });
  state.authority_paths = ["architecture.md"];
  state.authority_hashes = { "architecture.md": await sha256File(path.join(root, "architecture.md")) };
  state = applyStateEvent(state, "bootstrap-ready", {});
  await writeStateFile(path.join(root, "spec.state.md"), state, "");

  const exception = spawnSync(
    process.execPath,
    [cli, "record", "test-exception", "--spec", "spec.md", "--ac", "AC-001", "--reason", "documentation-only change"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(exception.status, 0, exception.stderr || exception.stdout);
  const written = spawnSync(process.execPath, [cli, "record", "tests-written", "--spec", "spec.md"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(written.status, 0, written.stderr || written.stdout);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.status, "TESTS_WRITTEN");
  assert.deepEqual(loaded.state.history.at(-1).details.exception_ac_ids, ["AC-001"]);
});

test("recording stops when an authority document changes", async () => {
  const root = await repository();
  const hash = await sha256File(path.join(root, "spec.md"));
  let state = createInitialState({ specPath: "spec.md", specSha256: hash, runId: "run-authority" });
  state.authority_paths = ["architecture.md"];
  state.authority_hashes = { "architecture.md": await sha256File(path.join(root, "architecture.md")) };
  state = applyStateEvent(state, "bootstrap-ready", {});
  await writeStateFile(path.join(root, "spec.state.md"), state, "");
  await writeFile(path.join(root, "architecture.md"), "# Changed architecture\n", "utf8");

  const result = spawnSync(process.execPath, [cli, "record", "tests-written", "--spec", "spec.md", "--ac", "AC-001"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Authority paths or contents changed/);
});

test("project Hook observes an active state and injects compact recovery context", async () => {
  const root = await repository();
  const hash = await sha256File(path.join(root, "spec.md"));
  const state = createInitialState({ specPath: "spec.md", specSha256: hash, runId: "run-hook" });
  await writeStateFile(path.join(root, "spec.state.md"), state, "keep\n");

  const hook = spawnSync(process.execPath, [hookAsset], {
    cwd: root,
    input: JSON.stringify({ cwd: root, source: "compact", session_id: "session-1" }),
    encoding: "utf8",
  });
  assert.equal(hook.status, 0, hook.stderr || hook.stdout);
  const output = JSON.parse(hook.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /rehydrate/);
  const loaded = await readStateFile(path.join(root, "spec.state.md"));
  assert.equal(loaded.state.hook.status, "OBSERVED_ACTIVE");
  assert.equal(loaded.state.hook.last_event, "compact");
  assert.equal(loaded.userNotes, "keep\n");
});
