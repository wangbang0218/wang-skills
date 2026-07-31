# Implementation package input contract

## Contents

- Preferred package
- Authority set
- Consumer validation
- Legacy inputs

## Preferred package

Prefer a version 1 `implementation-package.json` created and approved with `prepare-for-kimi`. It is a machine-readable index, not a replacement for normative Markdown. It declares:

- project name and `greenfield` or `existing-project` mode;
- approved authority, PRD, architecture, and optional UI paths;
- four approval gates: requirements, architecture, UI, and implementation;
- approved `MOD-###` module specifications and their dependencies;
- traceability from every `REQ-###` and `NFR-###` to architecture, optional UI, module-qualified `AC-###`, and planned tests.

UI is either `approved` or `not-applicable`. Approved UI requires a Markdown UI specification, a Baoyu `designs/<project>/` root, `_d_meta.json`, and at least one HTML asset whose metadata status is `approved`.

## Authority set

Treat these paths as the module's declared authority set:

1. `implementation-package.json`
2. `authority.md`
3. PRD
4. architecture
5. UI specification when applicable

List every path in each module specification's Related documents section. JSON and Markdown paths are both recognized. Pass the same set explicitly with `--authority` during bootstrap and rehydration; the module specification remains the normative execution unit.

Domain ownership comes from `authority.md`: PRD owns product behavior, architecture and ADRs own technical constraints, UI specification plus approved design owns interface behavior, and module specs own module scope, ACs, and test plans. Stop on same-domain conflicts.

## Consumer validation

Before the first Kimi call, run:

```bash
node <skill-directory>/scripts/kimi_context.mjs validate-package \
  --package docs/project/implementation-package.json \
  --spec docs/tasks/module.md
```

This is a read-only local command. It does not inspect Kimi configuration, call a model, create state, or consume quota. Continue only on `READY`. Its bootstrap command contains the exact declared authority paths.

## Legacy inputs

Continue to accept a standalone module specification plus explicitly supplied architecture and PRD paths for existing users. Apply the original Markdown section and `AC-###` validation. Do not represent a legacy input as a fully approved project package unless the versioned manifest also passes `validate-package`.
