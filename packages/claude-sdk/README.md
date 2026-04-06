# @edictum/claude-sdk

Version `0.2.0`.

Claude Agent SDK adapter for Edictum. Keep Claude's hook surface and enforce the same YAML ruleset you use in the rest of the stack.

## Install

```bash
pnpm add @edictum/claude-sdk @edictum/core
```

## Usage

```typescript
import { Edictum } from '@edictum/core'
import { ClaudeAgentSDKAdapter } from '@edictum/claude-sdk'

const guard = Edictum.fromYaml('rules.yaml')
const adapter = new ClaudeAgentSDKAdapter(guard, {
  sessionId: 'run-42',
  parentSessionId: 'agent-root',
})

const { PreToolUse, PostToolUse } = adapter.toSdkHooks()
```

## Notes

- `parentSessionId` keeps lineage for nested agent runs
- Workflow stage context and approval state are emitted when the guard has a `WorkflowRuntime`
- Post-tool output replacement depends on the Claude Agent SDK honoring `updatedMCPToolOutput`

## Key Exports

- `ClaudeAgentSDKAdapter`
- `ClaudeAgentSDKAdapterOptions`
- `ToSdkHooksOptions`

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
