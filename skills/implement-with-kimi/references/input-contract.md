# Implementation package input contract

## Preferred package

Prefer an approved version 1 `implementation-package.json` produced by `prepare-for-kimi`. It indexes normative Markdown and declares project mode, authority/PRD/architecture/UI paths, approval gates, module dependencies, and requirement-to-AC/test traceability. It does not replace those documents.

Approved UI requires its specification and approved design assets; otherwise UI must be explicitly `not-applicable`.

## Authority set

The declared authority set normally contains:

1. `implementation-package.json`;
2. `authority.md`;
3. PRD;
4. architecture;
5. UI specification when applicable.

List these in the module's related documents and pass the same paths with repeated `--authority` during bootstrap and later commands. The module specification remains the normative execution unit. Stop on same-domain conflicts.

## Local consumer validation

Before bootstrap, run:

```bash
volta run node <skill-directory>/scripts/kimi_context.mjs validate-package \
  --package docs/project/implementation-package.json \
  --spec docs/tasks/module.md
```

This is read-only and local. It does not inspect reviewer configuration, call a model, create state, or consume reviewer quota. Continue only on exact `READY`. Emitted bootstrap commands include an explicit reviewer placeholder/choice and exact authority paths; bootstrap itself is also local-only.

The first possible reviewer call is the separately previewed and authorized final audit or advisory query.

## Legacy inputs

Continue to accept a standalone valid module specification plus explicitly supplied architecture/PRD paths. Do not describe a legacy input as an approved project package unless the manifest also passes `validate-package`.
