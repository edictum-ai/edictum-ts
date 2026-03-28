# @edictum/core

Runtime rule enforcement for AI agent tool calls. One runtime dep ([js-yaml](https://github.com/nodeca/js-yaml)).

Part of [Edictum](https://github.com/edictum-ai/edictum-ts) — runtime rule enforcement for AI agent tool calls.

## Install

```bash
pnpm add @edictum/core
```

## Usage

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
- `composeBundles`, `loadBundle`, `compileContracts` — YAML engine helpers
- `createViolation`, `buildViolations`, `Violation` — output-check violation helpers

## Links

- [Full documentation](https://docs.edictum.ai)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
