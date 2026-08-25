# Reviewer selection and authorization

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

## Preview authorization

Before `audit` or `query` execution:

1. Run `review-preview --mode audit|query`, or run the mode without `--execute-reviewer`.
2. Show the complete `REVIEW_READY` preview to the user.
3. Obtain explicit authorization for that concrete reviewer, mode, initial context estimate, access boundary, retry cap, and cost disclosure.
4. Only then add `--execute-reviewer`.

An earlier Skill invocation, reviewer choice, repository-read authorization, or previous audit approval is not sufficient. Every new audit/query execution requires its own preview approval.

Preflight only the selected reviewer after `--execute-reviewer` is present. Never probe the other reviewer. A preflight failure occurs before prompt submission and consumes no invocation attempt.

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
