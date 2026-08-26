# Kimi audit/query protocol

## Preflight

Preflight Kimi only when `audit` or `query` begins. Resolve absolute `KIMI_BIN` or search PATH, then run version, configuration doctor, and provider listing. Never install, upgrade, log in, or modify configuration.

Require underlying model id `k3`, `maxContextSize >= 1048576`, and effort capabilities including `low`, `high`, and `max`. Do not fall back to K3-256k or another model.

Kimi Code uses ACP JSON-RPC over stdin/stdout:

- <https://moonshotai.github.io/kimi-code/en/reference/kimi-acp>
- <https://agentclientprotocol.com/>

## Lifecycle

Only `audit` and `query` create reviewer sessions. Create a fresh ACP session for each submitted prompt; never load or resume a prior session. Negotiate protocol version 1, select `model=kimi-code/k3`, and use `max` effort for both modes.

Bootstrap, test validation, rehydration, resume, Hook recovery, and context selection are local and create no Kimi process.

## Read-only policy

Advertise repository-scoped text read/search and web fetch/search, with no terminal or filesystem write support. Reject paths outside the current worktree, including symlink escape.

Reject or cancel Write, Edit, delete, move, Bash, execution, Agent/AgentSwarm, Skill, user questioning, media/binary reads, background work, cron, and project-state mutation.

Inspect structured ACP fields rather than free-form titles. Standard read/search/fetch calls use `kind`; repository paths use `locations` and `rawInput.path`; transitional `FetchURL` calls reported as `kind=other` require the exact read-only `{ url: <http(s)> }` shape. A provisional lazy call must later provide structured input. ACP guards are a runtime boundary plus prompt constraint, not a general OS sandbox.

## Result and evidence

Require exactly one JSON object with current mode `audit` or `query`, matching run id, complete AC coverage, findings, actions, external research, and context completeness. Compute status locally with precedence `CONFLICT > BLOCKED > WARNING > READY`.

Local evidence requires repository-relative path, exact SHA-256, 1-based line range, exact non-empty excerpt, and claim. Re-read and validate it after return. Reject absolute paths, OS temporary paths, diagnostic directories, raw-result paths, and symlink escape.

Recorded execution logs are metadata. The audit projection removes their external paths and keeps only command, exit code, hash, size, and a short excerpt. The full evidence history stays in state instead of being repeated in the prompt.

The validator may only make deterministic source-backed corrections: restore omitted leading indentation or repair a unique exact excerpt's line range. Ambiguous or material whitespace mismatches fail as Evidence, not Schema.

External evidence requires HTTP(S) URL, title, access time, and claim. Project authorities remain normative.

## Shared two-submission cap

At most two reviewer prompts may be submitted for one audit/query command. Initial submission, Schema repair, context shrink, transient/network retry, and retry after a sent request share this cap. Startup or handshake failure before prompt submission does not consume it.

An oversized/compacted ordinary context may trigger one deterministic smaller initial pack only when the shared budget remains; mandatory context still cannot be truncated. A large-run pack contains only mandatory full text plus the complete tracked delta representation, so context oversize/compaction fails closed without a smaller-pack retry. Invalid JSON/Schema may receive one repair prompt. Do not retry Evidence, Policy, authority, conflict, blocker, cancellation, or `STALE`. Explicit billing/monthly/rolling quota exhaustion is not transient.

On SIGINT/SIGTERM, send cancellation, allow a short shutdown grace period, and reject partial output. Never call Claude as fallback.

Each submitted prompt is ledgered as running then succeeded/failed. Kimi ACP does not provide authoritative provider token/cache/USD totals, so those fields remain `null`; do not fabricate costs.

## Legacy compatibility

No selector, bootstrap review, test review, or reviewer rehydration prompt can be generated or executed. The validator retains legacy mode decoding only so `inspect` can read old stored raw results.
