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
import { query } from '@anthropic-ai/claude-agent-sdk'

const guard = Edictum.fromYaml('rules.yaml')
const adapter = new ClaudeAgentSDKAdapter(guard)

for await (const message of query({
  prompt: 'Inspect this repository',
  options: {
    hooks: adapter.toSdkHooks(),
  },
})) {
  // Consume SDK messages.
}
```

## API

- `ClaudeAgentSDKAdapter` — adapter class
  - `toSdkHooks(options?)` — returns the SDK-native `hooks` object. This is a breaking change from
    the 0.2.x shape: each event now contains hook matcher objects, not bare callback arrays.
  - `setPrincipal(principal)` — update principal mid-session
- `ClaudeAgentSDKAdapterOptions` — constructor options (`sessionId`, `principal`, `principalResolver`)
- `ToSdkHooksOptions` — `{ onPostconditionWarn }` callback

The exported hook type aliases now also resolve to the SDK-native types. Code that imported the old
structural `HookCallback`, input, or output aliases must update to the native three-argument callback
and required SDK input fields. Code that only passed `toSdkHooks()` to `options.hooks` needs no
additional bridge.

Preconditions execute before the tool and can deny it. Postconditions execute after the tool, so
they cannot undo filesystem, network, or other side effects. Native hook postconditions are detection
and warning only for both built-in and MCP tools. The SDK's supported replacement field is
`updatedToolOutput`, but its value must preserve the invoked tool's result schema. Edictum's generic
redact/deny result does not carry enough schema information to do that safely, so the adapter does not
claim output suppression. Both `PostToolUse` and `PostToolUseFailure` finalize pending calls so failed
tools still run postconditions, fire warnings, and attempt failure audit emission. An SDK failure event
is authoritative and cannot be overridden by a custom success check. Use a precondition when an
action or its output must be blocked.

Post finalization is at-most-once. If a postcondition, workflow store, session store, or audit sink
throws, the hook propagates that error but does not retry: those ports do not share a transaction or
idempotency key, and retry could duplicate durable state. This is a core transaction-boundary gap,
not a claim that failure audit is guaranteed.

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/adapters)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
