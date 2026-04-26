# @edictum/openai-agents

OpenAI Agents SDK adapter for Edictum agency-boundary enforcement.

Part of [Edictum](https://github.com/edictum-ai/edictum-ts): the agency control layer for production AI agents.

Agent frameworks build the agent. Edictum bounds the agency. This package composes Edictum with OpenAI Agents SDK hooks while the core pipeline enforces rulesets and Workflow Gates.

## Install

```bash
pnpm add @edictum/openai-agents @edictum/core
```

## Usage

```typescript
import { Edictum } from '@edictum/core'
import { OpenAIAgentsAdapter } from '@edictum/openai-agents'

const guard = Edictum.fromYaml('rules.yaml')
const adapter = new OpenAIAgentsAdapter(guard)
const { inputGuardrail, outputGuardrail } = adapter.asGuardrails()
```

## API

- `OpenAIAgentsAdapter` — adapter class
  - `asGuardrails(options?)` — returns `{ inputGuardrail, outputGuardrail }`
  - `setPrincipal(principal)` — update principal mid-session
- `OpenAIAgentsAdapterOptions` — constructor options (`sessionId`, `principal`, `principalResolver`)
- `AsGuardrailsOptions` — `{ onPostconditionWarn }` callback

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
