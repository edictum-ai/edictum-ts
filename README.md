# Edictum TypeScript

[![npm](https://img.shields.io/npm/v/@edictum/core?cacheSeconds=3600)](https://www.npmjs.com/package/@edictum/core)
[![License](https://img.shields.io/npm/l/@edictum/core?cacheSeconds=86400)](LICENSE)
[![Node](https://img.shields.io/node/v/@edictum/core?cacheSeconds=86400)](https://www.npmjs.com/package/@edictum/core)
[![CI](https://github.com/edictum-ai/edictum-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/edictum-ai/edictum-ts/actions/workflows/ci.yml)

> Your agents, your rules.
>
> Same YAML rules across Vercel AI, LangChain.js, OpenAI Agents SDK, Claude Agent SDK, and OpenClaw.

Edictum is the TypeScript SDK for a developer agent behavior platform. Write rules and workflows in YAML. Enforce them at the tool-call boundary, not in the prompt.

**Workflow Gates** · **Rules engine** · **5 TypeScript adapters** · **18 adapters across TypeScript, Python, and Go**

## The Problem

`CLAUDE.md` is advisory. It can tell an agent to read the spec, run tests, or avoid production. It cannot stop the next tool call.

The [GAP paper](https://arxiv.org/abs/2602.16943) measured 17,420 datapoints across 6 frontier models and found a 55-79% gap between text refusal and tool-call execution. The model says no in chat, then does the thing anyway.

Most guardrails focus on what the model says. Edictum enforces what the agent does.

## Quick Start

### 1. Install

```bash
pnpm add @edictum/core @edictum/vercel-ai
```

Swap `@edictum/vercel-ai` for `@edictum/langchain`, `@edictum/openai-agents`, or `@edictum/claude-sdk`.

### 2. Write a ruleset

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
        contains_any: ['.env', '.pem', 'id_rsa', 'credentials']
    then:
      action: block
      message: 'Blocked sensitive file read: {args.path}'
```

### 3. Wrap the SDK you already use

```typescript
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { Edictum } from '@edictum/core'
import { VercelAIAdapter } from '@edictum/vercel-ai'

const guard = Edictum.fromYaml('rules.yaml')
const adapter = new VercelAIAdapter(guard)

await generateText({
  model: openai('gpt-4.1'),
  tools: { readFile },
  ...adapter.asCallbacks(),
})
```

Same ruleset, different adapter surface:

| SDK               | Adapter call                                    |
| ----------------- | ----------------------------------------------- |
| Vercel AI SDK     | `new VercelAIAdapter(guard).asCallbacks()`      |
| LangChain.js      | `new LangChainAdapter(guard).asMiddleware()`    |
| OpenAI Agents SDK | `new OpenAIAgentsAdapter(guard).asGuardrails()` |
| Claude Agent SDK  | `new ClaudeAgentSDKAdapter(guard).toSdkHooks()` |

## Workflow Gates

Workflow Gates are stateful process enforcement. They know which stage a session is in, which files were already read, which commands ran, and whether approval happened.

```yaml
apiVersion: edictum/v1
kind: Workflow
metadata:
  name: repo-change
  description: 'Read context, implement, verify'
  version: '1.0'

stages:
  - id: read-brief
    description: 'Read the ticket and repo context'
    tools: [Read]
    exit:
      - condition: file_read("specs/feature.md")
        message: 'Read the spec first'

  - id: implement
    description: 'Make the change'
    tools: [Read, Write, Bash]
    entry:
      - condition: stage_complete("read-brief")
    exit:
      - condition: exec("pnpm test", exit_code=0)
        message: 'Tests must pass'

  - id: review
    description: 'Pause for approval'
    entry:
      - condition: stage_complete("implement")
    approval:
      message: 'Human approval required before release'
```

```typescript
import { readFile } from 'node:fs/promises'
import { Edictum, WorkflowRuntime, loadWorkflowString } from '@edictum/core'

const workflow = loadWorkflowString(await readFile('workflow.yaml', 'utf8'))
const workflowRuntime = new WorkflowRuntime(workflow, {
  execEvaluatorEnabled: true,
})

const guard = Edictum.fromYaml('rules.yaml', { workflowRuntime })
```

If you use `exec(...)` in workflow gates, enable the exec evaluator when you create the runtime.

## Rules Engine

Rulesets are deterministic YAML. No model sits in the evaluation path. Use `action: block` to stop a tool call, `action: ask` to pause for approval, `action: warn` to flag output, and `action: redact` to rewrite sensitive output before it leaves the tool boundary.

Core also supports session rules, sandbox rules, principal-aware enforcement, observe mode, and structured decision logs.

## Packages

| Package                                            | Version | Role                                                            |
| -------------------------------------------------- | ------- | --------------------------------------------------------------- |
| [`@edictum/core`](packages/core)                   | `0.3.2` | Rules engine, workflow runtime, approvals, decision log helpers |
| [`@edictum/server`](packages/server)               | `0.3.1` | Server-backed rulesets, sessions, approvals, SSE hot-reload     |
| [`@edictum/vercel-ai`](packages/vercel-ai)         | `0.2.0` | Vercel AI SDK adapter                                           |
| [`@edictum/claude-sdk`](packages/claude-sdk)       | `0.2.0` | Claude Agent SDK adapter                                        |
| [`@edictum/langchain`](packages/langchain)         | `0.2.0` | LangChain.js adapter                                            |
| [`@edictum/openai-agents`](packages/openai-agents) | `0.2.0` | OpenAI Agents SDK adapter                                       |
| [`@edictum/otel`](packages/otel)                   | `0.2.0` | OpenTelemetry integration                                       |

TypeScript has five framework adapters total: the four adapters in this monorepo plus OpenClaw in [edictum-openclaw](https://github.com/edictum-ai/edictum-openclaw). `@edictum/core`, `@edictum/server`, and `@edictum/otel` are infrastructure packages, not adapters.

## How It Works

Edictum normalizes each tool call, evaluates rules and workflow gates, applies approvals when needed, and emits a structured decision log. The enforcement path is deterministic, model-agnostic, and fail-closed on invalid input or evaluation errors.

## Research

Edictum is built against the [GAP benchmark](https://github.com/edictum-ai/gap-benchmark) and the [paper](https://arxiv.org/abs/2602.16943) behind it.

## Ecosystem

| Repo                                                               | Language       | Role                  |
| ------------------------------------------------------------------ | -------------- | --------------------- |
| [edictum](https://github.com/edictum-ai/edictum)                   | Python         | Python SDK            |
| [edictum-ts](https://github.com/edictum-ai/edictum-ts)             | TypeScript     | This repo             |
| [edictum-go](https://github.com/edictum-ai/edictum-go)             | Go             | Go SDK                |
| [edictum-openclaw](https://github.com/edictum-ai/edictum-openclaw) | TypeScript     | OpenClaw adapter      |
| [edictum-console](https://github.com/edictum-ai/edictum-console)   | Python + React | Self-hosted dashboard |
| [edictum-schemas](https://github.com/edictum-ai/edictum-schemas)   | YAML           | Shared ruleset schema |

- [Documentation](https://docs.edictum.ai)
- [Website](https://edictum.ai)

## License

MIT. See [LICENSE](LICENSE).
