# State schema

## Contents

- Document layout
- Managed fields
- Events and transitions
- Runs and activity
- Migration rules

## Document layout

The state document is Markdown with one versioned JSON block between:

```text
<!-- implement-with-kimi:managed:start -->
<!-- implement-with-kimi:managed:end -->
```

The deterministic script owns that block. Preserve all text under `## User notes` exactly.

## Managed fields

Schema version 2 records:

- `tool`, `state_schema_version`
- `spec_path`, `spec_sha256`, `authority_paths`, `authority_hashes`
- `run_id`, `active`, `suspended`, `status`
- `git_baseline`, `implementation_fingerprint`
- `goal`
- Red plan and execution evidence
- per-run reviewer consent, required 1M declaration, failover scope and reason
- latest reviewer identity/model metadata and raw diagnostic reference
- unresolved findings and warnings
- Hook observation status
- append-only event history and archived prior runs

Do not use evidence from one `run_id` in another.

## Events and transitions

Only deterministic events may move state forward:

| Event | Required current state | Result |
| --- | --- | --- |
| `bootstrap-ready` | `NOT_STARTED` | `BOOTSTRAP_READY` |
| `tests-written` | `BOOTSTRAP_READY` | `TESTS_WRITTEN` |
| `red-planned` | `TESTS_WRITTEN` | unchanged |
| `red-observed` | `TESTS_WRITTEN` | `RED_CONFIRMED` |
| `tests-reviewed` | `RED_CONFIRMED`, or `TESTS_WRITTEN` when every AC is excepted | `TESTS_REVIEWED` |
| `implementation-started` | `TESTS_REVIEWED` | `IMPLEMENTING` |
| `green-observed` | `IMPLEMENTING` | `GREEN_CONFIRMED` |
| `verification-observed` | `GREEN_CONFIRMED` or `VERIFIED` | `VERIFIED` |
| `audited` | `VERIFIED` | `AUDITED` |
| `completed` | `AUDITED` | `COMPLETED` |

`test-exception`, warnings, suspension, and rehydration add evidence without fabricating a forward milestone.

## Runs and activity

- One worktree may have only one `active: true` state.
- Same spec hash plus unfinished state means continue or rehydrate the same run.
- A changed spec starts a new run after bootstrap.
- Same completed spec returns `ALREADY_COMPLETED` unless `--new-run --reason ...` is explicit.
- `BLOCKED` remains active.
- `suspend` records reason, Git baseline, and fingerprint, then clears activity.
- `resume` is permitted only when no other module is active and requires successful rehydration before activity is restored.

## Migration rules

Migrate version 1 to version 2 in place. Preserve run id, activity, status, fingerprints, evidence, findings, warnings, archived runs, and User notes. Convert `last_kimi_review` to `last_reviewer_review` with `reviewer: kimi`; default fallback authorization to disabled and append a migration event. Reject a newer unknown version and require a Skill upgrade. Never rebuild a malformed state file automatically.
