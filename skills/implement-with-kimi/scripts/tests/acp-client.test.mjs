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

test("ACP client permits fetch calls identified by their standard ACP kind", async () => {
  const denied = [];
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgent],
    cwd: testDirectory,
    env: {
      ...process.env,
      FAKE_AUTO_TOOL_TITLE: "Searching: current package version",
      FAKE_AUTO_TOOL_KIND: "fetch",
    },
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
});

test("ACP client permits Kimi 0.34 FetchURL from structured input after a lazy tool call", async () => {
  const denied = [];
  const url = "https://pub.dev/packages/flutter_secure_storage";
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgent],
    cwd: testDirectory,
    env: {
      ...process.env,
      FAKE_AUTO_TOOL_UPDATES: JSON.stringify([
        {
          sessionUpdate: "tool_call",
          toolCallId: "fetch-1",
          kind: "other",
          title: "FetchURL",
          status: "pending",
          content: [{ type: "content", content: { type: "text", text: '{"url":"https://pub.dev/pack' } }],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "fetch-1",
          status: "in_progress",
          content: [{ type: "content", content: { type: "text", text: `{"url":"${url}` } }],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "fetch-1",
          kind: "other",
          title: `Fetching: ${url}`,
          status: "in_progress",
          rawInput: { url },
        },
      ]),
    },
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
});

test("ACP client does not permit a dynamic fetch title without structured HTTP input", async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgent],
    cwd: testDirectory,
    env: {
      ...process.env,
      FAKE_AUTO_TOOL_TITLE: "Fetching: https://pub.dev/packages/flutter_secure_storage",
      FAKE_AUTO_TOOL_KIND: "other",
      FAKE_AUTO_TOOL_RAW_INPUT: JSON.stringify({ path: "fixtures" }),
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

test("ACP client rejects a provisional other tool that never supplies structured input", async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgent],
    cwd: testDirectory,
    env: {
      ...process.env,
      FAKE_AUTO_TOOL_UPDATES: JSON.stringify([
        {
          sessionUpdate: "tool_call",
          toolCallId: "unknown-1",
          kind: "other",
          title: "UnknownTool",
          status: "pending",
          content: [{ type: "content", content: { type: "text", text: '{"value":' } }],
        },
      ]),
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

test("ACP client permits repository code searches whose titles mention media words", async () => {
  const cases = [
    {
      title: "Searching for 'package:image' in packages/template_engine/lib",
      rawInput: { pattern: "package:image", path: "fixtures" },
    },
    {
      title: "Reading src/image_renderer.dart",
      rawInput: { path: "fixtures/image_renderer.dart" },
    },
  ];

  for (const item of cases) {
    const denied = [];
    const client = new AcpClient({
      command: process.execPath,
      args: [fakeAgent],
      cwd: testDirectory,
      env: {
        ...process.env,
        FAKE_AUTO_TOOL_TITLE: item.title,
        FAKE_AUTO_TOOL_KIND: "read",
        FAKE_AUTO_TOOL_RAW_INPUT: JSON.stringify(item.rawInput),
      },
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

test("ACP client rejects the media reader by its non-read ACP kind", async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgent],
    cwd: testDirectory,
    env: { ...process.env, FAKE_AUTO_TOOL_TITLE: "ReadMediaFile", FAKE_AUTO_TOOL_KIND: "other" },
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

test("ACP client rejects an outside rawInput.path when ACP omits locations", async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgent],
    cwd: testDirectory,
    env: {
      ...process.env,
      FAKE_AUTO_TOOL_TITLE: "Searching for 'secret' outside the repository",
      FAKE_AUTO_TOOL_KIND: "read",
      FAKE_AUTO_TOOL_RAW_INPUT: JSON.stringify({
        pattern: "secret",
        path: path.resolve(testDirectory, "../../../../outside"),
      }),
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

test("ACP client can hard-limit small explicit repository reads for a near-capacity large-run pack", async () => {
  for (const [allowSmallRangeOverBudget, expectedDenied] of [[true, false], [false, true]]) {
    const client = new AcpClient({
      command: process.execPath,
      args: [fakeAgent],
      cwd: testDirectory,
      env: {
        ...process.env,
        FAKE_READ_REQUEST: "fixtures/fake-acp.mjs",
      },
      readBudgetTokens: 1,
      allowSmallRangeOverBudget,
      startupIdleMs: 2_000,
      promptIdleMs: 2_000,
    });
    try {
      await client.initialize();
      const session = await client.newSession();
      const response = await client.prompt(session.sessionId, "read one explicit line");
      assert.equal(JSON.parse(response.text).read_denied, expectedDenied);
    } finally {
      await client.close();
    }
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
