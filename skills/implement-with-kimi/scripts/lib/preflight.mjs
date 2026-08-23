import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_CONTEXT_SIZE = 1_048_576;
const REQUIRED_EFFORTS = ["low", "high", "max"];

export async function preflightKimi({ env = process.env } = {}) {
  assertSupportedNode();
  assertVoltaNode({ voltaHome: env.VOLTA_HOME });

  const binary = await resolveKimiBinary(env);
  const versionResult = run(binary, ["--version"], env);
  if (versionResult.status !== 0) throw codedError("CONFIG", `Kimi version check failed: ${versionResult.stderr.trim()}`);

  const doctor = run(binary, ["doctor", "config"], env);
  if (doctor.status !== 0) throw codedError("CONFIG", `Kimi configuration is invalid: ${doctor.stderr.trim() || doctor.stdout.trim()}`);

  const providers = run(binary, ["provider", "list", "--json"], env);
  if (providers.status !== 0) throw codedError("CONFIG", `Unable to inspect Kimi models: ${providers.stderr.trim()}`);
  let catalog;
  try {
    catalog = JSON.parse(providers.stdout);
  } catch (error) {
    throw codedError("CONFIG", `Kimi provider catalog is not valid JSON: ${error.message}`);
  }
  const model = selectK3Model(catalog, env.KIMI_MODEL);
  return {
    binary,
    version: versionResult.stdout.trim(),
    model_alias: model.alias,
    model: model.config.model,
    max_context_size: model.config.maxContextSize,
    support_efforts: model.config.supportEfforts,
  };
}

export function assertSupportedNode(version = process.versions.node) {
  const major = Number(String(version).split(".")[0]);
  if (!Number.isInteger(major) || major < 18) {
    throw codedError("CONFIG", "implement-with-kimi requires Node.js 18 or newer.");
  }
}

export function assertVoltaNode({ execPath = process.execPath, voltaHome = process.env.VOLTA_HOME } = {}) {
  const executable = path.resolve(execPath);
  if (typeof voltaHome === "string" && voltaHome.trim() !== "") {
    const voltaNodeRoot = path.resolve(voltaHome, "tools", "image");
    const relative = path.relative(voltaNodeRoot, executable);
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
    throw codedError("CONFIG", `implement-with-kimi requires a Volta-managed Node executable. Run commands as \`volta run node ...\`; received ${execPath}.`);
  }
  const imageMarker = `${path.sep}tools${path.sep}image${path.sep}node${path.sep}`;
  if (executable.includes(imageMarker)) return;
  throw codedError("CONFIG", `implement-with-kimi requires a Volta-managed Node executable. Run commands as \`volta run node ...\`; received ${execPath}.`);
}

export function selectK3Model(catalog, requestedAlias) {
  const models = catalog?.models;
  if (!models || typeof models !== "object") throw codedError("CONFIG", "Kimi provider catalog has no models.");
  let alias = requestedAlias || "kimi-code/k3";
  let config = models[alias];
  if (!config && !requestedAlias) {
    const matches = Object.entries(models).filter(([, value]) => value?.model === "k3");
    if (matches.length === 1) [alias, config] = matches[0];
  }
  if (!config) throw codedError("CONFIG", `Required K3 model alias is not configured: ${alias}`);
  if (config.model !== "k3" || Number(config.maxContextSize) < REQUIRED_CONTEXT_SIZE) {
    throw codedError("CONFIG", `${alias} is not K3 with a 1,048,576-token context window.`);
  }
  const efforts = Array.isArray(config.supportEfforts) ? config.supportEfforts : [];
  const missing = REQUIRED_EFFORTS.filter((effort) => !efforts.includes(effort));
  if (missing.length > 0) throw codedError("CONFIG", `${alias} does not support required efforts: ${missing.join(", ")}`);
  return { alias, config };
}

async function resolveKimiBinary(env) {
  if (env.KIMI_BIN) {
    if (!path.isAbsolute(env.KIMI_BIN)) throw codedError("CONFIG", "KIMI_BIN must be an absolute path.");
    await assertExecutable(env.KIMI_BIN);
    return env.KIMI_BIN;
  }
  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "kimi.exe" : "kimi");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw codedError("CONFIG", "Kimi executable was not found. Set KIMI_BIN to an absolute path or add kimi to PATH.");
}

async function assertExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
  } catch {
    throw codedError("CONFIG", `KIMI_BIN is not executable: ${filePath}`);
  }
}

function run(binary, args, env) {
  return spawnSync(binary, args, { encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 });
}

function codedError(code, message) {
  const error = new Error(message);
  error.kind = code;
  return error;
}
