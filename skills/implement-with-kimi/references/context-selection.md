# Deterministic review context

## Access boundary

Explicit Skill invocation and reviewer choice establish the eligible worktree boundary, but do not authorize a paid call. Reviewer execution requires the separate preview approval described in `SKILL.md`.

Eligible content is Git-tracked or non-ignored untracked UTF-8 text within the current worktree. Exclude ignored files, NUL/binary content, unsupported encodings, managed `.state.md` files, unreadable paths, and symlinks outside the worktree. This Skill has no secret scanner; keep secrets out of the repository.

## Initial budgets

- Final audit: fixed 700,000-token initial pack.
- Advisory query: mandatory tokens plus 150,000 optional tokens, capped at 700,000.
- Reviewer capability contract: 1,048,576 context tokens.

Token estimates are conservative byte-based estimates, not provider billing figures. Never silently truncate an individual file.

The preview must state that 700K is only the initial pack. Kimi may make bounded additional repository reads tracked by the ACP client. Claude may autonomously read/search the worktree after the initial pack, and those follow-up reads have no hard token ceiling imposed by this Skill. Both may use read-only web research.

## Mandatory context

Always include, or represent as mandatory delta metadata when deleted:

1. module specification;
2. declared authority documents and every applicable repository `AGENTS.md`;
3. the complete run delta since the captured baseline;
4. every mapped test file.

If mandatory file bodies exceed the mode's budget, return `BLOCKED`. Do not send a partial mandatory set and do not mark the audit complete.

## Fixed local selection

There is no model selector. After mandatory paths, rank eligible files locally in this order:

1. paths explicitly referenced by the specification;
2. same-directory or same-basename files;
3. contracts, schemas, types, interfaces, and APIs;
4. other related tests/specs;
5. other implementation;
6. examples, fixtures, snapshots, benchmarks, and history.

Sort equal-tier files by repository-relative path and add whole files until the budget is full. Record each omitted path, SHA-256, token estimate, and `context_budget` reason. Mark completeness `FULL` only when no eligible file was budget-omitted. This is path/name/text-tier selection, not AST dependency analysis.

## Fingerprints

The run baseline snapshots the starting HEAD, dirty paths, status, and content hashes. Pre-existing unchanged dirt is excluded from the run delta; later changes, additions, deletions, and commits are included. The audit context manifest binds selected and omitted paths to SHA-256 values.

Immediately before and after a reviewer call, hash the complete eligible worktree. Any concurrent change makes the result `STALE`, even if the changed file was omitted from the initial pack.
