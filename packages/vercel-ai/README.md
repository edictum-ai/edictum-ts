# @edictum/vercel-ai

Vercel AI SDK adapter for Edictum rule enforcement.

Part of [Edictum](https://github.com/edictum-ai/edictum-ts) — runtime rule enforcement for AI agent tool calls.

## Install

```bash
pnpm add @edictum/vercel-ai @edictum/core
```

## Usage

```typescript
import { Edictum } from '@edictum/core'
import { VercelAIAdapter } from '@edictum/vercel-ai'

const guard = Edictum.fromYaml('rules.yaml')
const adapter = new VercelAIAdapter(guard)

const result = await generateText({
  model: openai('gpt-4o'),
  tools: { myTool },
  ...adapter.asCallbacks(),
})
```

## API

- `VercelAIAdapter` — adapter class
  - `asCallbacks(options?)` — returns `{ experimental_onToolCallStart, experimental_onToolCallFinish }`
  - `setPrincipal(principal)` — update principal mid-session
- `VercelAIAdapterOptions` — constructor options (`sessionId`, `principal`, `principalResolver`)
- `AsCallbacksOptions` — `{ onPostconditionWarn }` callback

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
