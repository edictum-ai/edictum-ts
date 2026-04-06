# @edictum/vercel-ai

Version `0.2.0`.

Vercel AI SDK adapter for Edictum. Use the same YAML ruleset you use elsewhere and enforce it through `generateText()` or `streamText()`.

## Install

```bash
pnpm add @edictum/vercel-ai @edictum/core
```

## Usage

```typescript
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { Edictum } from '@edictum/core'
import { VercelAIAdapter } from '@edictum/vercel-ai'

const guard = Edictum.fromYaml('rules.yaml')
const adapter = new VercelAIAdapter(guard, {
  sessionId: 'run-42',
  parentSessionId: 'agent-root',
})

await generateText({
  model: openai('gpt-4.1'),
  tools: { myTool },
  ...adapter.asCallbacks(),
})
```

## Workflow And Lineage

- `parentSessionId` keeps lineage when one agent run starts another
- If the guard has a `WorkflowRuntime`, the adapter emits workflow stage context and approval state automatically
- The adapter surface is `asCallbacks()`, which returns `experimental_onToolCallStart` and `experimental_onToolCallFinish`

## Key Exports

- `VercelAIAdapter`
- `VercelAIAdapterOptions`
- `AsCallbacksOptions`

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
