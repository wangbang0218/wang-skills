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
});

test("JSON extraction tolerates a fenced repair response", () => {
  assert.deepEqual(extractJsonObject("```json\n{\"ok\":true}\n```"), { ok: true });
});
