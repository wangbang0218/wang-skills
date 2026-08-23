import assert from "node:assert/strict";
import test from "node:test";

import { mergeHookConfig, removeHookConfig } from "../lib/hook-config.mjs";

test("hook setup preserves existing hooks and is idempotent", () => {
  const existing = {
    description: "existing",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "node existing.mjs" }] }],
    },
  };
  const once = mergeHookConfig(existing, "node project-hook.mjs");
  const twice = mergeHookConfig(once, "node project-hook.mjs");

  assert.deepEqual(twice, once);
  assert.equal(twice.hooks.Stop.length, 1);
  assert.equal(twice.hooks.SessionStart.length, 1);
  assert.equal(twice.hooks.SessionStart[0].matcher, "^(startup|resume|clear|compact)$");
});

test("hook removal deletes only this skill's tagged entry", () => {
  const configured = mergeHookConfig(
    { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "node other.mjs" }] }] } },
    "node project-hook.mjs",
  );
  const removed = removeHookConfig(configured);

  assert.equal(removed.hooks.SessionStart.length, 1);
  assert.equal(removed.hooks.SessionStart[0].matcher, "startup");
});

test("hook setup upgrades the owned command to the current Volta-backed command", () => {
  const configured = {
    hooks: {
      SessionStart: [{
        hooks: [{
          type: "command",
          command: "node old-hook.mjs",
          statusMessage: "implement-with-kimi context recovery",
        }],
      }],
    },
  };
  const upgraded = mergeHookConfig(configured, "volta run node new-hook.mjs");
  assert.equal(upgraded.hooks.SessionStart[0].hooks[0].command, "volta run node new-hook.mjs");
});
