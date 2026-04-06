# @edictum/openai-agents

Version `0.2.0`.

OpenAI Agents SDK adapter for Edictum. Use native input and output guardrails while keeping the same YAML ruleset you use in other SDKs.

## Install

```bash
pnpm add @edictum/openai-agents @edictum/core
```

## Usage

```typescript
import { Edictum } from '@edictum/core'
import { OpenAIAgentsAdapter } from '@edictum/openai-agents'

const guard = Edictum.fromYaml('rules.yaml')
const adapter = new OpenAIAgentsAdapter(guard, {
  sessionId: 'run-42',
  parentSessionId: 'agent-root',
})

const { inputGuardrail, outputGuardrail } = adapter.asGuardrails()
```

## Notes

- `parentSessionId` preserves lineage in emitted decision-log events
- Workflow context is included automatically when the guard has a `WorkflowRuntime`
- Native output guardrails can tripwire blocked output, but they do not rewrite tool results

## Key Exports

- `OpenAIAgentsAdapter`
- `OpenAIAgentsAdapterOptions`
- `AsGuardrailsOptions`

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
