# Reviewer fallback

## Contents

- Authorization
- Routing
- Claude Code isolation
- Context and retries
- Recovery and evidence

## Authorization

Keep Kimi as the preferred reviewer. Enable local Claude Code only for one run through all of:

```bash
--fallback-reviewer claude-code --reviewer-context 1m --consent-repository-to-reviewer
```

These options mean that the user authorizes repository content to be sent to the configured reviewer and attests that Claude Code's current default model supports 1,048,576 context tokens. Do not infer consent from a global installation or another run. Do not bind the fallback to DeepSeek, Qwen, Anthropic, or a model id.

For an existing active v1 or v2 state, run:

```bash
node <skill-directory>/scripts/kimi_context.mjs enable-reviewer-fallback \
  --spec docs/tasks/module.md \
  --authority docs/architecture.md \
  --fallback-reviewer claude-code \
  --reviewer-context 1m \
  --consent-repository-to-reviewer
```

## Routing

- Stay on Kimi while it is available.
- Switch the entire current run to Claude for login/authentication failure, exhausted billing/monthly/rolling quota, or unavailable subscription/model/1M entitlement.
- Retry Kimi normally for temporary membership verification, overload, concurrency, network, and 5xx failures; after exhaustion, use Claude only for that reviewer node. Try Kimi first again at the next node.
- Never fall back for `Access terminated`, account suspension or safety enforcement, Policy, Schema, Evidence, stale fingerprint, authority conflict, context-semantic failure, or a business/workflow blocker.
- Discard every partial Kimi response before fallback. Re-run the full node independently against the same frozen repository fingerprint, context pack, mode, run id, and Schema.

## Claude Code isolation

Invoke the local `claude` executable without `--model` or provider-specific environment changes. Inherit its current default provider, model, and authentication. Require feature support for:

- `--safe-mode` to disable CLAUDE.md, skills, plugins, hooks, MCP, custom commands/agents, output styles, and workflows;
- `--no-session-persistence`;
- `--permission-mode dontAsk`;
- built-in tools limited to `Read,Grep,Glob,WebFetch,WebSearch`;
- explicit denial of Bash, Edit, Write, NotebookEdit, Agent, Skill, and AskUserQuestion;
- `--effort max` and structured JSON output.

Claude Code reads from the Git worktree used as its working directory. Do not add directories. Use its reported model only as audit metadata; never use it as an allowlist or proof of context capacity. Never record credentials, API keys, or provider secrets.

## Context and retries

The 1M declaration is a hard precondition. Set `DISABLE_COMPACT=1` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576` only for the reviewer subprocess so an undersized compatible upstream rejects the request instead of silently compacting it. Do not downgrade to 256K/128K or shrink a Claude review context to make it pass. Fail closed when Claude Code or its response reports prompt/context overflow, compaction, truncation, or an insufficient context window.

Invoke Claude once for the full node. Permit exactly one fresh Schema-repair invocation when the response cannot pass the local output Schema. Do not Schema-retry Evidence, Policy, stale fingerprint, context, or other deterministic failures. Do not add outer network retries; Claude Code owns its transport retries.

## Recovery and evidence

A successful Claude review may pass `review-tests`, `rehydrate`, or final `audit`, including `AUDITED -> COMPLETED`, only through the same local Schema, Evidence, AC, authority, and fingerprint gates as Kimi.

Persist reviewer name, CLI-reported model, fallback reason, original Kimi failure, and scope. A run-sticky fallback remains active until:

```bash
node <skill-directory>/scripts/kimi_context.mjs retry-kimi \
  --spec docs/tasks/module.md \
  --authority docs/architecture.md
```

This performs Kimi configuration checks plus a fresh ACP availability probe. Clear stickiness only when the probe returns `READY`; otherwise preserve the fallback state and report the Kimi error.
