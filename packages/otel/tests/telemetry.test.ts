/**
 * Tests for GovernanceTelemetry — real OTel span/metric instrumentation.
 *
 * Uses in-memory exporters to verify spans and metrics are emitted correctly.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { MeterProvider } from '@opentelemetry/sdk-metrics'

import { GovernanceTelemetry } from '../src/telemetry.js'
import type { TelemetryEnvelope } from '../src/types.js'
import { TestMetricReader, ENVELOPE } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let spanExporter: InMemorySpanExporter
let tracerProvider: BasicTracerProvider
let meterProvider: MeterProvider
let metricReader: TestMetricReader

beforeEach(() => {
  spanExporter = new InMemorySpanExporter()
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  })
  tracerProvider.register()

  metricReader = new TestMetricReader()
  meterProvider = new MeterProvider({ readers: [metricReader] })
  metrics.setGlobalMeterProvider(meterProvider)
})

afterEach(async () => {
  spanExporter.reset()
  trace.disable()
  metrics.disable()
  await tracerProvider.shutdown()
  await meterProvider.shutdown()
})

describe('GovernanceTelemetry', () => {
  it('startToolSpan creates a span with correct name and attributes', () => {
    const telemetry = new GovernanceTelemetry()
    const span = telemetry.startToolSpan(ENVELOPE)
    span.end()

    const spans = spanExporter.getFinishedSpans()
    expect(spans).toHaveLength(1)

    const exported = spans[0]!
    expect(exported.name).toBe('tool.execute Bash')
    expect(exported.attributes['tool.name']).toBe('Bash')
    expect(exported.attributes['tool.side_effect']).toBe('irreversible')
    expect(exported.attributes['tool.call_index']).toBe(0)
    expect(exported.attributes['governance.environment']).toBe('test')
    expect(exported.attributes['governance.run_id']).toBe('run-123')
  })

  it('setSpanOk sets OK status and ends the span', () => {
    const telemetry = new GovernanceTelemetry()
    const span = telemetry.startToolSpan(ENVELOPE)
    telemetry.setSpanOk(span)

    const spans = spanExporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]!.status.code).toBe(SpanStatusCode.OK)
  })

  it('setSpanError sets ERROR status with reason and ends the span', () => {
    const telemetry = new GovernanceTelemetry()
    const span = telemetry.startToolSpan(ENVELOPE)
    telemetry.setSpanError(span, 'rule denied: no rm -rf')

    const spans = spanExporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(spans[0]!.status.message).toBe('rule denied: no rm -rf')
  })

  it('recordDenial increments the denied counter', async () => {
    const telemetry = new GovernanceTelemetry()
    telemetry.recordDenial(ENVELOPE, 'not allowed')

    const result = await metricReader.collect()
    const deniedMetric = result.resourceMetrics.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'edictum.calls.denied')

    expect(deniedMetric).toBeDefined()
    const points = deniedMetric!.dataPoints
    expect(points).toHaveLength(1)
    expect(points[0]!.value).toBe(1)
  })

  it('recordDenial includes denial.reason in metric attributes', async () => {
    const telemetry = new GovernanceTelemetry()
    telemetry.recordDenial(ENVELOPE, 'rm -rf forbidden')

    const result = await metricReader.collect()
    const deniedMetric = result.resourceMetrics.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'edictum.calls.denied')

    const attrs = deniedMetric!.dataPoints[0]!.attributes
    expect(attrs['denial.reason']).toBe('rm -rf forbidden')
  })

  it('recordDenial omits denial.reason when not provided', async () => {
    const telemetry = new GovernanceTelemetry()
    telemetry.recordDenial(ENVELOPE)

    const result = await metricReader.collect()
    const deniedMetric = result.resourceMetrics.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'edictum.calls.denied')

    const attrs = deniedMetric!.dataPoints[0]!.attributes
    expect(attrs['denial.reason']).toBeUndefined()
  })

  it('recordAllowed increments the allowed counter', async () => {
    const telemetry = new GovernanceTelemetry()
    telemetry.recordAllowed(ENVELOPE)

    const result = await metricReader.collect()
    const allowedMetric = result.resourceMetrics.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'edictum.calls.allowed')

    expect(allowedMetric).toBeDefined()
    const points = allowedMetric!.dataPoints
    expect(points).toHaveLength(1)
    expect(points[0]!.value).toBe(1)
  })

  it('counter attributes include tool.name', async () => {
    const telemetry = new GovernanceTelemetry()
    telemetry.recordDenial(ENVELOPE)

    const result = await metricReader.collect()
    const deniedMetric = result.resourceMetrics.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'edictum.calls.denied')

    const attrs = deniedMetric!.dataPoints[0]!.attributes
    expect(attrs['tool.name']).toBe('Bash')
  })

  it('multiple envelopes produce separate spans', () => {
    const telemetry = new GovernanceTelemetry()
    const envelope2: TelemetryEnvelope = {
      ...ENVELOPE,
      toolName: 'Read',
      callIndex: 1,
      sideEffect: 'read',
    }

    telemetry.setSpanOk(telemetry.startToolSpan(ENVELOPE))
    telemetry.setSpanError(telemetry.startToolSpan(envelope2), 'denied')

    const spans = spanExporter.getFinishedSpans()
    expect(spans).toHaveLength(2)
    expect(spans[0]!.name).toBe('tool.execute Bash')
    expect(spans[1]!.name).toBe('tool.execute Read')
    expect(spans[0]!.status.code).toBe(SpanStatusCode.OK)
    expect(spans[1]!.status.code).toBe(SpanStatusCode.ERROR)
  })
})
