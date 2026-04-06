# @edictum/langchain

Version `0.2.0`.

LangChain.js adapter for Edictum. Keep your LangChain tool graph and add deterministic rule enforcement around tool calls.

## Install

```bash
pnpm add @edictum/langchain @edictum/core
```

## Usage

```typescript
import { Edictum } from '@edictum/core'
import { LangChainAdapter } from '@edictum/langchain'

const guard = Edictum.fromYaml('rules.yaml')
const adapter = new LangChainAdapter(guard, {
  sessionId: 'run-42',
  parentSessionId: 'agent-root',
})

const middleware = adapter.asMiddleware()
// Pass to ToolNode or agent as tool_call_middleware
```

## What It Exposes

- `asMiddleware()` for ToolNode and LangChain middleware paths
- `asToolWrapper()` for wrapping arbitrary tool callables directly
- `parentSessionId` support for nested-agent lineage
- Workflow-aware events when the guard includes a `WorkflowRuntime`

## Key Exports

- `LangChainAdapter`
- `LangChainAdapterOptions`
- `AsMiddlewareOptions`
- `AsToolWrapperOptions`

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
