/**
 * Security tests for GovernanceTelemetry — control char stripping, length caps.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { trace, metrics } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { MeterProvider } from '@opentelemetry/sdk-metrics'

import { GovernanceTelemetry } from '../src/telemetry.js'
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

  it('drops setAttribute when key is all control characters', () => {
    const telemetry = new GovernanceTelemetry()
    const span = telemetry.startToolSpan(ENVELOPE)
    // All-control-char key sanitizes to empty string — must not produce an '' attribute
    span.setAttribute('\x00\x1f\x7f', 'injected')
    span.end()

    const spans = spanExporter.getFinishedSpans()
    expect(spans[0]!.attributes['']).toBeUndefined()
  })

  it('drops addEvent attribute when key is all control characters', () => {
    const telemetry = new GovernanceTelemetry()
    const span = telemetry.startToolSpan(ENVELOPE)
    span.addEvent('test-event', { '\x00\x1f': 'injected', valid: 'kept' })
    span.end()

    const spans = spanExporter.getFinishedSpans()
    const event = spans[0]!.events[0]!
    expect(event.attributes!['']).toBeUndefined()
    expect(event.attributes!['valid']).toBe('kept')
  })
})
