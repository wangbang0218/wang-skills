# Codex project Hook

## Contents

- Purpose
- Installation
- Runtime behavior
- Removal and limitations

## Purpose

The optional project Hook complements the Skill. It does not invoke a reviewer. It observes Codex `SessionStart` events and injects a short developer-context reminder before Codex continues.

Codex supports project hooks in `.codex/hooks.json` or `.codex/config.toml`; project hooks load only for trusted projects and must be reviewed through `/hooks`. After root-session compaction, `SessionStart` with source `compact` runs before the next model request, including immediate continuation after mid-turn automatic compaction:

<https://learn.chatgpt.com/docs/hooks#sessionstart>

## Installation

Only run after explicit user approval:

```bash
node <skill-directory>/scripts/kimi_context.mjs setup-hook
```

The command:

- merges its `SessionStart` matcher into `.codex/hooks.json`;
- preserves all existing hooks;
- copies a self-contained script to `.codex/hooks/implement-with-kimi.mjs`;
- refuses to overwrite a user-modified script;
- reports `CONFIGURED_UNVERIFIED` and asks the user to review `/hooks`;
- does not stage or commit files.

The files are project assets and may be committed, but that decision belongs to the user.

## Runtime behavior

The Hook searches Git-tracked and non-ignored untracked `*.state.md` files for the versioned managed marker.

- No active module: emit nothing.
- One active module and `compact`, `clear`, or `resume`: record `OBSERVED_ACTIVE` and require `rehydrate` before implementation continues.
- One active module and `startup`: require an explicit `resume` or `suspend`; do not take over automatically.
- Multiple active modules or malformed state: inject a conflict warning and require repair.

The Hook updates only the managed state block and preserves User notes. It accepts state schema versions 1, 2, and 3, includes the selected reviewer in recovery context, and does not run either reviewer or intercept every tool call. `setup-hook` may replace an exact known older bundled Hook, but refuses to overwrite unknown or user-modified scripts.

## Removal and limitations

```bash
node <skill-directory>/scripts/kimi_context.mjs remove-hook
```

Removal deletes only the tagged handler. Delete the copied script only when it is byte-identical to the bundled asset; preserve a user-modified script. Do not delete unrelated Hook configuration.

Configured files do not prove trust. Record `OBSERVED_ACTIVE` only after a real event runs. Absence or unverified trust is a warning, not a hard dependency. A Hook is a workflow reminder, not an unbypassable security sandbox.
