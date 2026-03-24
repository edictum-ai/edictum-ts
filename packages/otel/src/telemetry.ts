/**
 * GovernanceTelemetry — OTel span and metric instrumentation.
 *
 * Wraps @opentelemetry/api to emit governance-specific spans for every
 * contract evaluation and counters for denied/allowed tool calls.
 *
 * Install: npm install @edictum/otel @opentelemetry/api
 */

import type {
  Counter,
  Meter,
  Span,
  Tracer,
} from "@opentelemetry/api";
import {
  SpanStatusCode,
  metrics,
  trace,
} from "@opentelemetry/api";

import type {
  GovernanceTelemetryLike,
  TelemetryEnvelope,
  TelemetrySpan,
} from "./types.js";

export class GovernanceTelemetry implements GovernanceTelemetryLike {
  private readonly _tracer: Tracer;
  private readonly _meter: Meter;
  private readonly _deniedCounter: Counter;
  private readonly _allowedCounter: Counter;

  constructor() {
    this._tracer = trace.getTracer("edictum");
    this._meter = metrics.getMeter("edictum");
    this._deniedCounter = this._meter.createCounter(
      "edictum.calls.denied",
      { description: "Number of denied tool calls" },
    );
    this._allowedCounter = this._meter.createCounter(
      "edictum.calls.allowed",
      { description: "Number of allowed tool calls" },
    );
  }

  /** Start a span for a tool call evaluation. */
  startToolSpan(envelope: TelemetryEnvelope): Span {
    return this._tracer.startSpan(
      `tool.execute ${envelope.toolName}`,
      {
        attributes: {
          "tool.name": envelope.toolName,
          "tool.side_effect": envelope.sideEffect,
          "tool.call_index": envelope.callIndex,
          "governance.environment": envelope.environment,
          "governance.run_id": envelope.runId,
        },
      },
    );
  }

  /** Increment the denied counter for the given tool. */
  recordDenial(envelope: TelemetryEnvelope, _reason?: string): void {
    this._deniedCounter.add(1, { "tool.name": envelope.toolName });
  }

  /** Increment the allowed counter for the given tool. */
  recordAllowed(envelope: TelemetryEnvelope): void {
    this._allowedCounter.add(1, { "tool.name": envelope.toolName });
  }

  /** Set span status to ERROR and end it. */
  setSpanError(span: TelemetrySpan, reason: string): void {
    const s = span as Span;
    s.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    s.end();
  }

  /** Set span status to OK and end it. */
  setSpanOk(span: TelemetrySpan): void {
    const s = span as Span;
    s.setStatus({ code: SpanStatusCode.OK });
    s.end();
  }
}
