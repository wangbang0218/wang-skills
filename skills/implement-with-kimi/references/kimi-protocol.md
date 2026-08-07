# Kimi protocol

## Contents

- Preflight
- ACP lifecycle
- Tool policy
- Result envelope
- Evidence
- Retry and cancellation

## Preflight

Resolve `KIMI_BIN` only when it is an absolute executable path; otherwise search `PATH`. Run `kimi --version`, `kimi doctor config`, and `kimi provider list --json`. Never install, upgrade, log in, or alter configuration.

Require the configured model's underlying id to be `k3`, `maxContextSize >= 1048576`, and `supportEfforts` to include `low`, `high`, and `max`. Do not fall back to K3-256k or another model.

Kimi Code documents `kimi acp` as JSON-RPC over stdin/stdout with clean stdout and diagnostic stderr. The implementation negotiates stable ACP protocol version 1 and uses `initialize -> session/new -> session/set_config_option -> session/prompt -> session/cancel` as needed:

- <https://moonshotai.github.io/kimi-code/en/reference/kimi-acp>
- <https://agentclientprotocol.com/>

## ACP lifecycle

Create a fresh session per selector, bootstrap, test review, rehydration, audit, query, and retry. Never load or resume a Kimi session. Select `model=kimi-code/k3` and effort:

- selector: low
- bootstrap, review-tests, rehydrate, query: high
- audit: max

Use a 30-second startup/handshake idle timeout, a 5-minute selector idle timeout, and a 15-minute main-node idle timeout. Reset only on meaningful unique progress. Do not impose a total execution deadline.

## Tool policy

Advertise ACP filesystem read support but no write or terminal support. Permit repository-scoped text reads, search, and web fetch/search. Reject paths that resolve outside the Git worktree, including symlink escape.

Reject or cancel:

- Write, Edit, delete, or move
- Bash and other execution
- Agent and AgentSwarm
- Skill invocation and user questioning
- media/binary reads
- background, cron, or project-state mutation

Give the first permission-controlled violation a denial/correction. Cancel on repeated violations. Because some Kimi tools are auto-approved, inspect streamed `tool_call` messages and cancel immediately when an auto-approved call is outside the allowed read/search/fetch set. Classify calls from structured ACP fields, never from keywords in the free-form `title`: use `kind` for standard read/search/fetch calls, `locations` and `rawInput.path` for repository-boundary checks, and the exact read-only `{ url: <http(s) URL> }` `rawInput` shape for Kimi ACP versions that temporarily report `FetchURL` as `kind=other`. A lazy `kind=other`, `status=pending` call with no `rawInput` is provisional only; require a later structured update before the prompt ends and reject it otherwise. Treat ACP guards as a runtime boundary plus prompt constraint, not as a general OS sandbox.

## Result envelope

Require one JSON object with `schema_version: 1`, English keys, and Chinese explanations:

```json
{
  "schema_version": 1,
  "mode": "audit",
  "run_id": "uuid",
  "summary": "...",
  "findings": [],
  "ac_coverage": [],
  "next_actions": [],
  "external_research": { "status": "NOT_REQUESTED", "sources": [] },
  "context": { "completeness": "FULL", "omissions": [], "compacted": false }
}
```

Compute the top status locally from findings with precedence `CONFLICT > BLOCKED > WARNING > READY`; do not trust a model-supplied top status. Finding severity is relative to the requested mode and its next legal transition: `BLOCKED` means the current gate cannot safely pass, not merely that work required by a later gate remains. In `review-tests`, valid expected Red caused by missing production behavior is success evidence and cannot itself be `BLOCKED`; in `rehydrate`, do not perpetuate that expected gap from persisted state. If Kimi reports its own context compaction, discard the response and retry once with a smaller pack.

Keep the full validated JSON in an OS temporary diagnostic directory. Return a maximum 32 KiB capsule to Codex containing every conflict/blocker, important warnings, AC summary, next actions, omissions, and a raw reference. Retrieve details through `inspect --finding`.

## Evidence

Local evidence requires repository-relative `path`, exact lowercase SHA-256, 1-based line range, exact non-empty excerpt, and claim. Re-read the file and validate all fields after Kimi returns. Recorded execution logs may originate outside the repository; redact their diagnostic paths before building Kimi context and mark their remaining command, exit code, hash, and excerpt as metadata rather than citeable local-file evidence. Never copy a path embedded in recorded-log metadata into local evidence unless Kimi independently locates and reads that repository file, then returns its repository-relative path. Never accept an OS temporary path, diagnostic directory, `raw_result_ref`, or another absolute path as local evidence.

The validated envelope must retain the exact source excerpt. After the hash matches, the validator may deterministically restore line-leading spaces or tabs omitted by the model when the supplied range is otherwise exact, or when the indentation-insensitive excerpt occurs exactly once; it replaces the excerpt with source text and records the original value. It may also normalize an incorrect range when an exact excerpt occurs once. Ambiguous excerpts, missing excerpts, and internal or trailing whitespace differences fail closed. External evidence requires HTTP(S) URL, title, access time, and claim. Project sources remain authoritative; external sources may expose staleness or conflict but cannot silently override them.

## Retry and cancellation

- Retry network, 429, and 5xx failures at most twice with backoff.
- Retry an oversized context once after deterministic shrinking.
- Retry invalid JSON/Schema once in a fresh session with a repair instruction. Do not classify local evidence mismatches as Schema errors.
- Do not retry deterministic configuration, conflict, blocker, policy, or evidence failures.
- Bound combined retries; never create an infinite retry product.
- On SIGINT/SIGTERM, send `session/cancel`, allow a short shutdown grace period, then terminate. Mark the node `CANCELLED`; never reuse partial streamed output.
- Do not transient-retry an explicit billing, monthly, or rolling quota exhaustion. Route only after the error is classified under [reviewer-fallback.md](reviewer-fallback.md).
