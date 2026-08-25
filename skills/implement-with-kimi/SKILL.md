---
name: implement-with-kimi
description: "Implement one documented project module at a time with deterministic test-first state gates and one explicitly authorized read-only final audit by Kimi K3 1M or local Claude Code. Use when a user explicitly asks Codex to implement from a validated prepare-for-kimi package or persisted architecture/PRD/module specification, preserve progress across compaction or resume, bind ACs and execution evidence to current file hashes, or audit completion. Do not invoke implicitly: the final audit can expose eligible worktree text to the selected reviewer and consume paid quota."
---

# Implement with an Audit-only Reviewer

Codex is the only writer and project-command executor. All workflow gates before the final audit are local and deterministic. The selected reviewer is read-only and may run only for an explicitly authorized `audit --execute-reviewer` or advisory `query --execute-reviewer`.

Resolve bundled paths relative to this `SKILL.md`. Require a Git worktree, Volta, and Node.js 18+. Run bundled Node commands with `volta run node`; never fall back to a system Node. Do not install, upgrade, log in, alter reviewer configuration, commit, or push unless separately requested.

## Start one module locally

1. Read the repository's applicable `AGENTS.md`, the module specification, and every declared authority document.
2. If an `implementation-package.json` exists, read [references/input-contract.md](references/input-contract.md) and run local `validate-package`. Continue only on exact `READY`.
3. Require stable `AC-###` acceptance criteria and one explicit reviewer choice: `kimi` or `claude-code`. Never infer a default.
4. Run local bootstrap:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs bootstrap \
  --spec docs/tasks/module.md \
  --reviewer kimi \
  --authority docs/architecture.md \
  --goal active
```

Use `--reviewer claude-code` when selected. Bootstrap records the fixed per-run choice, authority hashes, baseline, and `semantic_review=PENDING`; it does not preflight or call either reviewer. `select-reviewer` may fill a missing migrated selection or confirm the same choice, but cannot switch an active run to another reviewer.

The specification is normative. The paired `module.state.md` is managed execution state; never edit its managed block and always preserve User notes.

## Follow local test-first gates

Read [references/workflow.md](references/workflow.md) before implementation and keep this order:

1. Record AC-to-test paths with repeated `--test-map AC-001=path/to/test`.
2. For new behavior, record `red-planned`, execute the narrow test, then record matching non-zero `red-observed --test <path>`. For pure refactors, record exit-zero `baseline-green-observed --test <path>`.
3. Run local `validate-tests`. The one-release `review-tests` alias returns `LOCAL_ONLY` and never contacts a reviewer.
4. Record `implementation-started`, implement narrowly, then record exit-zero `green-observed` for every mapped test path.
5. Record each required verification separately. Only current evidence reaches `VERIFIED`.

The CLI records commands and evidence; it never executes project tests. Environment, dependency, permission, timeout, and infrastructure failures are not valid Red.

## Preview, ask, then audit

At `VERIFIED`, run a preview without reviewer execution:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs review-preview \
  --mode audit \
  --spec docs/tasks/module.md \
  --authority docs/architecture.md
```

Running `audit` without `--execute-reviewer` returns the same `REVIEW_READY` preview and leaves state unchanged. Show the user the complete preview, including reviewer, initial token estimate and budget, mandatory paths, run delta, read/web permissions, two-submission cap, lack of a USD cap, and the warning that 700K covers only the initial pack while Claude follow-up repository reads have no hard token ceiling.

Obtain a new, explicit user authorization for that preview. The original Skill invocation or reviewer choice is not execution authorization. Only after approval may Codex run:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs audit \
  --spec docs/tasks/module.md \
  --authority docs/architecture.md \
  --execute-reviewer
```

`READY` or `WARNING` completes the run and sets `semantic_review=AUDITED`. `BLOCKED` or `CONFLICT` does not. Configuration, quota, Schema, Evidence, Policy, context, cancellation, or `STALE` failures never advance state and have no local bypass.

Use `query --question ...` only for optional advice. Preview and explicitly authorize it in the same way. A query records its result and usage but cannot alter milestones, unresolved findings, or `semantic_review`.

Read [references/context-selection.md](references/context-selection.md), [references/reviewer-selection.md](references/reviewer-selection.md), and [references/kimi-protocol.md](references/kimi-protocol.md) before executing a reviewer.

## Recover and protect scope

`rehydrate`, `resume`, and Hook recovery are local. They check authority, mapped-test hashes, run-scoped fingerprints, and the next legal step without calling a reviewer. Run `rehydrate` after compaction, clear, resume, or material uncertainty. Use `inspect --finding <id>` to validate and retrieve a retained current or legacy raw finding.

- Implement exactly one module per run and allow one active writer per worktree.
- Preserve pre-existing dirty work; never stash, revert, overwrite, commit, or push automatically.
- Start a new run when the specification or authority set/content changes.
- A mapped test change after `TESTS_VALIDATED` rolls back to the test-evidence stage. Other implementation changes after Green, verification, or audit roll back to `IMPLEMENTING`.
- Use `suspend --reason ...` before switching modules and local `resume` when returning.
- Offer `setup-hook` only after explicit approval; read [references/codex-hooks.md](references/codex-hooks.md) first.

Read [references/state-schema.md](references/state-schema.md) for v4 lifecycle and migration, and [references/verification.md](references/verification.md) before modifying or validating this Skill.
