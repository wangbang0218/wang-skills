# Audit-only workflow

## Authority and inputs

Use this precedence:

1. Latest user-confirmed instruction after it is persisted in project documentation.
2. Project-declared precedence, including applicable `AGENTS.md` files.
3. The current module specification and declared package, architecture, PRD, and UI authorities.

Do not invent precedence. A same-domain contradiction is a conflict. The Markdown module specification remains the execution unit and must include goal, scope, non-goals, dependencies, stable `AC-###` criteria, test requirements or exceptions, and related documents.

## State sequence

```text
NOT_STARTED
  -> BOOTSTRAP_READY
  -> TESTS_WRITTEN
  -> TESTS_VALIDATED
  -> IMPLEMENTING
  -> GREEN_CONFIRMED
  -> VERIFIED
  -> AUDITED
  -> COMPLETED
```

`BLOCKED` is an interrupting state, not a successful milestone. Bootstrap through verification is local and deterministic. Only final `audit --execute-reviewer` may enter `AUDITED` and `COMPLETED`.

## Map and validate tests

Every non-excepted AC must map to at least one repository-relative test path. Record exceptions at `BOOTSTRAP_READY`:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs record test-exception \
  --spec docs/tasks/module.md \
  --ac AC-003 \
  --reason "Documentation-only acceptance criterion"
```

Record mappings and their current SHA-256 values:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs record tests-written \
  --spec docs/tasks/module.md \
  --test-map AC-001=test/module_behavior_test.dart \
  --test-map AC-002=test/module_edge_test.dart
```

For new behavior, plan Red before executing it and bind the result to a mapped path:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs record red-planned \
  --spec docs/tasks/module.md \
  --ac AC-001 \
  --expected-failure "The new behavior is not implemented"

volta run node <skill-directory>/scripts/kimi_context.mjs record red-observed \
  --spec docs/tasks/module.md \
  --test test/module_behavior_test.dart \
  --command "fvm flutter test test/module_behavior_test.dart" \
  --exit-code 1 \
  --matched-expectation \
  --log /tmp/module-red.log
```

For a pure refactor, bind an existing Green baseline instead:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs record baseline-green-observed \
  --spec docs/tasks/module.md \
  --test test/module_edge_test.dart \
  --command "fvm flutter test test/module_edge_test.dart" \
  --exit-code 0
```

Red and baseline Green add evidence without advancing beyond `TESTS_WRITTEN`. Validate all mappings, hashes, AC coverage, and current Red/baseline evidence locally:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs validate-tests \
  --spec docs/tasks/module.md
```

The deprecated `review-tests` command is a one-release local alias. It returns `LOCAL_ONLY`, performs the same validation, and never calls a reviewer.

## Implement, Green, and verify

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs record implementation-started \
  --spec docs/tasks/module.md

volta run node <skill-directory>/scripts/kimi_context.mjs record green-observed \
  --spec docs/tasks/module.md \
  --test test/module_behavior_test.dart \
  --test test/module_edge_test.dart \
  --command "fvm flutter test test" \
  --exit-code 0 \
  --log /tmp/module-green.log

volta run node <skill-directory>/scripts/kimi_context.mjs record verification-observed \
  --spec docs/tasks/module.md \
  --command "tool/validate_macos.sh" \
  --exit-code 0 \
  --log /tmp/module-verification.log
```

All mapped test paths require current exit-zero Green evidence for the same run fingerprint. Record every required static, integration, build, or platform command separately. Unrun checks remain unknown.

## Preview and final audit

At `VERIFIED`, `review-preview --mode audit` and unconfirmed `audit` both return `REVIEW_READY`, exit successfully, and leave state unchanged. Codex must show the preview and obtain explicit approval before adding `--execute-reviewer`.

The audit receives only the current evidence projection and compact log excerpts, while the full append-only history remains in state. `READY` and `WARNING` may complete. `BLOCKED` and `CONFLICT` remain active blockers. Reviewer execution errors never become local warnings and never advance state.

`query` follows the same preview/authorization contract but is advisory. Its findings do not replace audit findings or change the run state.

## Recovery and invalidation

`rehydrate` and `resume` are local. They restore the next action and enforce:

- specification or authority change: require a new run;
- mapped test hash change after validation: roll back to `TESTS_WRITTEN` and require fresh test evidence;
- non-test run delta change after Green, verification, or audit: roll back to `IMPLEMENTING`;
- blocked audit plus unchanged run fingerprint: retain findings and remain blocked;
- blocked audit plus changed run fingerprint: archive old findings as superseded and roll back locally.

Managed `.state.md` writes are excluded from worktree fingerprints. A full worktree before/after fingerprint still guards reviewer concurrency; a change during a call makes the result `STALE`.
