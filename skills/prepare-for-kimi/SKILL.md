---
name: prepare-for-kimi
description: Refine a new or existing software project through a one-question-at-a-time decision interview, then create and validate an approved PRD, architecture, optional Baoyu HTML UI design, module specifications, and traceability package for implement-with-kimi. Use only when the user explicitly asks to prepare persisted project documents or an implementation-ready package for Kimi-driven development.
---

# Prepare for Kimi

Create the approved inputs for `implement-with-kimi`; never implement the product itself. Keep all generated artifacts inside the target Git worktree and preserve unrelated or pre-existing changes.

## Establish shared understanding

1. Read the target repository's `AGENTS.md`, existing documentation, code, and design metadata before asking factual questions.
2. Classify the work explicitly as `greenfield` or `existing-project`. In existing-project mode, preserve established paths and content unless the user approves a change; label inferred facts as unconfirmed.
3. Interview the user relentlessly about unresolved decisions. Ask exactly one question per turn, recommend an answer, and resolve dependencies in order.
4. Look up facts in the environment instead of asking the user. Treat product, architecture, and design choices as user decisions.
5. Do not create or modify project documents until the user explicitly confirms that shared understanding has been reached.

## Build the document package

After confirmation, read [references/document-contract.md](references/document-contract.md) completely and follow its version 1 contract.

1. Create or update `authority.md`, the PRD, and `implementation-package.json`; obtain the requirements-baseline approval.
2. Create or update the architecture document and stable `ADR-###` decisions; obtain the architecture-baseline approval.
3. For a UI project, require the installed `baoyu-design` Skill and follow it completely. Do not substitute an improvised design workflow when it is unavailable. Store its native HTML project under `designs/<project-name>/`, preview it over HTTP, obtain user approval, mark the selected asset `approved` in `_d_meta.json`, and then persist `ui-spec.md`. For non-UI work, record UI as `not-applicable` without creating an empty UI document.
4. Split the work into independently implementable modules. Create one Markdown specification per module with goal, scope, non-goals, dependencies, stable `AC-###` criteria, test requirements or exceptions, and related-document links.
5. Map every `REQ-###` and `NFR-###` through architecture, any applicable `FLOW-###` and `UI-###`, module ids, acceptance criteria, and planned test requirements.
6. Obtain final implementation-package approval. An upstream change invalidates every affected downstream approval; update statuses before revising dependent artifacts.

Use the templates in `assets/templates/` as starting structures, not as content to copy blindly. Do not overwrite existing files automatically. Keep paths relative to the repository and record non-default existing-project paths in the package manifest and authority document.

## Validate and hand off

Run the pure-local validator; it must not call Kimi or require a Kimi login:

```bash
node <skill-directory>/scripts/validate_package.mjs \
  --package docs/project/implementation-package.json
```

Resolve every reported error. Then run the companion local validation from `implement-with-kimi` when it is installed. Treat only `READY` as an implementation-ready package.

Finish with:

- the validated package and document paths;
- the recommended first module;
- the exact `implement-with-kimi bootstrap` command emitted by validation;
- unresolved warnings or risks;
- an explicit request for the user to invoke `$implement-with-kimi` separately.

Never start `implement-with-kimi`, contact Kimi, commit, install Skills, or push unless the user separately asks.
