# @edictum/claude-sdk

Claude Agent SDK adapter for Edictum contract enforcement.

Part of [Edictum](https://github.com/edictum-ai/edictum-ts) -- runtime contract enforcement for AI agent tool calls.

## Install

```bash
pnpm add @edictum/claude-sdk @edictum/core
```

## Usage

```typescript
import { Edictum } from '@edictum/core'
import { ClaudeAgentSDKAdapter } from '@edictum/claude-sdk'

const guard = Edictum.fromYaml('contracts.yaml')
const adapter = new ClaudeAgentSDKAdapter(guard)
const { PreToolUse, PostToolUse } = adapter.toSdkHooks()
```

## API

- `ClaudeAgentSDKAdapter` -- adapter class
  - `toSdkHooks(options?)` -- returns `{ PreToolUse, PostToolUse }` hook callback arrays
  - `setPrincipal(principal)` -- update principal mid-session
- `ClaudeAgentSDKAdapterOptions` -- constructor options (`sessionId`, `principal`, `principalResolver`)
- `ToSdkHooksOptions` -- `{ onPostconditionWarn }` callback

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
