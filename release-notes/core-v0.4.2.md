# @edictum/core v0.4.2

## What changed

- Fix workflow evaluation so a failed current-stage command check blocks immediately instead of auto-advancing into the next stage.
- Add regression coverage for the no-exit workflow case that was letting `command_not_matches` failures slip into downstream stages.

## Included in this release

- PR #172: fix(core): block check failures before auto-advance

## Validation

- `pnpm exec vitest run tests/workflow/runtime.test.ts tests/workflow/runtime-exec.test.ts tests/workflow/runtime-set-stage.test.ts`
- `pnpm --filter @edictum/core test`
- `pnpm --filter @edictum/core build`
- `pnpm --filter @edictum/core typecheck`
