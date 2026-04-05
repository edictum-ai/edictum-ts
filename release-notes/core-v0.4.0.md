# @edictum/core v0.4.0

## What changed

- Breaking: audit events now use the canonical action names `call_blocked`, `call_would_block`, `call_asked`, and `call_approval_blocked`.
- Workflow snapshots now carry richer lineage data, including stage transition details, recorded evidence, and parent session context.
- Adapter conformance coverage was expanded to keep workflow behavior aligned across the supported SDK integrations.
- Terminal workflow stages now remain active until an explicit exit gate or approval moves them forward.

## Included in this release

- PR #159: feat(core): complete TypeScript P4 workflow lineage
- PR #162: feat: add workflow adapter conformance coverage

## Validation

- `pnpm --filter @edictum/core build`
- `pnpm --filter @edictum/core test`
- `pnpm --filter @edictum/core typecheck`
