# @edictum/openclaw

OpenClaw adapter for Edictum contract enforcement.

Part of [Edictum](https://github.com/edictum-ai/edictum-ts) -- runtime contract enforcement for AI agent tool calls.

## Install

```bash
pnpm add @edictum/openclaw @edictum/core
```

## Usage

```typescript
import { Edictum } from '@edictum/core'
import { createEdictumPlugin } from '@edictum/openclaw'

const guard = Edictum.fromYaml('contracts.yaml')
export default createEdictumPlugin(guard)
```

## API

- `createEdictumPlugin(guard, options?)` -- plugin factory for OpenClaw's plugin system
- `defaultPrincipalFromContext(ctx)` -- maps `senderIsOwner` to role "owner" vs "user"
- `EdictumOpenClawAdapter` -- lower-level adapter class
- `EdictumPluginOptions` -- plugin options (`priority`, `principalFromContext`, `sessionId`, `principal`)

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
