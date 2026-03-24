/**
 * Shared types for the OTel integration.
 *
 * GovernanceTelemetryLike is the interface that both GovernanceTelemetry
 * (real) and NoOpTelemetry implement. Consumers can program against this
 * interface to remain agnostic about whether OTel is actually loaded.
 */

/** Minimal envelope shape needed by the telemetry layer. */
export interface TelemetryEnvelope {
  readonly toolName: string;
  readonly sideEffect: string;
  readonly callIndex: number;
  readonly environment: string;
  readonly runId: string;
}

/**
 * Opaque span handle returned by startToolSpan().
 *
 * Pass this back to setSpanError/setSpanOk — do not use it directly.
 * The real implementation returns an OTel Span; the no-op returns a
 * NoOpSpan. Both are compatible with this opaque type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TelemetrySpan {}

/** Interface shared by GovernanceTelemetry and NoOpTelemetry. */
export interface GovernanceTelemetryLike {
  startToolSpan(envelope: TelemetryEnvelope): TelemetrySpan;
  recordDenial(envelope: TelemetryEnvelope, reason?: string): void;
  recordAllowed(envelope: TelemetryEnvelope): void;
  setSpanError(span: TelemetrySpan, reason: string): void;
  setSpanOk(span: TelemetrySpan): void;
}
