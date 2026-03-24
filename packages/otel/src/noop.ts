/**
 * No-op implementations for when @opentelemetry/api is not installed.
 *
 * All methods silently succeed so callers never need to check availability.
 */

import type {
  GovernanceTelemetryLike,
  TelemetryEnvelope,
  TelemetrySpan,
} from "./types.js";

/** Dummy span — all operations are no-ops. */
export class NoOpSpan implements TelemetrySpan {
  setAttribute(_key: string, _value: unknown): void {
    /* no-op */
  }

  setStatus(_status: unknown, _description?: string): void {
    /* no-op */
  }

  addEvent(_name: string, _attributes?: Record<string, unknown>): void {
    /* no-op */
  }

  end(): void {
    /* no-op */
  }
}

/** Dummy tracer — returns NoOpSpan for all operations. */
export class NoOpTracer {
  startSpan(_name: string, _options?: unknown): NoOpSpan {
    return new NoOpSpan();
  }
}

/** No-op telemetry — all span/metric methods are silent no-ops. */
export class NoOpTelemetry implements GovernanceTelemetryLike {
  startToolSpan(_envelope: TelemetryEnvelope): NoOpSpan {
    return new NoOpSpan();
  }

  recordDenial(_envelope: TelemetryEnvelope, _reason?: string): void {
    /* no-op */
  }

  recordAllowed(_envelope: TelemetryEnvelope): void {
    /* no-op */
  }

  setSpanError(_span: TelemetrySpan, _reason: string): void {
    /* no-op */
  }

  setSpanOk(_span: TelemetrySpan): void {
    /* no-op */
  }
}
