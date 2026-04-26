# @edictum/langchain

LangChain.js adapter for Edictum agency-boundary enforcement.

Part of [Edictum](https://github.com/edictum-ai/edictum-ts): the agency control layer for production AI agents.

Agent frameworks build the agent. Edictum bounds the agency. This package composes Edictum with LangChain.js tool middleware while the core pipeline enforces rulesets and Workflow Gates.

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
