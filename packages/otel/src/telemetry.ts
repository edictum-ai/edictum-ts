/**
 * GovernanceTelemetry — OTel span and metric instrumentation.
 *
 * Wraps @opentelemetry/api to emit governance-specific spans for every
 * contract evaluation and counters for denied/allowed tool calls.
 *
 * Install: npm install @edictum/otel @opentelemetry/api
 */

import type { Counter, Meter, Tracer } from '@opentelemetry/api'
import { SpanStatusCode, metrics, trace } from '@opentelemetry/api'

import type { GovernanceTelemetryLike, TelemetryEnvelope, TelemetrySpan } from './types.js'

export class GovernanceTelemetry implements GovernanceTelemetryLike {
  private readonly _tracer: Tracer
  private readonly _meter: Meter
  private readonly _deniedCounter: Counter
  private readonly _allowedCounter: Counter

  constructor() {
    this._tracer = trace.getTracer('edictum')
    this._meter = metrics.getMeter('edictum')
    this._deniedCounter = this._meter.createCounter('edictum.calls.denied', {
      description: 'Number of denied tool calls',
    })
    this._allowedCounter = this._meter.createCounter('edictum.calls.allowed', {
      description: 'Number of allowed tool calls',
    })
  }

  /** Start a span for a tool call evaluation. */
  startToolSpan(envelope: TelemetryEnvelope): TelemetrySpan {
    // Sanitize toolName for span name — strip control chars and newlines
    // to prevent injection into trace backends. The validated name is only
    // used in the span name; the raw value is preserved in the attribute.
    // Cap at 10,000 chars per CLAUDE.md regex DoS policy, then strip control chars
    const safeName = envelope.toolName
      .slice(0, 10_000)
      .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '')
    const span = this._tracer.startSpan(`tool.execute ${safeName}`, {
      attributes: {
        'tool.name': envelope.toolName.slice(0, 10_000),
        'tool.side_effect': envelope.sideEffect,
        'tool.call_index': envelope.callIndex,
        'governance.environment': envelope.environment,
        'governance.run_id': envelope.runId,
      },
    })
    // OTel Span satisfies TelemetrySpan — setStatus signature is compatible
    // because OTel's setStatus accepts { code, message? } which is exactly
    // what TelemetrySpan declares.
    return span as unknown as TelemetrySpan
  }

  /** Increment the denied counter for the given tool. */
  recordDenial(envelope: TelemetryEnvelope, reason?: string): void {
    const attrs: Record<string, string> = {
      'tool.name': envelope.toolName,
    }
    if (reason !== undefined) {
      // Truncate to limit metric label cardinality — full reason belongs in spans
      attrs['denial.reason'] = reason.slice(0, 200)
    }
    this._deniedCounter.add(1, attrs)
  }

  /** Increment the allowed counter for the given tool. */
  recordAllowed(envelope: TelemetryEnvelope): void {
    this._allowedCounter.add(1, { 'tool.name': envelope.toolName })
  }

  /** Set span status to ERROR and end it. */
  setSpanError(span: TelemetrySpan, reason: string): void {
    span.setStatus({ code: SpanStatusCode.ERROR, message: reason })
    span.end()
  }

  /** Set span status to OK and end it. */
  setSpanOk(span: TelemetrySpan): void {
    span.setStatus({ code: SpanStatusCode.OK })
    span.end()
  }
}
