import assert from "node:assert/strict";
import test from "node:test";

import { buildKimiPrompt, extractJsonObject } from "../lib/prompt.mjs";

test("prompt declares read-only policy and exact output contract", () => {
  const prompt = buildKimiPrompt({
    mode: "audit",
    runId: "run-1",
    specPath: "spec.md",
    effort: "max",
    contextPack: "<context />",
  });
  assert.match(prompt, /Never write\/edit\/delete\/move/);
  assert.match(prompt, /schema_version/);
  assert.match(prompt, /Mode: audit/);
  assert.match(prompt, /leading.*space.*tab/i);
  assert.match(prompt, /repository-relative/);
  assert.match(prompt, /manifest.*authoritative SHA-256.*selected or omitted/i);
  assert.match(prompt, /copy its matching sha256 verbatim.*never leave it blank/i);
  assert.match(prompt, /state_summary.*execution-log path/i);
  assert.match(prompt, /\/tmp/);
  assert.match(prompt, /including command or excerpt/);
  assert.match(prompt, /next_actions.*array of non-empty strings/i);
  assert.match(prompt, /omissions as an array of strings/i);
});

test("review-tests treats valid expected Red as gate success rather than missing implementation blocker", () => {
  const prompt = buildKimiPrompt({
    mode: "review-tests",
    runId: "run-red",
    specPath: "spec.md",
    effort: "high",
    contextPack: "<context />",
  });
  assert.match(prompt, /valid expected Red.*success evidence/i);
  assert.match(prompt, /missing production behavior.*never.*BLOCKED/i);
  assert.match(prompt, /Do not require Green.*implementation.*verification.*audit/i);
  assert.match(prompt, /ac_coverage.*test coverage/i);
  assert.match(prompt, /BLOCKED.*prevents the tests from being accepted/i);
});

test("rehydrate distinguishes expected unfinished work from a current workflow blocker", () => {
  const prompt = buildKimiPrompt({
    mode: "rehydrate",
    runId: "run-rehydrate",
    specPath: "spec.md",
    effort: "high",
    contextPack: "<context />",
  });
  assert.match(prompt, /unfinished implementation.*not.*workflow blocker/i);
  assert.match(prompt, /RED_CONFIRMED.*valid expected Red.*never.*BLOCKED/i);
  assert.match(prompt, /Re-evaluate.*state_summary.*BLOCKED/i);
  assert.match(prompt, /cannot advance.*milestone/i);
});

test("selector prompt forbids content claims from metadata-only catalog entries", () => {
  const prompt = buildKimiPrompt({
    mode: "selector",
    runId: "run-selector",
    specPath: "spec.md",
    effort: "high",
    contextPack: "<selector-budget />",
  });
  assert.match(prompt, /selector catalog is metadata-only/i);
  assert.match(prompt, /contains no repository file contents/i);
  assert.match(prompt, /never infer.*claim.*contents.*path.*SHA-256.*byte size.*tier.*changed flag/i);
  assert.match(prompt, /SHA-256 identifies.*does not reveal.*contents/i);
  assert.match(prompt, /set findings to \[\].*no evidence/i);
  assert.match(prompt, /add its path to selected_paths.*actual text.*do not describe imagined contents/i);
});

test("JSON extraction tolerates a fenced repair response", () => {
  assert.deepEqual(extractJsonObject("```json\n{\"ok\":true}\n```"), { ok: true });
});
