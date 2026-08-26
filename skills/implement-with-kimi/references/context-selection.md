# Deterministic review context

## Access boundary

Explicit Skill invocation establishes the eligible worktree boundary and covers the fixed reviewer's read-only access and paid audit/query calls. No separate preview or execution approval is required.

Eligible content is Git-tracked or non-ignored untracked UTF-8 text within the current worktree. Exclude ignored files, NUL/binary content, unsupported encodings, managed `.state.md` files, unreadable paths, and symlinks outside the worktree. This Skill has no secret scanner; keep secrets out of the repository.

## Initial budgets

- Final audit ordinary pack: fixed 700,000-token initial pack.
- Advisory query: mandatory tokens plus 150,000 optional tokens, capped at 700,000.
- Kimi-only final-audit large-run pack: at most 1,000,000 estimated tokens, only after the ordinary mandatory whole-file pack exceeds 700,000.
- Reviewer capability contract: 1,048,576 context tokens.

Token estimates are conservative byte-based estimates, not provider billing figures. Never silently truncate an individual file.

The preview must state the selected representation and exact estimate/budget. For an ordinary pack, 700K is only the initial pack. Kimi may make bounded additional repository reads tracked by the ACP client. In large-run mode, reserve 32,000 tokens for instructions/response, dynamically reduce and hard-enforce the direct-read cap, and require the conservative initial estimate, reserve, and read cap not to exceed 1,048,576. Claude may autonomously read/search the worktree after an ordinary initial pack, and those follow-up reads have no hard token ceiling imposed by this Skill. Both may use read-only web research.

## Mandatory context

Always include, or represent as mandatory delta metadata when deleted:

1. module specification;
2. declared authority documents and every applicable repository `AGENTS.md`;
3. the complete run delta since the captured baseline;
4. every mapped test file.

If mandatory file bodies exceed the mode's budget, return `BLOCKED`, except for the Kimi final-audit large-run representation below. Do not send a partial mandatory set and do not mark the audit complete.

## Kimi large-run representation

Use this representation only when all of the following are true:

1. mode is final `audit`;
2. the fixed reviewer is `kimi`;
3. the ordinary mandatory whole-file set exceeds 700,000 tokens;
4. the complete rendered large-run pack is at most 1,000,000 estimated tokens.

Include the specification, all declared authorities, applicable `AGENTS.md`, every mapped test, and every non-tracked run-delta text file in full. Represent every tracked run-delta modification and deletion with one deterministic `git diff` from the captured baseline HEAD using `--no-ext-diff --no-textconv --binary --full-index --unified=0 --no-renames`, restricted to literal run-delta paths. Bind every full file, represented current file, baseline blob, and the complete diff to SHA-256 metadata. Include the run delta, baseline dirty hashes/status, state evidence projection, omitted optional-file hashes, and exact diff path list in the manifest.

The tracked diff is complete: zero context lines means unchanged neighbors are absent, not that changed hunks were cut. Kimi may read/search a current tracked file for unchanged context or exact evidence lines. Deleted paths remain review context and cannot be cited as current local evidence. If a required current/baseline delta is binary, non-UTF-8, a symlink/gitlink, an unavailable deleted untracked baseline file, or the complete pack exceeds 1,000,000, return `BLOCKED`; never drop a path, hunk, file tail, or mapped test. Do not use this representation for Claude or advisory query.

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
