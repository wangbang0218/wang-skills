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
  assert.match(prompt, /state_summary.*execution-log path/i);
  assert.match(prompt, /\/tmp/);
  assert.match(prompt, /including command or excerpt/);
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

test("JSON extraction tolerates a fenced repair response", () => {
  assert.deepEqual(extractJsonObject("```json\n{\"ok\":true}\n```"), { ok: true });
});
