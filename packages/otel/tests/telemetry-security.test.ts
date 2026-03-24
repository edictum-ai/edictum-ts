/**
 * Security tests for GovernanceTelemetry — control char stripping, length caps.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'

import { GovernanceTelemetry } from '../src/telemetry.js'
import type { TelemetryEnvelope } from '../src/types.js'

// ---------------------------------------------------------------------------
// In-memory metric reader for test assertions
// ---------------------------------------------------------------------------

class TestMetricReader extends MetricReader {
  protected onForceFlush(): Promise<void> {
    return Promise.resolve()
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve()
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENVELOPE: TelemetryEnvelope = {
  toolName: 'Bash',
  sideEffect: 'irreversible',
  callIndex: 0,
  environment: 'test',
  runId: 'run-123',
}

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

describe('GovernanceTelemetry security', () => {
  it('strips control characters from span name', () => {
    const telemetry = new GovernanceTelemetry()
    const envelope: TelemetryEnvelope = {
      ...ENVELOPE,
      toolName: 'Bash\x00\x1f\x7f\x9f',
    }
    telemetry.setSpanOk(telemetry.startToolSpan(envelope))

    const spans = spanExporter.getFinishedSpans()
    expect(spans[0]!.name).toBe('tool.execute Bash')
  })

  it('strips unicode line separators from span name', () => {
    const telemetry = new GovernanceTelemetry()
    const envelope: TelemetryEnvelope = {
      ...ENVELOPE,
      toolName: 'Tool\u2028Name\u2029End',
    }
    telemetry.setSpanOk(telemetry.startToolSpan(envelope))

    const spans = spanExporter.getFinishedSpans()
    expect(spans[0]!.name).toBe('tool.execute ToolNameEnd')
  })

  it('caps span name at 10,000 characters', () => {
    const telemetry = new GovernanceTelemetry()
    const longName = 'A'.repeat(10_001)
    const envelope: TelemetryEnvelope = {
      ...ENVELOPE,
      toolName: longName,
    }
    telemetry.setSpanOk(telemetry.startToolSpan(envelope))

    const spans = spanExporter.getFinishedSpans()
    // "tool.execute " prefix + 10,000 chars
    expect(spans[0]!.name).toBe(`tool.execute ${'A'.repeat(10_000)}`)
  })

  it('caps tool.name attribute at 10,000 characters', () => {
    const telemetry = new GovernanceTelemetry()
    const longName = 'B'.repeat(10_001)
    const envelope: TelemetryEnvelope = {
      ...ENVELOPE,
      toolName: longName,
    }
    telemetry.setSpanOk(telemetry.startToolSpan(envelope))

    const spans = spanExporter.getFinishedSpans()
    const attrValue = spans[0]!.attributes['tool.name'] as string
    expect(attrValue.length).toBe(10_000)
  })

  it('strips newlines from span name', () => {
    const telemetry = new GovernanceTelemetry()
    const envelope: TelemetryEnvelope = {
      ...ENVELOPE,
      toolName: 'Bash\ninjected\rheader',
    }
    telemetry.setSpanOk(telemetry.startToolSpan(envelope))

    const spans = spanExporter.getFinishedSpans()
    expect(spans[0]!.name).toBe('tool.execute Bashinjectedheader')
  })

  it('caps tool.name in denied counter at 10,000 characters', async () => {
    const telemetry = new GovernanceTelemetry()
    const longName = 'C'.repeat(10_001)
    const envelope: TelemetryEnvelope = { ...ENVELOPE, toolName: longName }
    telemetry.recordDenial(envelope, 'too long')

    const result = await metricReader.collect()
    const deniedMetric = result.resourceMetrics.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'edictum.calls.denied')

    const attrs = deniedMetric!.dataPoints[0]!.attributes
    expect((attrs['tool.name'] as string).length).toBe(10_000)
  })

  it('caps tool.name in allowed counter at 10,000 characters', async () => {
    const telemetry = new GovernanceTelemetry()
    const longName = 'D'.repeat(10_001)
    const envelope: TelemetryEnvelope = { ...ENVELOPE, toolName: longName }
    telemetry.recordAllowed(envelope)

    const result = await metricReader.collect()
    const allowedMetric = result.resourceMetrics.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'edictum.calls.allowed')

    const attrs = allowedMetric!.dataPoints[0]!.attributes
    expect((attrs['tool.name'] as string).length).toBe(10_000)
  })
})
