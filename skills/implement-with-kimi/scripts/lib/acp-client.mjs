import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { estimateTokens } from "./context-pack.mjs";

const ALLOWED_TOOL_KINDS = new Set(["read", "search", "fetch", "think"]);
const ALLOWED_OTHER_TOOL_TITLES = new Set(["WebSearch", "FetchURL"]);

export class AcpClient {
  constructor({
    command,
    args = [],
    cwd,
    env = process.env,
    startupIdleMs = 30_000,
    promptIdleMs = 15 * 60_000,
    readBudgetTokens = 100_000,
    onProgress = () => {},
    onPolicyViolation = () => {},
  }) {
    if (!command) throw new Error("ACP command is required.");
    this.command = command;
    this.args = args;
    this.cwd = path.resolve(cwd);
    this.env = env;
    this.startupIdleMs = startupIdleMs;
    this.promptIdleMs = promptIdleMs;
    this.readBudgetTokens = readBudgetTokens;
    this.readTokens = 0;
    this.onProgress = onProgress;
    this.onPolicyViolation = onPolicyViolation;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.currentPrompt = null;
    this.policyViolations = 0;
    this.lastProgressSignature = null;
    this.lastProgressKind = null;
    this.lastProgressNoticeAt = 0;
    this.prohibitedAutoTool = null;
    this.toolCalls = new Map();
    this.deniedToolCalls = new Set();
  }

  async initialize() {
    this.#start();
    return this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "implement-with-kimi", version: "1.0.0" },
      },
      this.startupIdleMs,
    );
  }

  newSession() {
    return this.request("session/new", { cwd: this.cwd, mcpServers: [] }, this.startupIdleMs);
  }

  setConfigOption(sessionId, configId, value) {
    return this.request("session/set_config_option", { sessionId, configId, value }, this.startupIdleMs);
  }

  async prompt(sessionId, prompt, { signal } = {}) {
    if (this.currentPrompt) throw new Error("Only one ACP prompt may run at a time.");
    const { id, promise } = this.#beginRequest(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: prompt }] },
      this.promptIdleMs,
    );
    this.currentPrompt = { requestId: id, sessionId, chunks: [], signalHandler: null, cancelTimer: null };
    if (signal) {
      const handler = () => {
        this.cancel(sessionId, "Cancelled by user");
        if (!this.currentPrompt?.cancelTimer) {
          this.currentPrompt.cancelTimer = setTimeout(() => this.#forceCancelPrompt(), 1_000);
        }
      };
      this.currentPrompt.signalHandler = handler;
      if (signal.aborted) handler();
      else signal.addEventListener("abort", handler, { once: true });
    }
    try {
      const result = await promise;
      if (this.prohibitedAutoTool) {
        const error = new Error(`Kimi requested prohibited auto-approved tool: ${this.prohibitedAutoTool}`);
        error.kind = "POLICY_VIOLATION";
        throw error;
      }
      if (this.policyViolations >= 2) {
        const error = new Error("Kimi repeatedly requested prohibited tools.");
        error.kind = "POLICY_VIOLATION";
        throw error;
      }
      return { ...result, text: this.currentPrompt.chunks.join("") };
    } finally {
      if (signal && this.currentPrompt?.signalHandler) {
        signal.removeEventListener("abort", this.currentPrompt.signalHandler);
      }
      if (this.currentPrompt?.cancelTimer) clearTimeout(this.currentPrompt.cancelTimer);
      this.currentPrompt = null;
    }
  }

  cancel(sessionId, reason = "Cancelled") {
    if (!this.child) return;
    this.#send({ method: "session/cancel", params: { sessionId, reason } });
  }

  request(method, params, idleMs) {
    return this.#beginRequest(method, params, idleMs).promise;
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #start() {
    if (this.child) return;
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    const errors = readline.createInterface({ input: this.child.stderr });
    errors.on("line", (line) => this.#recordProgress(`stderr:${line}`, line));
    this.child.once("error", (error) => this.#rejectAll(error));
    this.child.once("exit", (code, signal) => {
      if (this.pending.size > 0) this.#rejectAll(new Error(`ACP process exited (${code ?? signal}).`));
    });
  }

  #beginRequest(method, params, idleMs) {
    if (!this.child) throw new Error("ACP client is not initialized.");
    const id = this.nextId++;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending = { id, method, idleMs, resolve: resolvePromise, reject: rejectPromise, timer: null };
    this.pending.set(id, pending);
    this.#resetTimer(pending);
    this.#send({ id, method, params });
    return { id, promise };
  }

  #send(message) {
    if (!this.child?.stdin.writable) throw new Error("ACP stdin is not writable.");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#rejectAll(new Error("ACP stdout contained non-JSON data."));
      return;
    }
    if (message.method && Object.hasOwn(message, "id")) {
      void this.#handleReverseRequest(message);
      return;
    }
    if (message.method === "session/update") {
      this.#handleSessionUpdate(message.params);
      return;
    }
    if (Object.hasOwn(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? "ACP request failed.");
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #handleSessionUpdate(params) {
    const update = params?.update;
    if (!update || !this.currentPrompt || params.sessionId !== this.currentPrompt.sessionId) return;
    const signature = JSON.stringify(update);
    this.#recordProgress(signature, update.sessionUpdate);
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const id = update.toolCallId ?? update.tool_call_id;
      const previous = id ? this.toolCalls.get(id) ?? {} : {};
      const toolCall = { ...previous, ...update };
      if (id) this.toolCalls.set(id, toolCall);
      this.#inspectToolCall(toolCall);
    }
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      this.currentPrompt.chunks.push(update.content.text ?? "");
    }
  }

  #inspectToolCall(toolCall) {
    const toolCallId = toolCall.toolCallId ?? toolCall.tool_call_id ?? "unknown";
    if (this.deniedToolCalls.has(toolCallId)) return;
    const kind = toolCall.kind ?? "other";
    const title = String(toolCall.title ?? "");
    const outsideRepositoryRead = this.#hasOutsideRepositoryRead(toolCall);
    const permissionControlled = ["edit", "delete", "move", "execute"].includes(kind);
    const allowedNamedOther = kind === "other" && ALLOWED_OTHER_TOOL_TITLES.has(title);
    if (((!ALLOWED_TOOL_KINDS.has(kind) && !allowedNamedOther) || outsideRepositoryRead) && !permissionControlled) {
      const reason = outsideRepositoryRead
        ? "Read/search location is outside the repository."
        : "Tool is outside the read/search/fetch policy.";
      this.deniedToolCalls.add(toolCallId);
      this.#policyViolation({ kind, method: title || "tool_call", reason });
      this.prohibitedAutoTool = title || kind;
      if (this.currentPrompt) this.cancel(this.currentPrompt.sessionId, "Prohibited auto-approved Kimi tool");
    }
  }

  #hasOutsideRepositoryRead(toolCall) {
    if (!["read", "search"].includes(toolCall.kind)) return false;
    const locations = Array.isArray(toolCall.locations) ? [...toolCall.locations] : [];
    if (typeof toolCall.rawInput?.path === "string") {
      locations.push({ path: toolCall.rawInput.path });
    }
    return locations.some((location) => !this.#isRepositoryLocation(location));
  }

  #isRepositoryLocation(location) {
    let value = location?.path ?? location?.uri;
    if (typeof value !== "string" || !value) return true;
    try {
      if (value.startsWith("file:")) value = fileURLToPath(value);
    } catch {
      return false;
    }
    const root = realpathSync(this.cwd);
    const candidate = path.resolve(root, value);
    if (!isWithin(root, candidate)) return false;
    try {
      return isWithin(root, realpathSync(candidate));
    } catch {
      return true;
    }
  }

  async #handleReverseRequest(message) {
    try {
      if (message.method === "fs/read_text_file") {
        const result = await this.#readTextFile(message.params);
        this.#send({ id: message.id, result });
        return;
      }
      if (message.method === "fs/write_text_file") {
        this.#policyViolation({ kind: "edit", method: message.method, reason: "Kimi is read-only." });
        this.#send({ id: message.id, error: { code: -32601, message: "Kimi write access is disabled." } });
        return;
      }
      if (message.method === "session/request_permission") {
        this.#send({ id: message.id, result: this.#permissionResult(message.params) });
        return;
      }
      this.#send({ id: message.id, error: { code: -32601, message: `Unsupported client method: ${message.method}` } });
    } catch (error) {
      this.#send({ id: message.id, error: { code: -32001, message: error.message } });
    }
  }

  async #readTextFile(params) {
    const root = await realpath(this.cwd);
    const requested = path.resolve(root, params.path);
    if (!isWithin(root, requested)) throw new Error("Kimi cannot read outside the repository.");
    const actual = await realpath(requested);
    if (!isWithin(root, actual)) throw new Error("Kimi cannot read outside the repository.");
    const buffer = await readFile(actual);
    if (buffer.includes(0)) throw new Error("Kimi direct reads are limited to text files.");
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error("Kimi direct reads require UTF-8 text.");
    }
    if (Number.isInteger(params.line) || Number.isInteger(params.limit)) {
      const lines = content.split(/\r?\n/);
      const start = Math.max(0, (params.line ?? 1) - 1);
      const end = Number.isInteger(params.limit) ? start + params.limit : undefined;
      content = lines.slice(start, end).join("\n");
    }
    const tokens = estimateTokens(content);
    const smallExplicitRange = Number.isInteger(params.line) && Number.isInteger(params.limit) && tokens <= 4_000;
    if (this.readTokens + tokens > this.readBudgetTokens && !smallExplicitRange) {
      throw new Error("Kimi direct-read budget is exhausted; request a small explicit line range.");
    }
    this.readTokens += tokens;
    return { content };
  }

  #permissionResult(params) {
    const toolCall = params?.toolCall ?? {};
    const kind = toolCall.kind ?? "other";
    const title = String(toolCall.title ?? "");
    const outsideRepositoryRead = this.#hasOutsideRepositoryRead(toolCall);
    const allowed = !outsideRepositoryRead &&
      (ALLOWED_TOOL_KINDS.has(kind) || (kind === "other" && ALLOWED_OTHER_TOOL_TITLES.has(title)));
    const desiredKinds = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    const option = params?.options?.find((item) => desiredKinds.includes(item.kind));
    if (!allowed) {
      const reason = outsideRepositoryRead
        ? "Read/search location is outside the repository."
        : "Tool kind is not read-only.";
      this.#policyViolation({ kind, method: "session/request_permission", reason });
    }
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  #policyViolation(violation) {
    this.policyViolations += 1;
    this.onPolicyViolation({ ...violation, count: this.policyViolations });
    if (this.policyViolations >= 2 && this.currentPrompt) {
      this.cancel(this.currentPrompt.sessionId, "Repeated Kimi policy violation");
    }
  }

  #recordProgress(signature, value) {
    if (signature === this.lastProgressSignature) return;
    this.lastProgressSignature = signature;
    const now = Date.now();
    const noisyChunk = value === "agent_message_chunk" || value === "agent_thought_chunk";
    if (!noisyChunk || value !== this.lastProgressKind || now - this.lastProgressNoticeAt >= 30_000) {
      this.onProgress(value);
      this.lastProgressKind = value;
      this.lastProgressNoticeAt = now;
    }
    if (!this.currentPrompt) return;
    const pending = this.pending.get(this.currentPrompt.requestId);
    if (pending) this.#resetTimer(pending);
  }

  #resetTimer(pending) {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.pending.delete(pending.id);
      if (this.currentPrompt?.requestId === pending.id) this.cancel(this.currentPrompt.sessionId, "ACP idle timeout");
      pending.reject(new Error(`ACP ${pending.method} exceeded its idle timeout.`));
    }, pending.idleMs);
  }

  #forceCancelPrompt() {
    if (!this.currentPrompt) return;
    const pending = this.pending.get(this.currentPrompt.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(pending.id);
      const error = new Error("Kimi review was cancelled after the ACP shutdown grace period.");
      error.kind = "CANCELLED";
      pending.reject(error);
    }
    if (this.child?.exitCode === null) this.child.kill("SIGTERM");
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
