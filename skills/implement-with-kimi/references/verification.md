# Verification

## Contents

- Local deterministic checks
- Fake ACP integration
- Real Kimi checks
- Limits

## Local deterministic checks

Run:

```bash
node --test skills/implement-with-kimi/scripts/tests/*.test.mjs
```

Cover state transitions, managed/user-note isolation, evidence hashes and excerpts, symlink escape, context budget selection, model capability checks, JSON capsule limits, Hook merge/removal, Hook lifecycle output, and CLI evidence recording.

Check every script:

```bash
node --check skills/implement-with-kimi/scripts/kimi_context.mjs
```

Also check every `.mjs` file under `scripts/lib/` and `assets/codex-hook/`.

## Fake ACP integration

Use the bundled deterministic fake server to test:

- protocol version negotiation;
- `session/new` and config selection;
- streaming `agent_message_chunk` assembly;
- read/write/permission reverse RPC;
- idle timeout reset;
- policy violations and cancellation;
- schema repair and retry budgets.

## Real Kimi checks

Real tests consume Kimi quota and require explicit user authorization. This Skill's V1 acceptance includes that authorization.

Run three levels:

1. Small real ACP smoke using a synthetic Git repository and a tiny valid specification.
2. Near-budget K3 1M synthetic repository containing known needles, conflicting requirements, correction cases, and selector pressure.
3. Small audit/query that requires a real first-party web lookup and returns external-source metadata.

Never use a proprietary repository for the near-budget test. Verify the actual model alias, context size, effort, ACP protocol, tool denials, Schema, evidence, snapshot stability, and capsule size.

## Repository checks

Before handoff run:

```bash
npx skills add . --list
python3 <skill-creator>/scripts/quick_validate.py skills/implement-with-kimi
git diff --check
```

CLI discovery and static checks do not prove real model behavior. Report separately which real Kimi layers ran, their model/token cost implications, and any layer skipped or blocked.
