# @edictum/server

Version `0.3.1`.

Server-backed rulesets, approvals, session storage, and decision-log streaming for Edictum.

## Install

```bash
pnpm add @edictum/server @edictum/core
```

## Usage

```typescript
import { createServerGuard } from '@edictum/server'

const { guard, close } = await createServerGuard({
  url: 'https://api.edictum.ai',
  apiKey: 'edk_production_...',
  agentId: 'my-agent',
  bundleName: 'production-rules',
})

// guard is a standard Edictum instance backed by the API
// rules hot-reload over SSE
// approvals and session state come from the server

await close()
```

## What It Adds

- Fetches a named ruleset from the canonical `/v1` API
- Hot-reloads rulesets over SSE
- Uses server-backed approvals and session storage
- Carries workflow context through emitted decision-log events when the attached guard is using Workflow Gates
- Preserves session lineage when adapters supply `parentSessionId`
- Supports Ed25519 signature verification for fetched rulesets

## Key Exports

- `createServerGuard`
- `EdictumServerClient`
- `ServerRuleSource`
- `ServerBackend`
- `ServerApprovalBackend`
- `ServerAuditSink`
- `verifyBundleSignature`

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/server)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
