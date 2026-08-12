import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AcpClient } from "./acp-client.mjs";
import { validateLocalEvidence } from "./evidence.mjs";
import { buildKimiPrompt, extractJsonObject } from "./prompt.mjs";
import { repositoryFingerprint } from "./repository.mjs";
import { buildCapsule, validateKimiEnvelope } from "./schema.mjs";

const EFFORT_BY_MODE = {
  selector: "low",
  bootstrap: "high",
  "review-tests": "high",
  rehydrate: "high",
  audit: "max",
  query: "high",
};

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
  onProgress = () => {},
}) {
  const effort = EFFORT_BY_MODE[mode];
  if (!effort) throw new Error(`Unsupported Kimi mode: ${mode}`);
  const diagnostics = await mkdtemp(path.join(tmpdir(), `implement-with-kimi-${mode}-`));
  await writeFile(path.join(diagnostics, "context-pack.txt"), contextPack, "utf8");
  const before = repositoryFingerprint(repoRoot);
  let transientRetries = 0;
  let schemaRepairUsed = false;
  let repairError = null;
  let totalAttempts = 0;

  while (totalAttempts < 4) {
    totalAttempts += 1;
    const prompt = buildKimiPrompt({ mode, runId, specPath, contextPack, question, effort, repairError });
    const client = new AcpClient({
      command: preflight.binary,
      args: ["acp"],
      cwd: repoRoot,
      onProgress,
      onPolicyViolation: (violation) => onProgress(
        `POLICY_VIOLATION ${violation.kind} (${violation.method || "unknown"}): ${violation.reason}`,
      ),
    });
    try {
      const initialized = await client.initialize();
      if (initialized.protocolVersion !== 1) throw typedError("PROTOCOL", `Unsupported ACP protocol version: ${initialized.protocolVersion}`);
      const session = await client.newSession();
      await configureSession(client, session, preflight.model_alias, effort);
      const response = await client.prompt(session.sessionId, prompt, { signal });
      await writeFile(path.join(diagnostics, `raw-response-${totalAttempts}.txt`), response.text, "utf8");

      let parsed;
      try {
        parsed = extractJsonObject(response.text);
        parsed.raw_result_ref = path.join(diagnostics, `raw-response-${totalAttempts}.txt`);
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
        if (!schemaRepairUsed) {
          schemaRepairUsed = true;
          repairError = error.message;
          continue;
        }
        throw typedError("SCHEMA", error.message);
      }
      try {
        await validateEnvelopeEvidence(repoRoot, parsed);
      } catch (error) {
        throw typedError("EVIDENCE", error.message);
      }

      const after = repositoryFingerprint(repoRoot);
      if (after !== before) throw typedError("STALE", "Repository changed while Kimi was reviewing; discard this result and retry.");
      parsed.snapshot = { before, after, stale: false };
      parsed.attempts = totalAttempts;
      return { envelope: parsed, capsule: buildCapsule(parsed), diagnostics };
    } catch (error) {
      if (signal?.aborted) throw typedError("CANCELLED", "Kimi review was cancelled.");
      if (["SCHEMA", "EVIDENCE", "STALE", "POLICY_VIOLATION", "PROTOCOL", "CONTEXT_COMPACTED", "CONTEXT_OVERSIZE"].includes(error.kind)) throw error;
      if (error.code === -32000) throw typedError("CONFIG", "Kimi authentication is required; run kimi login first.");
      if (isContextOversize(error)) throw typedError("CONTEXT_OVERSIZE", error.message);
      if (isTransientKimiError(error) && transientRetries < 2) {
        transientRetries += 1;
        await delay(500 * 2 ** (transientRetries - 1));
        continue;
      }
      throw error;
    } finally {
      await client.close();
    }
  }
  throw typedError("RETRY_EXHAUSTED", "Kimi retry budget was exhausted.");
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

function isContextOversize(error) {
  return /context.{0,40}(too (?:large|long)|exceed|maximum|limit|overflow)|too many tokens|maximum context|token limit/i.test(
    `${error.code ?? ""} ${error.message ?? ""}`,
  );
}

function typedError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
