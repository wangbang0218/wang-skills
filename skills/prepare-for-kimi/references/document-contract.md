# Implementation document contract

## Contents

- Package layout
- Authority and conflict rules
- Identifiers and traceability
- Required document sections
- Approval lifecycle
- UI design handoff
- Module handoff

## Package layout

Version 1 uses UTF-8 Markdown for normative prose and one JSON manifest for deterministic validation. New projects use:

```text
docs/
├── project/
│   ├── authority.md
│   └── implementation-package.json
├── product/
│   └── prd.md
├── architecture/
│   └── architecture.md
├── design/
│   └── ui-spec.md
└── tasks/
    └── <module>.md

designs/<project-name>/
├── _d_meta.json
└── <approved HTML design and local support files>
```

Existing projects may retain established locations. Put the actual repository-relative paths in `implementation-package.json` and repeat the mapping in `authority.md`. Keep every module's agent-managed `<name>.state.md` beside `<name>.md`; never generate a state file during preparation.

Use `assets/templates/implementation-package.json` as the manifest shape. Set `schema_version` to `1`, `mode` to `greenfield` or `existing-project`, and `status` to `approved` only after all required approvals and traceability checks pass.

## Authority and conflict rules

Make `authority.md` the human entry point and declare domain ownership:

| Domain | Normative source |
| --- | --- |
| User goals, product behavior, business rules | PRD |
| Technical boundaries, components, data, interfaces, NFR implementation | Architecture and ADRs |
| Screens, visual behavior, interaction, responsive states | UI specification plus the approved Baoyu design |
| Module scope, test plan, acceptance criteria | Module specification |

A lower-level document may specialize but must not silently contradict its owner. Stop on same-domain conflicts and persist the user-confirmed resolution in the owning document. Never resolve a conflict by relying on file modification time.

Pass the manifest, authority document, PRD, architecture, and applicable UI specification as authorities for each module. Link all of them from the module's Related documents section so `implement-with-kimi` can recover the same paths on every command.

## Identifiers and traceability

Use stable ids with at least three digits:

- `REQ-###`: functional product requirement
- `NFR-###`: non-functional requirement
- `FLOW-###`: user flow
- `UI-###`: screen or interaction requirement
- `ADR-###`: architecture decision
- `MOD-###`: implementation module
- `AC-###`: acceptance criterion, scoped to one module

Do not renumber an accepted id merely because an item is removed; mark it retired and preserve history. Module AC ids may restart at `AC-001` because the module spec is the execution boundary.

Every PRD requirement needs one manifest `traceability` row. Map it to at least one architecture reference, module, module-qualified acceptance criterion such as `MOD-001:AC-001`, and planned test requirement. UI-facing functional requirements also map to existing `FLOW-###` or `UI-###` ids. Map every module AC back to at least one PRD requirement.

## Required document sections

Heading wording may be English or Chinese, but each section must be non-empty.

### Authority

- Document status
- Document map
- Authority ownership
- Conflict policy
- Change invalidation

### PRD

- Document status
- Product summary
- Goals
- Non-goals
- Users
- Scope
- Functional requirements with `REQ-###`
- Non-functional requirements with `NFR-###`, or an explicit not-applicable statement
- User flows
- Product acceptance

### Architecture

- Document status
- Context
- Constraints
- Components
- Data
- Interfaces
- Security and privacy
- Reliability and observability
- Testing strategy
- Decisions with `ADR-###`

### UI specification

- Document status
- Approved design source
- Screens
- States
- Interactions
- Responsive behavior
- Accessibility
- Traceability with `FLOW-###` and `UI-###`

### Module specification

- Goal
- Scope
- Non-goals
- Dependencies
- Acceptance criteria with stable `AC-###`
- Test requirements or explicit exceptions
- Related documents

## Approval lifecycle

Record four manifest approvals: `requirements`, `architecture`, `ui`, and `implementation`. Use `approved` only after explicit user approval. UI may be `not-applicable`; every other final status must be `approved` before handoff.

Invalidate downstream approvals as follows:

- PRD or requirements change: recheck architecture, UI, modules, traceability, and final implementation approval.
- Architecture change: recheck affected UI constraints, modules, traceability, and final implementation approval.
- Approved UI or UI specification change: recheck affected modules, traceability, and final implementation approval.
- Module or traceability change: recheck final implementation approval.

If implementation has already started, an authority or specification change requires a new `implement-with-kimi` bootstrap run and a persisted reason.

## UI design handoff

Treat `baoyu-design` as a required external Skill only when UI applies. Follow its own discovery, design-system, HTML, HTTP preview, verification, and `_d_meta.json` procedures rather than duplicating them here.

The manifest UI object must declare:

- `status`: `approved` or `not-applicable`
- `spec`: repository-relative `ui-spec.md`, or `null`
- `design_root`: repository-relative Baoyu project directory, or `null`
- `design_meta`: its `_d_meta.json`, or `null`
- `approved_assets`: project-relative HTML entry points approved by the user

For `approved`, require at least one declared asset whose matching `_d_meta.json` version is also `approved`. Images may support review but are not normative on their own. Persist implementable behavior and states in `ui-spec.md`.

## Module handoff

Keep modules narrow enough for one `implement-with-kimi` run and one active writer. Prefer vertical behavior slices with observable acceptance criteria over layer-only tasks. Declare dependencies between `MOD-###` entries and recommend a first module whose dependencies are already satisfied.

The validator returns structured authority paths and an exact bootstrap command per module. Do not execute a command automatically; the user must explicitly invoke `$implement-with-kimi` because it may send repository content to Kimi and consume quota.
