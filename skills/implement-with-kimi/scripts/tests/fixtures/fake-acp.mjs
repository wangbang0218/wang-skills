import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

const promptDelay = Number(process.env.FAKE_PROMPT_DELAY_MS || 10);

input.on("line", (line) => {
  const message = JSON.parse(line);
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
    if (process.env.FAKE_AUTO_TOOL_TITLE) {
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
