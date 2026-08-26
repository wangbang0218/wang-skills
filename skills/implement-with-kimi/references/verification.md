# Verification

## Local deterministic suite

Run from the repository root:

```bash
volta run node --test skills/implement-with-kimi/scripts/tests/*.test.mjs
```

The suite must use fake Kimi/Claude processes and cover:

- every local stage makes zero reviewer calls;
- Red, pure-refactor baseline Green, AC/path mappings, all-path Green, and test-hash invalidation;
- v1, v2, and v3 migration to v4 plus `attach-test-map`;
- deterministic context order, ordinary mandatory overflow, Kimi-only large-run fallback, complete tracked deletion diff, full untracked/mapped-test bodies, 1M overflow, optional preview, and direct execution;
- query side-effect isolation;
- shared two-submission cap, Schema repair, context behavior, and no fallback;
- success/failure usage ledger for both reviewers;
- audit completion, blocking, superseded findings, and concurrent `STALE`;
- legacy raw-result `inspect`;
- Hook merge/removal and local recovery reminders;
- evidence hashes/excerpts, symlink boundary, capsule limits, and model capability checks.

No test may invoke a real paid reviewer.

## Syntax and Skill validation

Check every modified `.mjs` file:

```bash
volta run node --check <modified-file.mjs>
```

Then run:

```bash
uv run --no-project --with pyyaml \
  /Users/bang/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/implement-with-kimi

npx skills add . --list
git diff --check
```

Report exact commands, exit codes, and the meaningful pass/fail summary.

## Optional real reviewer smoke

Real reviewer checks consume quota. Run one only when provider smoke is part of the validation task; invoking the smoke is sufficient and does not require a separate preview approval. Use only a synthetic repository and never a proprietary near-1M payload by default.

One small audit/query smoke may verify actual model routing, context capability, read-only tools, Schema, evidence, usage reporting, fingerprint stability, and no session persistence. Do not treat CLI discovery, fake tests, or configuration output as proof of real provider behavior. Report real and skipped layers separately.
