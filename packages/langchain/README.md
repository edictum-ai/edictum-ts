# @edictum/langchain

LangChain.js adapter for Edictum rule enforcement.

Part of [Edictum](https://github.com/edictum-ai/edictum-ts) — runtime rule enforcement for AI agent tool calls.

## Install

```bash
pnpm add @edictum/langchain @edictum/core
```

## Usage

```typescript
import { Edictum } from '@edictum/core'
import { LangChainAdapter } from '@edictum/langchain'

const guard = Edictum.fromYaml('rules.yaml')
const adapter = new LangChainAdapter(guard)
const middleware = adapter.asMiddleware()
// Pass to ToolNode or agent as tool_call_middleware
```

## API

- `LangChainAdapter` — adapter class
  - `asMiddleware(options?)` — returns `{ name, wrapToolCall }` for ToolNode
  - `asToolWrapper(options?)` — returns a wrapper function for any tool callable
  - `setPrincipal(principal)` — update principal mid-session
- `LangChainAdapterOptions` — constructor options (`sessionId`, `principal`, `principalResolver`)
- `AsMiddlewareOptions` — `{ onPostconditionWarn }` callback

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
