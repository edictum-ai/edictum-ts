# @edictum/server

Server SDK for connecting Edictum-governed agents to [Edictum Console](https://github.com/edictum-ai/edictum-console).

Part of [Edictum](https://github.com/edictum-ai/edictum-ts) — runtime rule enforcement for AI agent tool calls.

## Install

```bash
pnpm add @edictum/server @edictum/core
```

## Usage

```typescript
import { createServerGuard } from '@edictum/server'

const { guard, close } = await createServerGuard({
  baseUrl: 'https://console.example.com',
  apiKey: 'edk_production_...',
  agentId: 'my-agent',
})

// guard is a standard Edictum instance backed by the server
// Rules hot-reload via SSE, audit events stream to the server

// Clean up on shutdown
await close()
```

## API

- `createServerGuard(options)` — factory returning `{ guard, close }` with server-backed rules, audit, sessions, and approvals
- `EdictumServerClient` — low-level HTTP client for the console API
- `ServerRuleSource` — SSE-based rules hot-reload
- `ServerAuditSink` — streams audit events to the server
- `ServerBackend` — server-backed session storage
- `ServerApprovalBackend` — server-backed HITL approval workflows
- `verifyBundleSignature(bundle, publicKey)` — Ed25519 bundle signature verification

## Links

- [Edictum Console](https://github.com/edictum-ai/edictum-console)
- [Full documentation](https://docs.edictum.ai/docs/typescript/server)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
