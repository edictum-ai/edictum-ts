/**
 * Shared types for the OTel integration.
 *
 * GovernanceTelemetryLike is the interface that both GovernanceTelemetry
 * (real) and NoOpTelemetry implement. Consumers can program against this
 * interface to remain agnostic about whether OTel is actually loaded.
 */

/** Minimal toolCall shape needed by the telemetry layer. */
export interface TelemetryEnvelope {
  readonly toolName: string
  readonly sideEffect: string
  readonly callIndex: number
  readonly environment: string
  readonly runId: string
}

/**
 * Span handle returned by startToolSpan().
 *
 * Pass this back to setSpanError/setSpanOk. The real implementation
 * returns an OTel Span; the no-op returns a NoOpSpan. Both satisfy
 * this interface. Methods match the OTel Span subset we actually use.
 */
export interface TelemetrySpan {
  setAttribute(key: string, value: unknown): void
  setStatus(status: { code: number; message?: string }): void
  addEvent(name: string, attributes?: Record<string, unknown>): void
  end(): void
}

/** Interface shared by GovernanceTelemetry and NoOpTelemetry. */
export interface GovernanceTelemetryLike {
  startToolSpan(toolCall: TelemetryEnvelope): TelemetrySpan
  recordDenial(toolCall: TelemetryEnvelope, reason?: string): void
  recordAllowed(toolCall: TelemetryEnvelope): void
  setSpanError(span: TelemetrySpan, reason: string): void
  setSpanOk(span: TelemetrySpan): void
}
