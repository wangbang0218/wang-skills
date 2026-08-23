import { constants } from "node:fs";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { buildReviewerPrompt, extractJsonObject } from "./prompt.mjs";
import { repositoryFingerprint } from "./repository.mjs";
import { buildCapsule, REVIEWER_OUTPUT_SCHEMA, validateReviewerEnvelope } from "./schema.mjs";
import { validateEnvelopeEvidence } from "./runner.mjs";
import { assertSupportedNode, assertVoltaNode } from "./preflight.mjs";

const REQUIRED_CLAUDE_FLAGS = [
  "--safe-mode",
  "--no-session-persistence",
  "--json-schema",
  "--permission-mode",
  "--tools",
  "--allowedTools",
  "--disallowedTools",
  "--effort",
];

export async function preflightClaude({ env = process.env } = {}) {
  assertSupportedNode();
  assertVoltaNode({ voltaHome: env.VOLTA_HOME });
  const resolved = await resolveClaudeBinary(env);
  const { binary } = resolved;
  const version = spawnSync(binary, ["--version"], { env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (version.status !== 0) throw typedError("CONFIG", `Claude Code version check failed: ${version.stderr.trim()}`);
  const help = spawnSync(binary, ["--help"], { env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (help.status !== 0) throw typedError("CONFIG", `Unable to inspect Claude Code capabilities: ${help.stderr.trim()}`);
  const missing = REQUIRED_CLAUDE_FLAGS.filter((flag) => !help.stdout.includes(flag));
  if (missing.length > 0) throw typedError("CONFIG", `Claude Code lacks required isolation flags: ${missing.join(", ")}`);
  return {
    binary,
    binary_source: resolved.source,
    version: version.stdout.trim() || version.stderr.trim(),
  };
}

export async function runClaudeNode({
  repoRoot,
  mode,
  runId,
  specPath,
  contextPack,
  question,
  acIds,
  preflight,
  signal,
  onProgress = () => {},
}) {
  const diagnostics = await mkdtemp(path.join(tmpdir(), `implement-with-kimi-claude-${mode}-`));
  await writeFile(path.join(diagnostics, "context-pack.txt"), contextPack, "utf8");
  const before = repositoryFingerprint(repoRoot);
  let repairError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = buildReviewerPrompt({
      mode,
      runId,
      specPath,
      contextPack,
      question,
      effort: "max",
      repairError,
      reviewer: "local Claude Code using its configured default provider and model",
    });
    onProgress(`Claude Code reviewer; mode ${mode}; effort max; attempt ${attempt}`);
    const response = await invokeClaude({ binary: preflight.binary, cwd: repoRoot, prompt, signal });
    await writeFile(path.join(diagnostics, `raw-cli-${attempt}.json`), response.stdout, "utf8");
    if (response.status !== 0) {
      const combined = `${response.stderr}\n${response.stdout}`.trim();
      if (isContextFailure(combined)) throw typedError("CONTEXT_OVERSIZE", `Claude reviewer cannot process the required 1M context: ${combined}`);
      throw typedError("CLAUDE_FAILED", combined || `Claude Code exited with status ${response.status}.`);
    }

    try {
      const wrapper = JSON.parse(response.stdout);
      if (wrapper.is_error === true) throw new Error(wrapper.result || "Claude Code reported an error.");
      const candidate = wrapper.structured_output ?? extractJsonObject(wrapper.result);
      const rawResultPath = path.join(diagnostics, `raw-response-${attempt}.json`);
      await writeFile(rawResultPath, JSON.stringify(candidate, null, 2), "utf8");
      let envelope = validateReviewerEnvelope(candidate, { mode, runId, acIds });
      envelope.raw_result_ref = rawResultPath;
      envelope.model = {
        runner: "claude-code",
        cli_version: preflight.version,
        binary_path: preflight.binary,
        binary_source: preflight.binary_source ?? "provided",
        reported_models: Object.keys(wrapper.modelUsage ?? {}),
        requested_effort: "max",
        required_context_size: 1_048_576,
      };
      try {
        await validateEnvelopeEvidence(repoRoot, envelope);
      } catch (error) {
        throw typedError("EVIDENCE", error.message);
      }
      const after = repositoryFingerprint(repoRoot);
      if (after !== before) throw typedError("STALE", "Repository changed while Claude was reviewing; discard this result and retry.");
      envelope.snapshot = { before, after, stale: false };
      envelope.attempts = attempt;
      envelope.reviewer = "claude-code";
      return { envelope, capsule: buildCapsule(envelope), diagnostics };
    } catch (error) {
      if (error.kind || error.code === "REVIEWER_CONTEXT_COMPACTED" || isContextFailure(error.message)) {
        if (error.code === "REVIEWER_CONTEXT_COMPACTED" || isContextFailure(error.message)) {
          throw typedError("CONTEXT_OVERSIZE", "Claude reviewer compacted or truncated the required 1M context.");
        }
        throw error;
      }
      if (attempt === 1) {
        repairError = error.message;
        continue;
      }
      throw typedError("SCHEMA", error.message);
    }
  }
  throw typedError("SCHEMA", "Claude reviewer Schema repair budget was exhausted.");
}

export function claudeArguments() {
  const allowed = "Read,Grep,Glob,WebFetch,WebSearch";
  const denied = "Bash,Edit,Write,NotebookEdit,Agent,Skill,AskUserQuestion";
  return [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(REVIEWER_OUTPUT_SCHEMA),
    "--safe-mode",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--no-chrome",
    "--permission-mode", "dontAsk",
    "--tools", allowed,
    "--allowedTools", allowed,
    "--disallowedTools", denied,
    "--effort", "max",
  ];
}

export function claudeEnvironment(base = process.env) {
  return {
    ...base,
    DISABLE_COMPACT: "1",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
  };
}

async function invokeClaude({ binary, cwd, prompt, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, claudeArguments(), { cwd, env: claudeEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(typedError("CANCELLED", "Claude review was cancelled."));
      resolve({ status: code ?? 1, signal: exitSignal, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

export async function resolveClaudeBinary(env = process.env) {
  if (env.CLAUDE_BIN) {
    if (!path.isAbsolute(env.CLAUDE_BIN)) throw typedError("CONFIG", "CLAUDE_BIN must be an absolute path.");
    await assertExecutable(env.CLAUDE_BIN);
    return { binary: env.CLAUDE_BIN, source: "explicit" };
  }

  const voltaBinary = await resolveVoltaClaudeBinary(env);
  if (voltaBinary) return voltaBinary;

  let firstCandidate = null;
  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "claude.exe" : "claude");
    try {
      await access(candidate, constants.X_OK);
      firstCandidate = candidate;
      break;
    } catch {
      // Continue searching PATH.
    }
  }
  if (firstCandidate) {
    if (isNodeImageClaudeBinary(firstCandidate)) {
      throw typedError(
        "CONFIG",
        `Claude Code resolved to a Node image binary (${firstCandidate}), which may be stale. Set CLAUDE_BIN to an absolute Volta-managed Claude path or install Claude through Volta.`,
      );
    }
    return { binary: firstCandidate, source: "path" };
  }
  throw typedError("CONFIG", "Claude Code executable was not found. Set CLAUDE_BIN to an absolute path or add claude to PATH.");
}

async function resolveVoltaClaudeBinary(env) {
  const executableName = process.platform === "win32" ? "claude.exe" : "claude";
  const voltaHome = typeof env.VOLTA_HOME === "string" ? env.VOLTA_HOME.trim() : "";
  if (voltaHome) {
    const shim = path.join(voltaHome, "bin", executableName);
    if (await isExecutable(shim)) return { binary: shim, source: "volta-shim" };
  }

  const result = spawnSync("volta", ["which", "claude"], {
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status === 0) {
    const candidate = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (candidate && path.isAbsolute(candidate) && !isNodeImageClaudeBinary(candidate) && await isExecutable(candidate)) {
      return { binary: candidate, source: "volta-which" };
    }
  }
  return null;
}

async function isExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isNodeImageClaudeBinary(filePath) {
  const marker = `${path.sep}tools${path.sep}image${path.sep}node${path.sep}`;
  return path.resolve(filePath).includes(marker);
}

async function assertExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
  } catch {
    throw typedError("CONFIG", `CLAUDE_BIN is not executable: ${filePath}`);
  }
}

function isContextFailure(value) {
  return /prompt is too long|context.{0,40}(?:too (?:large|long)|exceed|maximum|limit|overflow)|conversation too long|auto.?compact|compaction|truncat|too many tokens|maximum context|token limit/i.test(String(value ?? ""));
}

function typedError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}
