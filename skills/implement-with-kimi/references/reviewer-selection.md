# Reviewer selection and execution

## Fixed per-run choice

Require exactly one reviewer at bootstrap:

```bash
--reviewer kimi
```

or:

```bash
--reviewer claude-code
```

Never infer a default. Choosing a reviewer records the intended read-only reviewer and the 1,048,576-token capability contract, but bootstrap performs no reviewer preflight or model call.

The choice is immutable for the run. `select-reviewer` may populate a missing migrated selection or idempotently confirm the current reviewer; it cannot change Kimi to Claude or vice versa. Start a new run to make a different choice. Never automatically fall back after any failure.

## Invocation-based execution

Explicit Skill invocation covers the fixed reviewer's eligible repository reads and paid `audit` or `query` calls. Do not stop for an additional confirmation. At review time:

1. Run `audit` or `query` directly; either command executes the fixed reviewer.
2. Use `review-preview --mode audit|query` only for an informational, state-unchanged disclosure when the user asks for one.
3. Preserve the same concrete reviewer, mode, initial context estimate, access boundary, two-submission cap, and cost ledger whether or not a preview was requested.

Preflight only the selected reviewer when `audit` or `query` starts. Never probe the other reviewer. A preflight failure occurs before prompt submission and consumes no invocation attempt.

If a Kimi final audit needs the large-run representation, its optional preview additionally discloses the ordinary 700K overflow, `large_run_unified_diff`, 1,000,000-token ceiling, exact rendered estimate and context-pack SHA-256, full-file paths, tracked diff paths/SHA/bytes, dynamic additional-read cap, and the no-truncation guarantee. This representation is not an automatic reviewer switch.

## Claude Code isolation

Invoke local Claude Code without `--model` or provider-specific overrides. Inherit its configured provider, model, and authentication. Require:

- `--safe-mode` and `--no-session-persistence`;
- `--permission-mode dontAsk`;
- only `Read,Grep,Glob,WebFetch,WebSearch`;
- explicit denial of Bash, Edit, Write, NotebookEdit, Agent, Skill, and AskUserQuestion;
- structured JSON output and `--effort max`;
- `DISABLE_COMPACT=1` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576` on the subprocess.

Resolve Claude in this order: absolute `CLAUDE_BIN`, Volta shim, `volta which claude`, then a non-Volta PATH entry. Reject a binary under `tools/image/node/<version>/bin` when no Volta-managed Claude is available. Persist binary path/source, CLI version, and provider-reported models as audit metadata, never as proof of capacity.

Claude may autonomously read/search the current worktree and use web tools. It may not execute commands, write, spawn agents, use project skills/hooks/plugins, or persist a session. Fail closed on compaction, truncation, prompt overflow, or insufficient context.

## Submission and cost limits

Each `audit` or `query` execution has one shared budget of at most two submitted reviewer prompts. Initial request, Schema repair, deterministic context shrink, transient retry, and any retry after sending all consume that same budget. Evidence, Policy, authority, and `STALE` failures are not Schema-repaired. No fallback call is allowed.

Do not pass Claude `--max-budget-usd`. Cost control is the preview, the two-submission cap, and post-call ledger. Persist every successful or failed submitted prompt:

- Claude: raw provider token/cache fields, `modelUsage`, durations, and `total_cost_usd`.
- Kimi: measurable initial estimate, additional ACP reads, duration, and status; unavailable token and USD fields remain `null`.

Never estimate a missing dollar amount.

## Outcome semantics

For final audit, locally computed `READY` or `WARNING` may enter `AUDITED` then `COMPLETED`. `BLOCKED` or `CONFLICT` may not. Configuration, authentication, quota, Schema, Evidence, Policy, context, cancellation, and `STALE` failures never advance and have no local bypass.

Query is advisory. Persist its raw result and usage, but do not change milestones, unresolved audit findings, or `semantic_review`.
