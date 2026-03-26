# @edictum/core

Runtime contract enforcement for AI agent tool calls. Zero runtime deps.

Part of [Edictum](https://github.com/edictum-ai/edictum-ts) -- runtime contract enforcement for AI agent tool calls.

## Install

```bash
pnpm add @edictum/core
```

YAML contract parsing requires `js-yaml` as an optional peer dependency:

```bash
pnpm add @edictum/core js-yaml
```

## Usage

```typescript
import { readFile } from 'node:fs/promises'
import { Edictum, EdictumDenied } from '@edictum/core'

const guard = Edictum.fromYaml('contracts.yaml')

const governedReadFile = (args: Record<string, unknown>) => readFile(args.path as string, 'utf8')

try {
  await guard.run('readFile', { path: '.env' }, governedReadFile)
} catch (e) {
  if (e instanceof EdictumDenied) console.log(e.reason)
}
```

## Key Exports

- `Edictum` -- main guard class (`fromYaml`, `fromYamlString`, `run`, `evaluate`)
- `EdictumDenied`, `EdictumConfigError`, `EdictumToolError` -- error types
- `GovernancePipeline` -- governance pipeline (used by adapters)
- `Verdict` -- contract result builder (`pass()`, `fail(reason)`)
- `Session`, `MemoryBackend` -- session tracking and storage
- `RedactionPolicy` -- sensitive field redaction for audit events
- `CollectingAuditSink`, `StdoutAuditSink`, `FileAuditSink`, `CompositeSink` -- audit sinks
- `createEnvelope`, `BashClassifier`, `SideEffect` -- envelope construction
- `composeBundles`, `loadBundle`, `compileContracts` -- YAML engine

## Links

- [Full documentation](https://docs.edictum.ai)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
