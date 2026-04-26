# @edictum/claude-sdk

Claude Agent SDK adapter for Edictum agency-boundary enforcement.

Part of [Edictum](https://github.com/edictum-ai/edictum-ts): the agency control layer for production AI agents.

Agent frameworks build the agent. Edictum bounds the agency. This package composes Edictum with Claude SDK tool hooks while the core pipeline enforces rulesets and Workflow Gates.

## Install

```bash
pnpm add @edictum/claude-sdk @edictum/core
```

## Usage

```typescript
import { Edictum } from '@edictum/core'
import { ClaudeAgentSDKAdapter } from '@edictum/claude-sdk'

const guard = Edictum.fromYaml('rules.yaml')
const adapter = new ClaudeAgentSDKAdapter(guard)
const { PreToolUse, PostToolUse } = adapter.toSdkHooks()
```

## API

- `ClaudeAgentSDKAdapter` — adapter class
  - `toSdkHooks(options?)` — returns `{ PreToolUse, PostToolUse }` hook callback arrays
  - `setPrincipal(principal)` — update principal mid-session
- `ClaudeAgentSDKAdapterOptions` — constructor options (`sessionId`, `principal`, `principalResolver`)
- `ToSdkHooksOptions` — `{ onPostconditionWarn }` callback

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
