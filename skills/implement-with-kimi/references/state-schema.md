# State schema v4

## Document layout

The paired Markdown state contains one managed JSON block between:

```text
<!-- implement-with-kimi:managed:start -->
<!-- implement-with-kimi:managed:end -->
```

The deterministic CLI owns that block. Preserve all content under `## User notes` exactly.

## Core fields

Version 4 records:

- specification and authority paths plus SHA-256 hashes;
- `run_id`, activity, suspension, current and previous status;
- Git baseline, run baseline, run-scoped fingerprint, implementation fingerprint, and test fingerprint;
- AC-to-test mappings with current test hashes;
- Red plans, exceptions, full execution evidence, and current-valid evidence projection inputs;
- `semantic_review` (`PENDING` or `AUDITED`);
- fixed reviewer selection and 1,048,576-token capability contract;
- `review_invocations` for every submitted reviewer prompt;
- latest audit and advisory query summaries plus retained raw diagnostic references;
- unresolved and superseded findings, warnings, history, Hook observation, and archived runs.

Never copy evidence between run ids.

## Events and transitions

| Event | Required current state | Result |
| --- | --- | --- |
| `bootstrap-ready` | `NOT_STARTED` | `BOOTSTRAP_READY` |
| `test-exception` | `BOOTSTRAP_READY` | unchanged |
| `tests-written` | `BOOTSTRAP_READY` or `TESTS_WRITTEN` | `TESTS_WRITTEN` |
| `red-planned` | `TESTS_WRITTEN` | unchanged |
| `red-observed` | `TESTS_WRITTEN` | unchanged |
| `baseline-green-observed` | `TESTS_WRITTEN` | unchanged |
| `tests-validated` | `TESTS_WRITTEN` | `TESTS_VALIDATED` |
| `implementation-started` | `TESTS_VALIDATED` | `IMPLEMENTING` |
| `green-observed` | `IMPLEMENTING` | `GREEN_CONFIRMED` only after all mapped paths have current exit-zero evidence |
| `verification-observed` | `GREEN_CONFIRMED` or `VERIFIED` | `VERIFIED` |
| `audited` | `VERIFIED` | `AUDITED` |
| `completed` | `AUDITED` | `COMPLETED` and inactive |

Warnings, suspension, rehydration, and query results never create a forward milestone. Repeated blocking preserves the original pre-block status.

## Invocation ledger

Each submitted reviewer prompt has one updatable entry containing invocation id, mode, reviewer, attempt, start/finish times, status, diagnostic reference, duration, initial-pack estimate, extra reads, provider usage, and failure classification when applicable.

Claude preserves provider-reported usage, cache fields, `modelUsage`, durations, and `total_cost_usd` without reinterpretation. Kimi fields unavailable from ACP remain `null`; record only measurable initial estimates and repository-read counts. Preflight/handshake work before prompt submission is not an invocation.

## Run invalidation

The run baseline distinguishes pre-existing dirt from changes made during this run. A run-scoped fingerprint covers the delta since that baseline.

- A mapped test change after local validation resets test validation and returns to `TESTS_WRITTEN`.
- Other implementation changes after Green, verification, or audit return to `IMPLEMENTING`.
- Reviewer-time full-worktree changes reject the response as `STALE`.
- After a blocked audit, local rehydrate supersedes findings only when the run fingerprint actually changed.
- Specification or authority path/content changes always require a new run.

## v1-v3 migration

Migration is in-place and preserves run id, activity, User notes, evidence, old reviewer results and raw references, findings, warnings, history, and archived runs.

- v1 and v2 first migrate through the existing v3 normalization, then to v4.
- `RED_CONFIRMED` becomes `TESTS_WRITTEN`; the active run must attach path mappings and run `validate-tests`.
- `TESTS_REVIEWED` becomes `TESTS_VALIDATED`.
- Later and completed states keep their milestone and receive `test_validation.source=legacy-reviewer`; do not fabricate missing path hashes retrospectively.
- Active migrated runs without mappings use `attach-test-map --test-map AC-NNN=path` without changing `run_id`. For later legacy states the map is optional compatibility metadata.
- Old routing metadata remains in history, but a missing current reviewer selection must be filled explicitly before audit.
- Current output Schema supports only `audit` and `query`; legacy modes remain readable solely for retained raw-result `inspect`.

Reject a newer unknown schema and never reconstruct malformed state automatically.
