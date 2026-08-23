# Reviewer selection

## Contents

- Selection and authorization
- Routing and changes
- Claude Code isolation
- Context and retries
- Recovery and migration

## Selection and authorization

Require one explicit reviewer for every module run:

```bash
--reviewer kimi
```

or:

```bash
--reviewer claude-code
```

Never infer a default. If the Skill invocation does not name a reviewer, ask the user to choose Kimi or Claude Code before bootstrap. Explicitly invoking the Skill and choosing a reviewer authorizes that reviewer to read eligible text within the current Git worktree; do not request separate repository consent or accept the removed consent flags. The Skill has no secret scanner, so keep secrets out of the repository.

Both reviewers require a 1,048,576-token context. Kimi preflight verifies K3 model configuration and capabilities. Choosing Claude Code attests that its configured default model supports 1M; do not bind it to Anthropic, DeepSeek, Qwen, or another provider or model id.

## Routing and changes

- Persist the selected reviewer for the run. Use it for selector, bootstrap, test review, rehydration, audit, and query nodes.
- Instantiate and preflight only the selected reviewer. Never probe or call the other reviewer.
- Never switch automatically after authentication, quota, subscription, service, context, Schema, Evidence, Policy, stale, authority, or workflow failures. Preserve the failure and require an explicit choice.
- Change an active run with:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs select-reviewer \
  --spec docs/tasks/module.md \
  --authority docs/architecture.md \
  --reviewer claude-code
```

Preflight the target reviewer before atomically changing state. Preserve the run id, milestones, evidence, findings, warnings, archived runs, and User notes. Record the previous and selected reviewer in history.

## Claude Code isolation

Invoke the local `claude` executable without `--model` or provider-specific environment changes. Inherit its current default provider, model, and authentication. Require feature support for:

- `--safe-mode` to disable CLAUDE.md, skills, plugins, hooks, MCP, custom commands/agents, output styles, and workflows;
- `--no-session-persistence`;
- `--permission-mode dontAsk`;
- built-in tools limited to `Read,Grep,Glob,WebFetch,WebSearch`;
- explicit denial of Bash, Edit, Write, NotebookEdit, Agent, Skill, and AskUserQuestion;
- `--effort max` and structured JSON output.

Resolve the executable in this order: an explicit absolute `CLAUDE_BIN`, the Volta-managed Claude returned by the Volta shim or `volta which claude`, then a non-Volta PATH entry. A `claude` executable under `tools/image/node/<version>/bin` is rejected when no Volta-managed Claude is available because it may be an older Node-image copy. Audit metadata records the selected binary path and resolution source separately from the CLI version and reported model.

Claude Code reads from the current Git worktree. Do not add directories. Use its reported model only as audit metadata; never use it as an allowlist or proof of context capacity. Never record credentials, API keys, or provider secrets.

## Context and retries

Set `DISABLE_COMPACT=1` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576` only for the Claude reviewer subprocess so an undersized compatible upstream rejects the request instead of silently compacting it. Do not downgrade or shrink a Claude review context to make it pass. Fail closed on prompt overflow, compaction, truncation, or insufficient context.

Invoke Claude once for the full node. Permit exactly one fresh Schema-repair invocation when its response cannot pass the local output Schema. Do not Schema-retry Evidence, Policy, stale fingerprint, context, or other deterministic failures. Do not add outer network retries; Claude Code owns its transport retries.

Kimi keeps its existing bounded transport retries and one deterministic context shrink. Explicit quota exhaustion is not transient. Once the selected reviewer exhausts its permitted retry behavior, surface the error without calling the other reviewer.

## Recovery and migration

A successful review may pass `review-tests`, `rehydrate`, or final `audit` only through the same local Schema, Evidence, AC, authority, and fingerprint gates for both reviewers. Persist reviewer name and model metadata with the review.

State v1 and v2 migrate to v3 without losing execution evidence, but the selected reviewer is cleared so old routing is not treated as a new manual choice. An active migrated run must use `select-reviewer` before its next review. A migrated suspended run cannot use that active-only command; pass `--reviewer kimi|claude-code` to `resume` once so selection is recorded before rehydration.
