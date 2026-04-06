# @edictum/core v0.4.1

## What changed

- Fix `WorkflowRuntime.setStage()` so moving directly into an approval stage hydrates the pending approval state immediately.
- Stop implicitly advancing terminal stages that have no explicit exit unless the current evaluation actually produces a downstream transition.

## Included in this release

- PR #168: fix(core): align workflow stage move semantics

## Validation

- `pnpm --filter @edictum/core build`
- `pnpm --filter @edictum/core test`
- `pnpm --filter @edictum/core typecheck`
