# Edictum

[![npm](https://img.shields.io/npm/v/@edictum/core?cacheSeconds=3600)](https://www.npmjs.com/package/@edictum/core)
[![License](https://img.shields.io/npm/l/@edictum/core?cacheSeconds=86400)](LICENSE)
[![Node](https://img.shields.io/node/v/@edictum/core?cacheSeconds=86400)](https://www.npmjs.com/package/@edictum/core)
[![CI](https://github.com/edictum-ai/edictum-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/edictum-ai/edictum-ts/actions/workflows/ci.yml)

Edictum is the agency control layer for production AI agents in TypeScript.

Agent frameworks build the agent. Edictum bounds the agency.

Edictum turns documented agent profiles into executable runtime boundaries: tools, data operations, workflow stage, required evidence, human approvals, and audit. Rulesets enforce call-level behavior. Workflow Gates enforce ordered process across calls.

**55us overhead** · **Python, TypeScript, and Go SDKs** · **One runtime dep** ([js-yaml](https://github.com/nodeca/js-yaml)) · **Fail-closed by default**

```bash
pnpm add @edictum/core
```

## Single Tool-Call Enforcement

This quickstart blocks one tool call before execution. The same `Edictum` instance can be used directly or through a framework adapter.

```typescript
import { readFile } from 'node:fs/promises'
import { Edictum, EdictumDenied } from '@edictum/core'

const guard = Edictum.fromYaml('rules.yaml')

// toolCallable receives args as Record<string, unknown>
const governedReadFile = (args: Record<string, unknown>) => readFile(args.path as string, 'utf8')

try {
  await guard.run('readFile', { path: '.env' }, governedReadFile)
} catch (e) {
  if (e instanceof EdictumDenied) console.log(e.reason)
  // => "Sensitive file '.env' blocked."
}
```

**The single-call ruleset**: `rules.yaml`

```yaml
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: file-safety
defaults:
  mode: enforce
rules:
  - id: block-sensitive-reads
    type: pre
    tool: readFile
    when:
      args.path:
        contains_any: ['.env', '.secret', 'credentials', '.pem', 'id_rsa']
    then:
      action: block
      message: "Sensitive file '{args.path}' blocked."
```

Rules are YAML. Enforcement is deterministic — no LLM in the evaluation path. The agent cannot bypass a matched rule. Errors, type mismatches, and missing fields all fail closed.

## Workflow Gates

Workflow Gates enforce ordered process with runtime state, evidence, approvals, and audit. A ruleset can block a dangerous call; a Workflow Gate can block a call because it is happening in the wrong stage or without the required evidence.

```typescript
import { Edictum, LocalApprovalBackend, WorkflowRuntime, loadWorkflowString } from '@edictum/core'

const workflowRuntime = new WorkflowRuntime(
  loadWorkflowString(`
apiVersion: edictum/v1
kind: Workflow
metadata:
  name: release-process
stages:
  - id: read-context
    tools: [Read]
    exit:
      - condition: file_read("specs/release.md")
        message: Read the release spec first
  - id: implement
    entry:
      - condition: stage_complete("read-context")
    tools: [Edit]
  - id: review
    entry:
      - condition: stage_complete("implement")
    approval:
      message: Approval required before publish
  - id: publish
    entry:
      - condition: stage_complete("review")
    tools: [Bash]
`),
)

const guard = new Edictum({
  workflowRuntime,
  approvalBackend: new LocalApprovalBackend(),
})
```

The gate stores evidence such as completed stages and file reads, asks for approval at the review boundary, and emits audit records when a call is blocked, approved, or allowed.

## Packages

| Package                                            | Description                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| [`@edictum/core`](packages/core)                   | Agency-boundary runtime, rulesets, Workflow Gates, audit, sessions |
| [`@edictum/vercel-ai`](packages/vercel-ai)         | Vercel AI SDK adapter                                              |
| [`@edictum/openai-agents`](packages/openai-agents) | OpenAI Agents SDK adapter                                          |
| [`@edictum/claude-sdk`](packages/claude-sdk)       | Claude Agent SDK adapter                                           |
| [`@edictum/langchain`](packages/langchain)         | LangChain.js adapter                                               |
| [`@edictum/server`](packages/server)               | Server SDK: HTTP client, SSE hot-reload, approvals, audit sink     |
| [`@edictum/otel`](packages/otel)                   | OpenTelemetry spans and behavioral conformance metrics             |

## Works With Your Framework

Edictum composes with Vercel AI SDK, LangChain.js, OpenAI Agents, and Claude SDK. The framework owns planning, model calls, memory, and tool routing. Edictum enforces the declared agency boundaries at runtime.

**Vercel AI SDK** — callbacks for generateText / streamText:

```typescript
import { VercelAIAdapter } from '@edictum/vercel-ai'
const adapter = new VercelAIAdapter(guard)
const result = await generateText({ ...options, ...adapter.asCallbacks() })
```

**OpenAI Agents SDK** — input/output enforcement hooks:

```typescript
import { OpenAIAgentsAdapter } from '@edictum/openai-agents'
const adapter = new OpenAIAgentsAdapter(guard)
const { inputGuardrail, outputGuardrail } = adapter.asGuardrails()
```

**Claude Agent SDK** — pre/post tool use hooks:

```typescript
import { ClaudeAgentSDKAdapter } from '@edictum/claude-sdk'
const adapter = new ClaudeAgentSDKAdapter(guard)
const { PreToolUse, PostToolUse } = adapter.toSdkHooks()
```

**LangChain.js** — middleware for ToolNode:

```typescript
import { LangChainAdapter } from '@edictum/langchain'
const adapter = new LangChainAdapter(guard)
const middleware = adapter.asMiddleware()
```

Adapters are thin wrappers. All rule enforcement logic lives in the pipeline.

> **Output-check enforcement:** `guard.run()` guarantees full output-check enforcement. Native adapter hooks enforce preconditions deterministically; redact behavior after execution depends on SDK support. See adapter docs for per-SDK details.

## What You Can Do

**Rules** — four types covering the full tool call lifecycle:

- **Preconditions** block dangerous calls before execution
- **Postconditions** scan tool output — warn, redact PII, or block
- **Session rules** cap total calls, per-tool calls, and retry attempts
- **Sandbox rules** allowlist file paths, commands, and domains

**Programmatic rules:**

```typescript
import { Decision, Edictum } from '@edictum/core'
import type { Precondition } from '@edictum/core'

const noRm: Precondition = {
  tool: 'Bash',
  check: async (toolCall) => {
    if (toolCall.bashCommand?.includes('rm -rf')) return Decision.fail('Cannot run rm -rf')
    return Decision.pass_()
  },
}

const guard = new Edictum({ rules: [noRm] })
```

**Principal-aware enforcement** — role-gate tools with claims and `env.*` context.

**Callbacks** — `onDeny` / `onAllow` for logging and observability. For human-in-the-loop approvals, use `approvalBackend`.

**Observe mode** — log what would be blocked without blocking, then switch to enforce.

## Enterprise Profiles

Enterprises usually document an agent profile before they ship it: low, medium, or high agency; read-only, write-only, or read-write permissions; approved tools; allowed data operations; and process requirements.

Edictum makes any agency level defensible. Medium Agency is the enterprise demand center right now because those agents can act on systems of record but still need explicit boundaries.

Rulesets and Workflow Gates turn the profile into executable controls:

- **Low agency:** read-only tools, narrow data access, mostly call-level rules.
- **Medium agency:** read-write or scoped write operations, staged Workflow Gates, evidence checks, approvals at irreversible steps.
- **High agency:** broader tool access with stricter runtime enforcement, session limits, approvals, audit, and post-execution checks.

## Measurement Boundary

Edictum measures behavioral conformance to a declared profile. It does not replace output-quality evals such as accuracy, relevance, coherence, or answer quality.

## Edictum Control Plane

Optional hosted control plane. Ruleset management, live hot-reload via SSE, human-in-the-loop approvals, audit event feeds, and fleet monitoring.

```typescript
import { createServerGuard } from '@edictum/server'

const { guard, close } = await createServerGuard({
  baseUrl: 'http://localhost:8000',
  apiKey: 'edk_production_...',
  agentId: 'my-agent',
})
```

See the [control-plane docs](https://docs.edictum.ai/docs/control-plane) for the current control-plane surface.

## Research

Edictum was evaluated across six regulated domains in the GAP benchmark.

[Paper](https://arxiv.org/abs/2602.16943) — [Benchmark](https://github.com/edictum-ai/gap-benchmark)

## Security

This is a security product. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

Every security boundary has bypass tests. Every error path fails closed. Every input used in storage keys is validated.

## Ecosystem

| Repo                                                             | Language    | Role                                       |
| ---------------------------------------------------------------- | ----------- | ------------------------------------------ |
| [edictum](https://github.com/edictum-ai/edictum)                 | Python      | Reference implementation (PyPI: `edictum`) |
| [edictum-ts](https://github.com/edictum-ai/edictum-ts)           | TypeScript  | This repo                                  |
| [edictum-go](https://github.com/edictum-ai/edictum-go)           | Go          | Full port + adapters                       |
| [edictum-api](https://github.com/edictum-ai/edictum-api)         | Go          | Hosted control-plane API                   |
| [edictum-app](https://github.com/edictum-ai/edictum-app)         | React       | Hosted control-plane UI                    |
| [edictum-schemas](https://github.com/edictum-ai/edictum-schemas) | JSON Schema | Shared ruleset schema                      |
| [edictum-demo](https://github.com/edictum-ai/edictum-demo)       | Python      | Demos, adversarial tests, benchmarks       |

- [Documentation](https://docs.edictum.ai)
- [Website](https://edictum.ai)

## License

MIT — see [LICENSE](LICENSE).
