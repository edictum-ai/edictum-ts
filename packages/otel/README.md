# @edictum/otel

OpenTelemetry integration for Edictum behavioral conformance signals.

Part of [Edictum](https://github.com/edictum-ai/edictum-ts): the agency control layer for production AI agents.

Use this package to emit spans and metrics for runtime enforcement decisions. Edictum measures behavioral conformance to a declared profile, not output quality such as accuracy, relevance, coherence, or answer quality.

## Install

```bash
pnpm add @edictum/otel @edictum/core @opentelemetry/api
```

## Usage

```typescript
import { GovernanceTelemetry } from '@edictum/otel'

const telemetry = new GovernanceTelemetry()
const span = telemetry.startToolSpan(envelope)
// ... run pipeline ...
telemetry.setSpanOk(span) // or setSpanError(span, reason)
```

For automatic no-op fallback when OTel isn't installed:

```typescript
import { createTelemetry } from '@edictum/otel'

const telemetry = await createTelemetry()
// Returns GovernanceTelemetry if @opentelemetry/api is available, NoOpTelemetry otherwise
```

## API

- `GovernanceTelemetry` — emits rule-enforcement spans and counters (requires `@opentelemetry/api`)
- `NoOpTelemetry`, `NoOpSpan` — no-op fallback when OTel isn't installed
- `createTelemetry()` — async factory with runtime detection
- `hasOtel()`, `hasOtelAsync()` — check if `@opentelemetry/api` is available
- `configureOtel(options)` — setup helper for common OTel configurations

## Links

- [Full documentation](https://docs.edictum.ai/docs/typescript/observability)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
