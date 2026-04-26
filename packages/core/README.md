# @edictum/core

Runtime agency-boundary enforcement for production AI agents. One runtime dep ([js-yaml](https://github.com/nodeca/js-yaml)).

Part of [Edictum](https://github.com/edictum-ai/edictum-ts): the agency control layer for production AI agents.

Agent frameworks build the agent. Edictum bounds the agency.

`@edictum/core` turns documented agent profiles into executable runtime boundaries for tools, data operations, workflow stage, evidence, approvals, and audit.

## Install

```bash
pnpm add @edictum/core
```

## Usage

This is single tool-call enforcement. For ordered process enforcement, use `WorkflowRuntime` and Workflow Gates with the same `Edictum` instance.

```typescript
import { readFile } from 'node:fs/promises'
import { Edictum, EdictumDenied } from '@edictum/core'

const guard = Edictum.fromYaml('rules.yaml')

const governedReadFile = (args: Record<string, unknown>) => readFile(args.path as string, 'utf8')

try {
  await guard.run('readFile', { path: '.env' }, governedReadFile)
} catch (e) {
  if (e instanceof EdictumDenied) console.log(e.reason)
}
```

## Key Exports

- `Edictum` — main guard class (`fromYaml`, `fromYamlString`, `run`, `evaluate`)
- `EdictumDenied`, `EdictumConfigError`, `EdictumToolError` — error types
- `CheckPipeline` — pipeline implementation used by adapters
- `Decision` — rule result builder (`pass_()`, `fail(message)`)
- `Session`, `MemoryBackend` — session tracking and storage
- `RedactionPolicy` — sensitive field redaction for audit events
- `CollectingAuditSink`, `StdoutAuditSink`, `FileAuditSink`, `CompositeSink` — audit sinks
- `createEnvelope`, `ToolCall`, `SideEffect` — tool-call construction and metadata
- `WorkflowRuntime`, `loadWorkflow`, `loadWorkflowString` — Workflow Gates for ordered stage enforcement, evidence, and approvals
- `composeBundles`, `loadBundle`, `compileContracts` — YAML engine helpers
- `createViolation`, `buildViolations`, `Violation` — output-check violation helpers

## Measurement Boundary

Edictum measures behavioral conformance to a declared profile. It does not replace output-quality evals such as accuracy, relevance, coherence, or answer quality.

## Links

- [Full documentation](https://docs.edictum.ai)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
