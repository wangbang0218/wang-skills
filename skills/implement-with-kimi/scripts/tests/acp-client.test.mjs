import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AcpClient } from "../lib/acp-client.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(testDirectory, "fixtures/fake-acp.mjs");

test("ACP client negotiates, selects model/effort, streams JSON, and denies writes", async () => {
  const denied = [];
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgent],
    cwd: testDirectory,
    startupIdleMs: 2_000,
    promptIdleMs: 2_000,
    onPolicyViolation: (violation) => denied.push(violation),
  });

  try {
    const initialized = await client.initialize();
    assert.equal(initialized.protocolVersion, 1);

    const session = await client.newSession();
    await client.setConfigOption(session.sessionId, "model", "kimi-code/k3");
    await client.setConfigOption(session.sessionId, "thinking", "high");

    const response = await client.prompt(session.sessionId, "return JSON");
    assert.equal(response.stopReason, "end_turn");
    assert.deepEqual(JSON.parse(response.text), { ok: true });
    assert.equal(denied.length, 1);
    assert.equal(denied[0].kind, "edit");
  } finally {
    await client.close();
  }
});

test("ACP client permits Kimi WebSearch and FetchURL despite their ACP other kind", async () => {
  for (const title of ["WebSearch", "FetchURL"]) {
    const denied = [];
    const client = new AcpClient({
      command: process.execPath,
      args: [fakeAgent],
      cwd: testDirectory,
      env: { ...process.env, FAKE_AUTO_TOOL_TITLE: title },
      startupIdleMs: 2_000,
      promptIdleMs: 2_000,
      onPolicyViolation: (violation) => denied.push(violation),
    });
    try {
      await client.initialize();
      const session = await client.newSession();
      const response = await client.prompt(session.sessionId, "return JSON");
      assert.deepEqual(JSON.parse(response.text), { ok: true });
      assert.equal(denied.length, 0);
    } finally {
      await client.close();
    }
  }
});

test("ACP client rejects any other auto-approved tool", async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgent],
    cwd: testDirectory,
    env: { ...process.env, FAKE_AUTO_TOOL_TITLE: "Agent" },
    startupIdleMs: 2_000,
    promptIdleMs: 2_000,
  });
  try {
    await client.initialize();
    const session = await client.newSession();
    await assert.rejects(client.prompt(session.sessionId, "return JSON"), (error) => error.kind === "POLICY_VIOLATION");
  } finally {
    await client.close();
  }
});

test("ACP client rejects a streamed Read location outside the repository", async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgent],
    cwd: testDirectory,
    env: {
      ...process.env,
      FAKE_AUTO_TOOL_TITLE: "Read",
      FAKE_AUTO_TOOL_KIND: "read",
      FAKE_AUTO_TOOL_PATH: path.resolve(testDirectory, "../../../../outside.txt"),
    },
    startupIdleMs: 2_000,
    promptIdleMs: 2_000,
  });
  try {
    await client.initialize();
    const session = await client.newSession();
    await assert.rejects(client.prompt(session.sessionId, "return JSON"), (error) => error.kind === "POLICY_VIOLATION");
  } finally {
    await client.close();
  }
});

test("ACP cancellation has a short grace period instead of waiting for idle timeout", async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgent],
    cwd: testDirectory,
    env: {
      ...process.env,
      FAKE_AUTO_TOOL_TITLE: "FetchURL",
      FAKE_PROMPT_DELAY_MS: "5000",
    },
    startupIdleMs: 2_000,
    promptIdleMs: 20_000,
  });
  try {
    await client.initialize();
    const session = await client.newSession();
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.prompt(session.sessionId, "return JSON", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.kind === "CANCELLED");
    assert.ok(Date.now() - started < 3_000);
  } finally {
    await client.close();
  }
});
