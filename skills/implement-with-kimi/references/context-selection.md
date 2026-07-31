# Context selection

## Contents

- Access boundary
- Budget
- Priority and selection
- Completeness

## Access boundary

Kimi may read all repository content. This Skill has no `.kimi-context.json`, allowlist, denylist, or secret scanner. The user must keep secrets out of the repository. Never follow a symlink outside the Git worktree.

The initial pack includes tracked and non-ignored untracked UTF-8 text. Exclude ignored files, NUL/binary data, unsupported encodings, managed `.state.md`, unreadable paths, and external symlinks. Kimi may perform additional read-only repository searches during review.

## Budget

Reserve the K3 1M window approximately as follows:

| Use | Tokens |
| --- | ---: |
| Initial context pack | 650,000 |
| Additional repository reads | 100,000 |
| Web research | 50,000 |
| System, reasoning, Schema, output | about 248,000 |

Estimate conservatively without a tokenizer and record both bytes and estimated tokens.

## Priority and selection

Use this fixed order:

1. Current Goal and module specification
2. `AGENTS.md`, architecture, and PRD
3. Current changed code, tests, and diff
4. Direct public contracts, schemas, and types
5. Other related implementation and tests
6. Examples, history, benchmarks, fixtures, and snapshots

If everything fits, include the full eligible repository. Otherwise send the file catalog, specification, sizes, tiers, and changed flags to a low-effort Kimi selector. Union its selections with deterministic mandatory paths and then apply the fixed budget. V1 uses paths, Git state, names, and lightweight text heuristics; it does not claim complete multi-language AST dependency analysis.

## Completeness

Never truncate an individual file silently. Record every omitted or excluded path and reason. Mark the pack `FULL` only when no eligible file was omitted for budget. If mandatory tiers alone exceed the budget, return `BLOCKED` instead of sending a misleading partial review.

Track additional ACP reads against the 100K budget. Once exhausted, deny broad reads but allow small explicit line ranges. Hash before and after every Kimi node; any repository change makes the result `STALE`.
