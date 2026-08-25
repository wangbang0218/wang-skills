import assert from "node:assert/strict";
import test from "node:test";

import { buildKimiPrompt, extractJsonObject } from "../lib/prompt.mjs";

test("audit prompt declares read-only policy and exact evidence contract", () => {
  const prompt = buildKimiPrompt({
    mode: "audit",
    runId: "run-1",
    specPath: "spec.md",
    effort: "max",
    contextPack: "<context />",
  });
  assert.match(prompt, /Never write\/edit\/delete\/move/);
  assert.match(prompt, /Mode: audit/);
  assert.match(prompt, /BLOCKED means the current VERIFIED module cannot safely become COMPLETED/);
  assert.match(prompt, /repository-relative/);
  assert.match(prompt, /authoritative SHA-256/);
  assert.match(prompt, /byte-for-byte/);
  assert.match(prompt, /recorded execution logs.*metadata/i);
  assert.match(prompt, /schema_version must be 1/);
  assert.match(prompt, /next_actions must be an array of non-empty strings/);
});

test("query prompt is explicitly advisory and carries the focused question", () => {
  const prompt = buildKimiPrompt({
    mode: "query",
    runId: "run-query",
    specPath: "spec.md",
    effort: "max",
    question: "Does the API remain compatible?",
    contextPack: "<context />",
  });
  assert.match(prompt, /advisory query changes a milestone/i);
  assert.match(prompt, /Focused question: Does the API remain compatible\?/);
  assert.match(prompt, /final audit remains authoritative/i);
});

test("removed reviewer modes fail closed instead of rebuilding legacy prompts", () => {
  for (const mode of ["selector", "bootstrap", "review-tests", "rehydrate"]) {
    assert.throws(() => buildKimiPrompt({
      mode,
      runId: "run-legacy",
      specPath: "spec.md",
      effort: "max",
      contextPack: "<context />",
    }), new RegExp(`Unsupported prompt mode: ${mode}`));
  }
});

test("JSON extraction tolerates a fenced repair response", () => {
  assert.deepEqual(extractJsonObject("```json\n{\"ok\":true}\n```"), { ok: true });
});
