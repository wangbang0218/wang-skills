# Context selection

## Contents

- Access boundary
- Budget
- Priority and selection
- Completeness

## Access boundary

Explicit Skill invocation plus reviewer choice authorizes the selected reviewer to read eligible repository content. This Skill has no secret scanner. The user must keep secrets out of the repository. Never follow a symlink outside the Git worktree.

The initial pack includes tracked and non-ignored untracked UTF-8 text. Exclude ignored files, NUL/binary data, unsupported encodings, managed `.state.md`, unreadable paths, and external symlinks. The reviewer may perform additional read-only repository searches during review.

## Budget

Reserve the selected reviewer's required 1M window approximately as follows:

| Use | Tokens |
| --- | ---: |
| Initial context pack | 700,000 |
| Additional repository reads | 100,000 |
| Web research | 50,000 |
| System, reasoning, Schema, output | about 198,000 |

Estimate conservatively without a tokenizer and record both bytes and estimated tokens.

## Priority and selection

Use this fixed order:

1. Current Goal and module specification
2. `AGENTS.md`, architecture, and PRD
3. Current changed code, tests, and diff
4. Direct public contracts, schemas, and types
5. Other related implementation and tests
6. Examples, history, benchmarks, fixtures, and snapshots

If everything fits, include the full eligible repository. Otherwise send the file catalog, specification, hashes, sizes, tiers, and changed flags to a selector run by the same reviewer selected for the module. The selector manifest reports the fixed total budget separately from the tokens already consumed by mandatory paths and the remaining additional budget. The catalog is metadata-only and does not contain repository file bodies. The selector returns additional candidate paths, keeps `findings` empty, and never infers or cites file contents from metadata. The local gate always includes mandatory paths, then fits the selector candidates by the fixed catalog priority using its own token estimates; an over-selected candidate is recorded as `context_budget`, never promoted to mandatory or silently truncated. Files the selector did not choose are recorded as `selector_not_selected`. Kimi uses low effort for selection; Claude Code uses max effort for every node. Selection uses paths, Git state, names, and lightweight text heuristics; it does not claim complete multi-language AST dependency analysis.

## Completeness

Never truncate an individual file silently. Record every omitted or excluded path and reason. Mark the pack `FULL` only when no eligible file was omitted for budget. If mandatory tiers alone exceed the budget, return `BLOCKED` instead of sending a misleading partial review.

Track additional Kimi ACP reads against the 100K budget. Once exhausted, deny broad reads but allow small explicit line ranges. Claude Code receives the same initial pack and read-only worktree boundary. Hash before and after every reviewer node; any repository change makes the result `STALE`.
