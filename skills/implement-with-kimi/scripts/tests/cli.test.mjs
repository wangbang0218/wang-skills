import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyStateEvent, createInitialState, readStateFile, writeStateFile } from "../lib/state.mjs";
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
