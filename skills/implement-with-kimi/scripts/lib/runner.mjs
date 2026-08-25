import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AcpClient } from "./acp-client.mjs";
import { validateLocalEvidence } from "./evidence.mjs";
import { buildKimiPrompt, extractJsonObject } from "./prompt.mjs";
import { repositoryFingerprint } from "./repository.mjs";
import { buildCapsule, validateKimiEnvelope } from "./schema.mjs";

const EFFORT_BY_MODE = {
  audit: "max",
  query: "max",
};

export function createSubmissionBudget(max = 2) {
  return { used: 0, max };
}

export async function runKimiNode({
  repoRoot,
  mode,
  runId,
  specPath,
  contextPack,
  question,
  acIds,
  preflight,
  signal,
  submissionBudget = createSubmissionBudget(),
  estimatedInitialTokens = null,
  onInvocation = async () => {},
  onProgress = () => {},
}) {
  const effort = EFFORT_BY_MODE[mode];
  if (!effort) throw new Error(`Unsupported Kimi mode: ${mode}`);
  const diagnostics = await mkdtemp(path.join(tmpdir(), `implement-with-kimi-${mode}-`));
  await writeFile(path.join(diagnostics, "context-pack.txt"), contextPack, "utf8");
  const before = repositoryFingerprint(repoRoot);
  let repairError = null;

  while (submissionBudget.used < submissionBudget.max) {
    const client = new AcpClient({
      command: preflight.binary,
      args: ["acp"],
      cwd: repoRoot,
      onProgress,
      onPolicyViolation: (violation) => onProgress(
        `POLICY_VIOLATION ${violation.kind} (${violation.method || "unknown"}): ${violation.reason}`,
      ),
    });
    let invocation = null;
    let rawResultRef = diagnostics;
    let startedAtMs = null;
    try {
      const initialized = await client.initialize();
      if (initialized.protocolVersion !== 1) throw typedError("PROTOCOL", `Unsupported ACP protocol version: ${initialized.protocolVersion}`);
      const session = await client.newSession();
      await configureSession(client, session, preflight.model_alias, effort);

      const attempt = ++submissionBudget.used;
      startedAtMs = Date.now();
      invocation = {
        invocation_id: randomUUID(),
        mode,
        reviewer: "kimi",
        attempt,
        started_at: new Date(startedAtMs).toISOString(),
        finished_at: null,
        status: "RUNNING",
        diagnostic_ref: diagnostics,
        usage: kimiUsage({ estimatedInitialTokens, extraReadTokens: 0 }),
      };
      await onInvocation({ phase: "started", entry: invocation });
      onProgress(`Kimi reviewer; mode ${mode}; effort ${effort}; prompt submission ${attempt}/${submissionBudget.max}`);

      const prompt = buildKimiPrompt({ mode, runId, specPath, contextPack, question, effort, repairError });
      const response = await client.prompt(session.sessionId, prompt, { signal });
      rawResultRef = path.join(diagnostics, `raw-response-${attempt}.txt`);
      await writeFile(rawResultRef, response.text, "utf8");

      let parsed;
      try {
        parsed = extractJsonObject(response.text);
        parsed.raw_result_ref = rawResultRef;
        parsed.model = {
          alias: preflight.model_alias,
          model: preflight.model,
          max_context_size: preflight.max_context_size,
          requested_effort: effort,
        };
        parsed = validateKimiEnvelope(parsed, { mode, runId, acIds });
      } catch (error) {
        if (["KIMI_CONTEXT_COMPACTED", "REVIEWER_CONTEXT_COMPACTED"].includes(error.code)) {
          throw typedError("CONTEXT_COMPACTED", error.message);
        }
        throw typedError("SCHEMA_REPAIRABLE", error.message);
      }
      try {
        await validateEnvelopeEvidence(repoRoot, parsed);
      } catch (error) {
        throw typedError("EVIDENCE", error.message);
      }

      const after = repositoryFingerprint(repoRoot);
      if (after !== before) throw typedError("STALE", "Repository changed while Kimi was reviewing; discard this result and retry.");
      parsed.snapshot = { before, after, stale: false };
      parsed.attempts = submissionBudget.used;
      parsed.reviewer = "kimi";
      const finished = finishInvocation(invocation, {
        status: "SUCCEEDED",
        rawResultRef,
        startedAtMs,
        usage: kimiUsage({ estimatedInitialTokens, extraReadTokens: client.readTokens }),
      });
      await onInvocation({ phase: "finished", entry: finished });
      return { envelope: parsed, capsule: buildCapsule(parsed), diagnostics };
    } catch (rawError) {
      const error = classifyKimiError(rawError, signal);
      if (invocation) {
        const finished = finishInvocation(invocation, {
          status: "FAILED",
          rawResultRef,
          startedAtMs,
          usage: kimiUsage({ estimatedInitialTokens, extraReadTokens: client.readTokens }),
          error,
        });
        await onInvocation({ phase: "finished", entry: finished });
      }
      if (error.kind === "SCHEMA_REPAIRABLE" && submissionBudget.used < submissionBudget.max) {
        repairError = error.message;
        continue;
      }
      if (!error.kind && isTransientKimiError(error) && submissionBudget.used < submissionBudget.max) {
        await delay(500);
        continue;
      }
      if (error.kind === "SCHEMA_REPAIRABLE") throw typedError("SCHEMA", error.message);
      throw error;
    } finally {
      await client.close();
    }
  }
  throw typedError("RETRY_EXHAUSTED", "Reviewer prompt submission budget was exhausted.");
}

export async function configureSession(client, session, modelAlias, effort) {
  const options = Array.isArray(session.configOptions) ? session.configOptions : [];
  const model = findOption(options, ["model"]);
  if (!model) throw typedError("PROTOCOL", "Kimi ACP did not advertise a model configuration option.");
  await client.setConfigOption(session.sessionId, model.id, modelAlias);

  const thinking = findOption(options, ["thinking", "effort", "reasoning"]);
  if (!thinking) throw typedError("PROTOCOL", "Kimi ACP did not advertise a thinking/effort configuration option.");
  await client.setConfigOption(session.sessionId, thinking.id, effort);
}

function findOption(options, candidates) {
  return options.find((option) => {
    const haystack = `${option.id ?? ""} ${option.name ?? ""} ${option.category ?? ""}`.toLowerCase();
    return candidates.some((candidate) => haystack.includes(candidate));
  });
}

export async function validateEnvelopeEvidence(repoRoot, envelope) {
  let sequence = 0;
  for (const finding of envelope.findings) {
    for (const evidence of finding.evidence) {
      evidence.evidence_id ??= `E-${String(++sequence).padStart(4, "0")}`;
      if (evidence.path) {
        await validateLocalEvidence(repoRoot, evidence);
      } else if (evidence.url) {
        validateExternalEvidence(evidence);
      } else {
        throw new Error(`Evidence ${evidence.evidence_id} has neither path nor url.`);
      }
    }
  }
  for (const source of envelope.external_research.sources) validateExternalEvidence(source);
}

function validateExternalEvidence(evidence) {
  let url;
  try {
    url = new URL(evidence.url);
  } catch {
    throw new Error(`External evidence URL is invalid: ${evidence.url}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("External evidence must use HTTP or HTTPS.");
  for (const key of ["title", "accessed_at", "claim"]) {
    if (typeof evidence[key] !== "string" || !evidence[key]) throw new Error(`External evidence is missing ${key}.`);
  }
}

export function isTransientKimiError(error) {
  const value = `${error.code ?? ""} ${error.message ?? ""}`;
  if (/quota (?:is )?exhausted|billing cycle quota|monthly quota|rolling quota/i.test(value)) return false;
  return /429|5\d\d|network|ECONN|EAI_AGAIN|temporar/i.test(value);
}

function classifyKimiError(error, signal) {
  if (signal?.aborted) return typedError("CANCELLED", "Kimi review was cancelled.");
  if (error.kind) return error;
  if (error.code === -32000) return typedError("CONFIG", "Kimi authentication is required; run kimi login first.");
  if (isContextOversize(error)) return typedError("CONTEXT_OVERSIZE", error.message);
  return error;
}

function isContextOversize(error) {
  return /context.{0,40}(too (?:large|long)|exceed|maximum|limit|overflow)|too many tokens|maximum context|token limit/i.test(
    `${error.code ?? ""} ${error.message ?? ""}`,
  );
}

function kimiUsage({ estimatedInitialTokens, extraReadTokens }) {
  return {
    source: "unavailable",
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    total_cost_usd: null,
    estimated_initial_tokens: estimatedInitialTokens,
    extra_read_tokens: extraReadTokens,
    provider_report: null,
  };
}

function finishInvocation(invocation, { status, rawResultRef, startedAtMs, usage, error = null }) {
  return {
    ...invocation,
    finished_at: new Date().toISOString(),
    status,
    diagnostic_ref: rawResultRef,
    duration_ms: Date.now() - startedAtMs,
    usage,
    ...(error ? { error: { kind: error.kind ?? "GENERAL", message: error.message } } : {}),
  };
}

function typedError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
