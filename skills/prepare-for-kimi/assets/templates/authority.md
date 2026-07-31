# Project authority

## Document status

Needs review. Change this status only after explicit user approval.

## Document map

- [Implementation package](implementation-package.json)
- [PRD](../product/prd.md)
- [Architecture](../architecture/architecture.md)
- [UI specification](../design/ui-spec.md)
- Module specifications: `../tasks/*.md`

## Authority ownership

- The PRD owns user goals, product behavior, and business rules.
- Architecture and ADRs own technical boundaries, interfaces, and NFR implementation.
- The UI specification and approved design own screens, interactions, and visual states.
- Each module specification owns its implementation scope, acceptance criteria, and test plan.

## Conflict policy

Stop on same-domain conflicts. Obtain a user decision and update the owning document; do not infer precedence from modification time.

## Change invalidation

Requirements changes invalidate affected architecture, UI, modules, traceability, and final approval. Architecture or approved UI changes invalidate affected modules, traceability, and final approval.
