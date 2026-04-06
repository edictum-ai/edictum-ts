# @edictum/otel

Version `0.2.0`.

OpenTelemetry integration for Edictum spans and metrics.

## Install

```bash
pnpm add @edictum/otel @edictum/core @opentelemetry/api
```

## Usage

```typescript
import { createTelemetry } from '@edictum/otel'

const telemetry = await createTelemetry()
const span = telemetry.startToolSpan(envelope)
// ... run the guard or adapter ...
telemetry.setSpanOk(span)
```

## What It Adds

- OTel spans and counters around tool calls and rule evaluation
- No-op fallback when OTel packages are not installed
- `configureOtel()` for common exporter setup

## Key Exports

- `createTelemetry`
- `configureOtel`
- `hasOtel`
- `hasOtelAsync`

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/observability)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
