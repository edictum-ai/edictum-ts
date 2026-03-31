# @edictum/server

Server SDK for connecting Edictum-governed agents to the Edictum API.

Part of [Edictum](https://github.com/edictum-ai/edictum-ts) — runtime rule enforcement for AI agent tool calls.

## Install

```bash
pnpm add @edictum/server @edictum/core
```

## Usage

```typescript
import { createServerGuard } from '@edictum/server'

const { guard, close } = await createServerGuard({
  url: 'https://api.example.com',
  apiKey: 'edk_production_...',
  agentId: 'my-agent',
  bundleName: 'production-rules',
})

// guard is a standard Edictum instance backed by the API
// Rules hot-reload via SSE, audit events stream to the API

// Clean up on shutdown
await close()
```

## API

- `createServerGuard(options)` — factory returning `{ guard, close }` with server-backed rules, audit, sessions, and approvals
- `EdictumServerClient` — low-level HTTP client for the canonical `/v1` API
- `ServerRuleSource` — SSE-based rules hot-reload
- `ServerAuditSink` — streams audit events to the API
- `ServerBackend` — server-backed session storage
- `ServerApprovalBackend` — server-backed HITL approval workflows
- `verifyBundleSignature(bundle, publicKey)` — Ed25519 bundle signature verification

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/server)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
