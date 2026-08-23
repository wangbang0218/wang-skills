# Workflow

## Contents

- Authority and inputs
- Gate sequence
- Evidence recording
- Rehydration and rollback
- Completion

## Authority and inputs

Use this precedence:

1. Latest user-confirmed instruction after it has been persisted into project documentation.
2. Precedence explicitly declared by the project, including `AGENTS.md`.
3. Current module specification and declared package, architecture, PRD, and applicable UI documents.

If the project does not declare domain ownership or architecture-versus-PRD precedence, report a conflict instead of choosing one. The reviewer may suggest a correction but must not invent missing requirements. A version 1 implementation package uses `authority.md` to declare ownership and `implementation-package.json` to index the approved paths; see [input-contract.md](input-contract.md).

The module specification must be Markdown and contain non-empty sections for goal, scope, non-goals, dependencies, acceptance criteria, tests or exceptions, and related documents. Give every acceptance criterion a stable id such as `AC-001`. Pair the file with `<name>.state.md` in the same directory.

## Gate sequence

```text
NOT_STARTED
  -> BOOTSTRAP_READY
  -> TESTS_WRITTEN
  -> RED_CONFIRMED
  -> TESTS_REVIEWED
  -> IMPLEMENTING
  -> GREEN_CONFIRMED
  -> VERIFIED
  -> AUDITED
  -> COMPLETED
```

Any gate may enter `BLOCKED`. A successful retry restores the preceding state before continuing.

Review severity is relative to the current gate. At `review-tests`, a valid expected Red caused by missing production behavior is the evidence required to pass into `TESTS_REVIEWED`; that missing behavior is not a blocker and belongs to the later implementation/Green gates. Reserve `BLOCKED` for issues that prevent accepting the tests or making the next legal transition, such as an invalid or mismatched Red, a test defect, an authority conflict, or an uncovered mandatory test requirement without an approved exception. Do not require Green, implementation, verification, or audit evidence during test review.

New behavior, bug fixes, business rules, and public contracts require a valid Red. Pure refactors begin from an existing Green baseline. Documentation, generated output, build glue, styling-only work, and similar cases require an explicit test exception tied to AC ids.

Record each exception while the module is `BOOTSTRAP_READY`, before `tests-written`:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs record test-exception \
  --spec docs/tasks/module.md --ac AC-001 \
  --reason "Documentation-only acceptance criterion"
```

`tests-written` must cover every AC through either `--ac` or a recorded exception. When every AC is excepted, `review-tests` may review the exception evidence directly from `TESTS_WRITTEN`; it does not fabricate a Red result.

## Evidence recording

Use the repository's native tools to run tests. Then record evidence:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs record tests-written \
  --spec docs/tasks/module.md --ac AC-001 --ac AC-002

volta run node <skill-directory>/scripts/kimi_context.mjs record red-planned \
  --spec docs/tasks/module.md --ac AC-001 \
  --expected-failure "The new behavior is not implemented"

volta run node <skill-directory>/scripts/kimi_context.mjs record red-observed \
  --spec docs/tasks/module.md --command "pnpm test module" \
  --exit-code 1 --matched-expectation --log /tmp/module-red.log

volta run node <skill-directory>/scripts/kimi_context.mjs review-tests \
  --spec docs/tasks/module.md --authority docs/architecture.md

volta run node <skill-directory>/scripts/kimi_context.mjs record implementation-started \
  --spec docs/tasks/module.md

volta run node <skill-directory>/scripts/kimi_context.mjs record green-observed \
  --spec docs/tasks/module.md --command "pnpm test module" \
  --exit-code 0 --log /tmp/module-green.log

volta run node <skill-directory>/scripts/kimi_context.mjs record verification-observed \
  --spec docs/tasks/module.md --command "pnpm build" \
  --exit-code 0 --log /tmp/module-build.log
```

Record expected Red before running it. A non-zero exit counts only when it matches the expected missing behavior; dependency, configuration, timeout, permission, or environment failures do not count.

Successful logs retain command, exit code, size, hash, and a compact excerpt. Failed logs preserve a larger head-and-tail excerpt and mark transparent truncation. Unrun checks remain `UNKNOWN`.

## Rehydration and rollback

Use a fresh reviewer session for every `rehydrate`. Compare the repository fingerprint before and after review. Discard the result as `STALE` if the repository changed during the call.

Rehydration restores constraints, decisions, AC coverage, current stage, unresolved findings, and next actions. It cannot move forward. Re-evaluate persisted blockers against the current gate instead of repeating them solely because they appear in state: unfinished implementation at a pre-Green stage, including behavior proven missing by a valid Red, is expected work rather than a workflow blocker. If code or tests changed after Green, Verified, or Audit, roll back to `IMPLEMENTING` and rerun verification.

## Completion

Completion requires:

- every mandatory AC mapped to tests or an approved exception;
- current Red, Green, and required verification evidence;
- no unresolved `CONFLICT` or `BLOCKED`;
- a final audit over the exact current specification, authority, code, tests, and verification fingerprint.

Warnings may remain but must appear in the final state. Any relevant change after audit invalidates it. Managed `.state.md` changes are excluded from the implementation fingerprint to avoid an audit loop.

If the specification or any declared authority path/content changes, start a new run with `bootstrap --new-run --reason ...`; do not mix evidence from the old requirement set into the new one.
