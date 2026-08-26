import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

const promptDelay = Number(process.env.FAKE_PROMPT_DELAY_MS || 10);
let pendingReadPrompt = null;

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === "read-budget-1" && pendingReadPrompt) {
    const denied = Boolean(message.error);
    send({
      method: "session/update",
      params: {
        sessionId: pendingReadPrompt.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify({ read_denied: denied }) },
        },
      },
    });
    send({ id: pendingReadPrompt.promptId, result: { stopReason: "end_turn" } });
    pendingReadPrompt = null;
    return;
  }
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "Fake ACP", version: "1.0.0" },
        authMethods: [],
      },
    });
    return;
  }
  if (message.method === "session/new") {
    send({
      id: message.id,
      result: {
        sessionId: "session-1",
        configOptions: [
          { id: "model", name: "Model", currentValue: "fake", options: [] },
          { id: "thinking", name: "Thinking", currentValue: "low", options: [] },
        ],
      },
    });
    return;
  }
  if (message.method === "session/set_config_option") {
    send({ id: message.id, result: { configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    if (process.env.FAKE_READ_REQUEST) {
      pendingReadPrompt = { promptId: message.id, sessionId: message.params.sessionId };
      send({
        id: "read-budget-1",
        method: "fs/read_text_file",
        params: {
          path: process.env.FAKE_READ_REQUEST,
          line: 1,
          limit: 1,
        },
      });
      return;
    }
    if (process.env.FAKE_PROMPT_ERROR) {
      const error = JSON.parse(process.env.FAKE_PROMPT_ERROR);
      send({ id: message.id, error });
      return;
    }
    if (process.env.FAKE_REVIEW_RESPONSE) {
      const prompt = message.params?.prompt?.[0]?.text ?? "";
      const runId = prompt.match(/Run id: ([^.]+)\./)?.[1];
      const mode = prompt.match(/Mode: ([^.]+)\./)?.[1];
      const output = {
        schema_version: 1,
        mode,
        run_id: runId,
        summary: "Kimi review complete",
        findings: [],
        ac_coverage: [{ ac_id: "AC-001", status: "COVERED", test_refs: ["spec.md"] }],
        next_actions: [],
        external_research: { status: "NOT_REQUESTED", sources: [] },
        context: { completeness: "FULL", omissions: [], compacted: false },
      };
      send({
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: JSON.stringify(output) },
          },
        },
      });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (Object.hasOwn(process.env, "FAKE_RESPONSE_TEXT")) {
      send({
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: process.env.FAKE_RESPONSE_TEXT },
          },
        },
      });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (process.env.FAKE_AUTO_TOOL_UPDATES) {
      const updates = JSON.parse(process.env.FAKE_AUTO_TOOL_UPDATES);
      for (const update of updates) {
        send({
          method: "session/update",
          params: { sessionId: "session-1", update },
        });
      }
      setTimeout(() => {
        send({
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: '{"ok":true}' },
            },
          },
        });
        send({ id: message.id, result: { stopReason: "end_turn" } });
      }, promptDelay);
      return;
    }
    if (process.env.FAKE_AUTO_TOOL_TITLE) {
      const rawInput = process.env.FAKE_AUTO_TOOL_RAW_INPUT
        ? JSON.parse(process.env.FAKE_AUTO_TOOL_RAW_INPUT)
        : undefined;
      send({
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "auto-tool-1",
            kind: process.env.FAKE_AUTO_TOOL_KIND || "other",
            title: process.env.FAKE_AUTO_TOOL_TITLE,
            status: "in_progress",
            ...(process.env.FAKE_AUTO_TOOL_PATH ? { locations: [{ path: process.env.FAKE_AUTO_TOOL_PATH }] } : {}),
            ...(rawInput ? { rawInput } : {}),
          },
        },
      });
      setTimeout(() => {
        send({
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: '{"ok":true}' },
            },
          },
        });
        send({ id: message.id, result: { stopReason: "end_turn" } });
      }, promptDelay);
      return;
    }
    send({
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1", kind: "edit", title: "Write a file" },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    setTimeout(() => {
      send({
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: '{"ok":true}' },
          },
        },
      });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }, promptDelay);
  }
});
