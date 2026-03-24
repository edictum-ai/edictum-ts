# Edictum

[![npm](https://img.shields.io/npm/v/@edictum/core?cacheSeconds=3600)](https://www.npmjs.com/package/@edictum/core)
[![License](https://img.shields.io/npm/l/@edictum/core?cacheSeconds=86400)](LICENSE)
[![Node](https://img.shields.io/node/v/@edictum/core?cacheSeconds=86400)](https://www.npmjs.com/package/@edictum/core)

Runtime contract enforcement for AI agent tool calls. TypeScript port of [edictum](https://github.com/edictum-ai/edictum) with full feature parity.

Prompts are suggestions. Contracts are enforcement.
The LLM cannot talk its way past a contract.

## The Problem

An agent says "I won't read sensitive files" -- then calls `readFile(".env")` and leaks your API keys.

Prompt engineering doesn't fix this. You need enforcement at the tool-call layer.

## Without Edictum / With Edictum

**Without** -- the agent reads your secrets:

```typescript
// Agent decides to read .env
const result = await readFile('.env')
// => "OPENAI_API_KEY=sk-abc123..."
```

**With** -- the call is denied before it executes:

```typescript
import { Edictum, EdictumDenied } from '@edictum/core'
import { readFile } from 'node:fs/promises'

// fromYaml() is synchronous — no await needed
const guard = Edictum.fromYaml('contracts.yaml')

// toolCallable must accept args as Record<string, unknown>
const governedReadFile = (args: Record<string, unknown>) => {
  const path = args.path
  if (typeof path !== 'string') throw new TypeError('path must be a string')
  return readFile(path, 'utf8')
}

try {
  await guard.run('readFile', { path: '.env' }, governedReadFile)
} catch (e) {
  if (e instanceof EdictumDenied) {
    console.log(e.reason)
    // => "Sensitive file '.env' denied."
  } else {
    throw e
  }
}
```

**The contract** -- `contracts.yaml`:

```yaml
apiVersion: edictum/v1
kind: ContractBundle
metadata:
  name: file-safety
defaults:
  mode: enforce
contracts:
  - id: deny-sensitive-reads
    type: pre
    tool: readFile
    when:
      args.path:
        contains_any: ['.env', '.secret', 'credentials', '.pem', 'id_rsa']
    then:
      effect: deny
      message: "Sensitive file '{args.path}' denied."
```

Contracts are YAML. Enforcement is deterministic -- no LLM in the evaluation path, just pattern matching against tool names and arguments. Preconditions are enforced before tool execution across all integration paths. Postcondition behavior depends on the integration method: with `guard.run()`, read-only tool output is redacted or suppressed, and write-side-effect tools receive a warning (the tool has already executed). For native framework hook adapters, postcondition redact/deny depends on whether the SDK supports result substitution (see adapter notes below).

## Install

Requires Node 22+.

```bash
pnpm add @edictum/core
```

YAML contract parsing requires `js-yaml` as an optional peer dependency:

```bash
pnpm add @edictum/core js-yaml
```

## Packages

| Package                                            | Description                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| [`@edictum/core`](packages/core)                   | Pipeline, contracts, audit, session, YAML engine. Zero runtime deps. |
| [`@edictum/vercel-ai`](packages/vercel-ai)         | Vercel AI SDK adapter                                                |
| [`@edictum/openai-agents`](packages/openai-agents) | OpenAI Agents SDK adapter                                            |
| [`@edictum/claude-sdk`](packages/claude-sdk)       | Claude Agent SDK adapter                                             |
| [`@edictum/langchain`](packages/langchain)         | LangChain.js adapter                                                 |
| [`@edictum/openclaw`](packages/openclaw)           | OpenClaw adapter (coming soon)                                       |
| [`@edictum/server`](packages/server)               | Server SDK -- HTTP client, SSE hot-reload, audit sink                |

## Works With Your Framework

**Vercel AI SDK** -- callbacks for generateText / streamText:

```typescript
import { VercelAIAdapter } from '@edictum/vercel-ai'
const adapter = new VercelAIAdapter(guard)
const { experimental_onToolCallStart, experimental_onToolCallFinish } = adapter.asCallbacks()
// Preconditions enforced via onToolCallStart. Postcondition redact/deny
// requires guard.run() for full enforcement (callbacks are notification-only).
```

**OpenAI Agents SDK** -- input/output guardrails:

```typescript
import { OpenAIAgentsAdapter } from '@edictum/openai-agents'
const adapter = new OpenAIAgentsAdapter(guard)
const { inputGuardrail, outputGuardrail } = adapter.asGuardrails()
// Note: postcondition redact requires guard.run() for full enforcement.
// asGuardrails() enforces preconditions and postcondition deny natively.
```

**Claude Agent SDK** -- pre/post tool use hooks:

```typescript
import { ClaudeAgentSDKAdapter } from '@edictum/claude-sdk'
const adapter = new ClaudeAgentSDKAdapter(guard)
const { PreToolUse, PostToolUse } = adapter.toSdkHooks()
// Preconditions fully enforced. Postcondition redact/deny sets
// updatedMCPToolOutput — use guard.run() for guaranteed enforcement.
```

**LangChain.js** -- middleware for ToolNode:

```typescript
import { LangChainAdapter } from '@edictum/langchain'
const adapter = new LangChainAdapter(guard)
const middleware = adapter.asMiddleware() // { name: "edictum", wrapToolCall }
```

Adapters are thin wrappers. All governance logic lives in the pipeline.

## What You Can Do

**Contracts** -- four types covering the full tool call lifecycle:

- **Preconditions** deny dangerous calls before execution
- **Postconditions** scan tool output -- warn, redact PII, or deny
- **Session contracts** cap total calls, per-tool calls, and retry attempts
- **Sandbox contracts** allowlist file paths, commands, and domains

**Programmatic contracts:**

```typescript
import { Edictum, Verdict } from '@edictum/core'
import type { Precondition } from '@edictum/core'

const noRm: Precondition = {
  tool: 'Bash',
  check: async (envelope) => {
    if (envelope.bashCommand?.includes('rm -rf')) return Verdict.fail('Cannot run rm -rf')
    return Verdict.pass()
  },
}

const guard = new Edictum({ contracts: [noRm] })
```

**Principal-aware enforcement** -- role-gate tools with claims and `env.*` context.

**Callbacks** -- `onDeny` / `onAllow` for logging and observability. For human-in-the-loop approvals, use `approvalBackend`.

**Observe mode** -- log what would be denied without blocking, then switch to enforce.

## Edictum Console

Optional self-hostable operations console. Contract management, live hot-reload via SSE, human-in-the-loop approvals, audit event feeds, and fleet monitoring.

```typescript
import { ServerClient } from '@edictum/server'

const client = new ServerClient({
  baseUrl: 'http://localhost:8000',
  apiKey: 'edk_production_...',
  agentId: 'my-agent',
})
```

See [edictum-console](https://github.com/edictum-ai/edictum-console) for deployment.

## Security

This is a security product. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

Every security boundary has bypass tests. Every error path fails closed. Every input used in storage keys is validated.

## License

MIT -- see [LICENSE](LICENSE).

## Ecosystem

- **[edictum](https://github.com/edictum-ai/edictum)** -- Python core library (PyPI: `edictum`)
- **[edictum-ts](https://github.com/edictum-ai/edictum-ts)** -- TypeScript core library (this repo)
- **[edictum-console](https://github.com/edictum-ai/edictum-console)** -- Self-hostable server for contract management
- **[edictum-schemas](https://github.com/edictum-ai/edictum-schemas)** -- Shared YAML contract schema
- **[Documentation](https://docs.edictum.ai)**
