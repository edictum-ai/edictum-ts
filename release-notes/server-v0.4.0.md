# @edictum/server v0.4.0

## What changed

- Add workflow payload parity for audit events, including session ids, stage transitions, and recorded evidence snapshots.
- Accept empty successful response bodies from the API instead of treating them as JSON parse failures.
- Validate approval `sessionId` values before sending them over the wire.
- Align the peer dependency with `@edictum/core@^0.4.0`.

## Included in this release

- PR #160: feat: add server client workflow parity

## Validation

- `pnpm --filter @edictum/server build`
- `pnpm --filter @edictum/server test`
- `pnpm --filter @edictum/server typecheck`
