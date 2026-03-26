# Edictum

[![npm](https://img.shields.io/npm/v/@edictum/core?cacheSeconds=3600)](https://www.npmjs.com/package/@edictum/core)
[![License](https://img.shields.io/npm/l/@edictum/core?cacheSeconds=86400)](LICENSE)
[![Node](https://img.shields.io/node/v/@edictum/core?cacheSeconds=86400)](https://www.npmjs.com/package/@edictum/core)
[![CI](https://github.com/edictum-ai/edictum-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/edictum-ai/edictum-ts/actions/workflows/ci.yml)

TypeScript SDK for runtime contract enforcement on AI agent tool calls.

Prompts are suggestions. Contracts are enforcement.
The LLM cannot talk its way past a contract.

**55us overhead** · **18 adapters across Python, TypeScript, Go** · **Zero runtime deps** · **Fail-closed by default**

```bash
pnpm add @edictum/core
```

YAML contract parsing requires `js-yaml` as an optional peer:

```bash
pnpm add js-yaml
```

## Quick Start

```typescript
import { readFile } from 'node:fs/promises'
import { Edictum, EdictumDenied } from '@edictum/core'

const guard = Edictum.fromYaml('contracts.yaml')

try {
  await guard.run('readFile', { path: '.env' }, readFile)
} catch (e) {
  if (e instanceof EdictumDenied) console.log(e.reason)
  // => "Sensitive file '.env' denied."
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

Contracts are YAML. Enforcement is deterministic -- no LLM in the evaluation path. The agent cannot bypass a matched contract. Errors, type mismatches, and missing fields all fail closed.

## Packages

| Package                                            | Description                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| [`@edictum/core`](packages/core)                   | Pipeline, contracts, audit, session, YAML engine. Zero runtime deps. |
| [`@edictum/vercel-ai`](packages/vercel-ai)         | Vercel AI SDK adapter                                                |
| [`@edictum/openai-agents`](packages/openai-agents) | OpenAI Agents SDK adapter                                            |
| [`@edictum/claude-sdk`](packages/claude-sdk)       | Claude Agent SDK adapter                                             |
| [`@edictum/langchain`](packages/langchain)         | LangChain.js adapter                                                 |
| [`@edictum/openclaw`](packages/openclaw)           | OpenClaw adapter                                                     |
| [`@edictum/server`](packages/server)               | Server SDK -- HTTP client, SSE hot-reload, audit sink                |
| [`@edictum/otel`](packages/otel)                   | OpenTelemetry spans and metrics                                      |

## Works With Your Framework

**Vercel AI SDK** -- callbacks for generateText / streamText:

```typescript
import { VercelAIAdapter } from '@edictum/vercel-ai'
const adapter = new VercelAIAdapter(guard)
const result = await generateText({ ...options, ...adapter.asCallbacks() })
```

**OpenAI Agents SDK** -- input/output guardrails:

```typescript
import { OpenAIAgentsAdapter } from '@edictum/openai-agents'
const adapter = new OpenAIAgentsAdapter(guard)
const { inputGuardrail, outputGuardrail } = adapter.asGuardrails()
```

**Claude Agent SDK** -- pre/post tool use hooks:

```typescript
import { ClaudeAgentSDKAdapter } from '@edictum/claude-sdk'
const adapter = new ClaudeAgentSDKAdapter(guard)
const { PreToolUse, PostToolUse } = adapter.toSdkHooks()
```

**LangChain.js** -- middleware for ToolNode:

```typescript
import { LangChainAdapter } from '@edictum/langchain'
const adapter = new LangChainAdapter(guard)
const middleware = adapter.asMiddleware()
```

**OpenClaw** -- plugin for governed tool calls:

```typescript
import { createEdictumPlugin } from '@edictum/openclaw'
export default createEdictumPlugin(guard)
```

Adapters are thin wrappers. All governance logic lives in the pipeline.

> **Postcondition enforcement:** `guard.run()` guarantees full postcondition enforcement. Native adapter hooks enforce preconditions deterministically; postcondition redact behavior depends on SDK support. See adapter docs for per-SDK details.

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
import { createServerGuard } from '@edictum/server'

const { guard, close } = await createServerGuard({
  baseUrl: 'http://localhost:8000',
  apiKey: 'edk_production_...',
  agentId: 'my-agent',
})
```

See [edictum-console](https://github.com/edictum-ai/edictum-console) for deployment.

## Research

Edictum was evaluated across six regulated domains in the GAP benchmark.

[Paper](https://arxiv.org/abs/2602.16943) -- [Benchmark](https://github.com/edictum-ai/gap-benchmark)

## Security

This is a security product. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

Every security boundary has bypass tests. Every error path fails closed. Every input used in storage keys is validated.

## Ecosystem

| Repo                                                             | Language       | Role                                       |
| ---------------------------------------------------------------- | -------------- | ------------------------------------------ |
| [edictum](https://github.com/edictum-ai/edictum)                 | Python         | Reference implementation (PyPI: `edictum`) |
| [edictum-ts](https://github.com/edictum-ai/edictum-ts)           | TypeScript     | This repo                                  |
| [edictum-go](https://github.com/edictum-ai/edictum-go)           | Go             | Full port + adapters                       |
| [edictum-console](https://github.com/edictum-ai/edictum-console) | Python + React | Self-hostable ops console                  |
| [edictum-schemas](https://github.com/edictum-ai/edictum-schemas) | YAML           | Shared contract schema                     |
| [edictum-demo](https://github.com/edictum-ai/edictum-demo)       | Python         | Demos, adversarial tests, benchmarks       |

- [Documentation](https://docs.edictum.ai)
- [Website](https://edictum.ai)

## License

MIT -- see [LICENSE](LICENSE).
