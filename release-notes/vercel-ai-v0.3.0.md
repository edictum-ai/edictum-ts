# @edictum/vercel-ai v0.3.0

## What changed

- Add workflow-aware adapter behavior for staged approvals, workflow audit event emission, and parent session lineage.
- Keep observe-mode audit output aligned with the canonical blocked-action names used by `@edictum/core`.
- Export the correct package version constant and document the `parentSessionId` constructor option.
- Align peer compatibility to `@edictum/core@^0.4.0` and `ai >=5 <7`.

## Included in this release

- PR #162: feat: add workflow adapter conformance coverage
- PR #163: fix: align observe-mode audit events

## Validation

- `pnpm --filter @edictum/vercel-ai build`
- `pnpm --filter @edictum/vercel-ai test`
- `pnpm --filter @edictum/vercel-ai typecheck`
