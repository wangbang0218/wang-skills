# Codex project Hook

## Purpose

The optional project Hook is only a lifecycle reminder. It observes Codex `SessionStart`, records a compact Hook observation in managed state, and tells Codex to run local `rehydrate`, `resume`, or `suspend`. It never preflights or invokes a reviewer.

## Installation

When Hook setup is part of the requested task:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs setup-hook
```

The command merges a tagged `SessionStart` handler into `.codex/hooks.json`, preserves unrelated hooks, copies a self-contained script to `.codex/hooks/implement-with-kimi.mjs`, refuses to overwrite an unknown/user-modified script, and reports `CONFIGURED_UNVERIFIED`. The user must review/trust it through `/hooks`. Nothing is staged or committed.

## Runtime

The Hook scans tracked and non-ignored untracked managed state files.

- No active module: emit nothing.
- One active module after compact/clear/resume: require local `rehydrate` before more changes or claims.
- One active module at startup: require explicit `resume` or `suspend`; do not take over automatically.
- Multiple active modules or malformed state: emit a conflict warning.

It accepts state schemas 1 through 4 for recovery, updates only the managed block, preserves User notes, and includes the selected final-audit reviewer in its reminder. It does not intercept tools or enforce reviewer execution.

## Removal

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs remove-hook
```

Remove only this Skill's tagged config. Delete the copied script only when it matches the current or an exact known legacy asset; preserve user-modified scripts and unrelated Hook configuration. Hook trust and actual event observation must be reported separately from installation.
