#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { PackageValidationError, validateImplementationPackage } from "./lib/document-package.mjs";

main().catch((error) => {
  const payload = {
    schema_version: 1,
    status: "ERROR",
    error: { kind: error.kind ?? "GENERAL", message: error.message },
    issues: error.issues ?? [],
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = error instanceof PackageValidationError ? 2 : 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.package) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const repoRoot = getRepoRoot(process.cwd());
  const result = await validateImplementationPackage(repoRoot, options.package, { specPath: options.spec ?? null });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function getRepoRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw typedError("CONFIG", "prepare-for-kimi validation requires a Git worktree.");
  return result.stdout.trim();
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (!["--package", "--spec"].includes(token)) throw typedError("USAGE", `Unknown argument: ${token}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw typedError("USAGE", `${token} requires a value.`);
    options[token.slice(2)] = value;
  }
  return options;
}

function typedError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function usage() {
  return `prepare-for-kimi package validator

Usage:
  validate_package.mjs --package <implementation-package.json> [--spec <module.md>]

This command reads repository files only. It never calls Kimi.`;
}
