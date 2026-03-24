/**
 * GovernanceTelemetry — OTel span and metric instrumentation.
 *
 * Wraps @opentelemetry/api to emit governance-specific spans for every
 * contract evaluation and counters for denied/allowed tool calls.
 *
 * Install: npm install @edictum/otel @opentelemetry/api
 */

import type { Counter, Meter, Span, Tracer } from '@opentelemetry/api'
import { SpanStatusCode, metrics, trace } from '@opentelemetry/api'

import type { GovernanceTelemetryLike, TelemetryEnvelope, TelemetrySpan } from './types.js'
import { sanitize } from './sanitize.js'

/** Wraps an OTel Span to satisfy TelemetrySpan without unsafe casts. */
class OTelSpanWrapper implements TelemetrySpan {
  constructor(private readonly _span: Span) {}

  setAttribute(key: string, value: unknown): void {
    const safeKey = sanitize(key, 1000)
    if (typeof value === 'string') {
      this._span.setAttribute(safeKey, sanitize(value))
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      this._span.setAttribute(safeKey, value)
    }
  }
  setStatus(status: { code: number; message?: string }): void {
    const safe =
      status.message !== undefined
        ? { code: status.code, message: sanitize(status.message, 1000) }
        : status
    this._span.setStatus(safe)
  }
  addEvent(name: string, attributes?: Record<string, unknown>): void {
    const safeName = sanitize(name, 1000)
    if (!attributes) {
      this._span.addEvent(safeName)
      return
    }
    const safeAttrs: Record<string, string | number | boolean> = {}
    for (const [k, v] of Object.entries(attributes)) {
      const sk = sanitize(k, 1000)
      if (typeof v === 'string') safeAttrs[sk] = sanitize(String(v))
      else if (typeof v === 'number' || typeof v === 'boolean') safeAttrs[sk] = v
    }
    this._span.addEvent(safeName, safeAttrs)
  }
  end(): void {
    this._span.end()
  }
}

/** Cap and sanitize a tool name for use in span/metric attributes. */
const sanitizeToolName = (name: string): string => sanitize(name)

/** Cap and sanitize a generic attribute value. */
const sanitizeAttr = (value: string, maxLen = 10_000): string => sanitize(value, maxLen)

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
    // Sanitize toolName for span name and attributes — strip control chars
    // to prevent injection into trace backends.
    const safeName = sanitizeToolName(envelope.toolName)
    const span = this._tracer.startSpan(`tool.execute ${safeName}`, {
      attributes: {
        'tool.name': safeName,
        'tool.side_effect': sanitizeAttr(envelope.sideEffect),
        'tool.call_index': envelope.callIndex,
        'governance.environment': sanitizeAttr(envelope.environment),
        'governance.run_id': sanitizeAttr(envelope.runId),
      },
    })
    return new OTelSpanWrapper(span)
  }

  /** Increment the denied counter for the given tool. */
  recordDenial(envelope: TelemetryEnvelope, reason?: string): void {
    const attrs: Record<string, string> = {
      'tool.name': sanitizeToolName(envelope.toolName),
    }
    if (reason !== undefined) {
      // Truncate to limit metric label cardinality — full reason belongs in spans
      attrs['denial.reason'] = sanitizeAttr(reason, 200)
    }
    this._deniedCounter.add(1, attrs)
  }

  /** Increment the allowed counter for the given tool. */
  recordAllowed(envelope: TelemetryEnvelope): void {
    this._allowedCounter.add(1, { 'tool.name': sanitizeToolName(envelope.toolName) })
  }

  /** Set span status to ERROR and end it. */
  setSpanError(span: TelemetrySpan, reason: string): void {
    span.setStatus({ code: SpanStatusCode.ERROR, message: sanitizeAttr(reason, 1000) })
    span.end()
  }

  /** Set span status to OK and end it. */
  setSpanOk(span: TelemetrySpan): void {
    span.setStatus({ code: SpanStatusCode.OK })
    span.end()
  }
}
