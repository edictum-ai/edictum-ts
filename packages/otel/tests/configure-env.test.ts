/**
 * Tests for configureOtel() — environment variable overrides.
 *
 * Validates OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT,
 * OTEL_EXPORTER_OTLP_PROTOCOL, and OTEL_RESOURCE_ATTRIBUTES handling.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { trace, metrics } from '@opentelemetry/api'

import { configureOtel } from '../src/configure.js'

let originalEnv: NodeJS.ProcessEnv

beforeEach(() => {
  originalEnv = { ...process.env }
  trace.disable()
  metrics.disable()
})

afterEach(() => {
  process.env = originalEnv
  trace.disable()
  metrics.disable()
})

/** Verify a tracer creates real (non-no-op) spans. */
function createsRealSpans(): boolean {
  const tracer = trace.getTracer('test')
  const span = tracer.startSpan('test-span')
  const isReal = span.isRecording()
  span.end()
  return isReal
}

/** Get resource attributes from the current tracer provider. */
function getResourceAttributes(): Record<string, unknown> | null {
  const tracer = trace.getTracer('test')
  const span = tracer.startSpan('resource-check')
  const readableSpan = span as unknown as { resource?: { attributes: Record<string, unknown> } }
  const attrs = readableSpan.resource?.attributes ?? null
  span.end()
  return attrs
}

describe('configureOtel env overrides', () => {
  it('applies OTEL_SERVICE_NAME to resource attributes', async () => {
    process.env['OTEL_SERVICE_NAME'] = 'my-custom-agent'
    await configureOtel()

    const attrs = getResourceAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!['service.name']).toBe('my-custom-agent')
    trace.disable()
  })

  it('applies serviceName param to resource when env not set', async () => {
    await configureOtel({ serviceName: 'param-agent' })

    const attrs = getResourceAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!['service.name']).toBe('param-agent')
    trace.disable()
  })

  it('applies edictumVersion to resource attributes', async () => {
    await configureOtel({ edictumVersion: '0.1.0' })

    const attrs = getResourceAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!['edictum.version']).toBe('0.1.0')
    trace.disable()
  })

  it('applies custom resource attributes', async () => {
    await configureOtel({
      resourceAttributes: { 'deployment.id': 'deploy-123' },
    })

    const attrs = getResourceAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!['deployment.id']).toBe('deploy-123')
    trace.disable()
  })

  it('OTEL_SERVICE_NAME wins over service.name in OTEL_RESOURCE_ATTRIBUTES', async () => {
    process.env['OTEL_SERVICE_NAME'] = 'env-agent'
    process.env['OTEL_RESOURCE_ATTRIBUTES'] = 'service.name=wrong-agent,team=security'

    await configureOtel()

    const attrs = getResourceAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!['service.name']).toBe('env-agent')
    expect(attrs!['team']).toBe('security')
    trace.disable()
  })

  it('resourceAttributes cannot override env-set service.name', async () => {
    process.env['OTEL_SERVICE_NAME'] = 'env-agent'
    await configureOtel({
      resourceAttributes: { 'service.name': 'should-not-win' },
    })

    const attrs = getResourceAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!['service.name']).toBe('env-agent')
    trace.disable()
  })

  it('reads OTEL_EXPORTER_OTLP_ENDPOINT from env', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://collector:4317'
    await configureOtel()
    expect(createsRealSpans()).toBe(true)
    trace.disable()
  })

  it('reads OTEL_EXPORTER_OTLP_PROTOCOL from env', async () => {
    process.env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'http/protobuf'
    await configureOtel()
    expect(createsRealSpans()).toBe(true)
    trace.disable()
  })

  it('skips OTEL_RESOURCE_ATTRIBUTES pairs with control characters in key', async () => {
    process.env['OTEL_RESOURCE_ATTRIBUTES'] = 'good=value,bad\x00key=injected'
    await configureOtel()

    const attrs = getResourceAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!['good']).toBe('value')
    expect(attrs!['bad\x00key']).toBeUndefined()
    trace.disable()
  })

  it('skips OTEL_RESOURCE_ATTRIBUTES pairs with control characters in value', async () => {
    process.env['OTEL_RESOURCE_ATTRIBUTES'] = 'clean=ok,dirty=val\x1fue'
    await configureOtel()

    const attrs = getResourceAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!['clean']).toBe('ok')
    expect(attrs!['dirty']).toBeUndefined()
    trace.disable()
  })

  it('throws EdictumConfigError when OTEL_EXPORTER_OTLP_PROTOCOL is invalid', async () => {
    process.env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'invalid'
    await expect(configureOtel()).rejects.toThrow('Invalid OTel protocol')
  })

  it('throws EdictumConfigError when OTEL_EXPORTER_OTLP_ENDPOINT has non-http scheme', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'ftp://evil.example.com'
    await expect(configureOtel()).rejects.toThrow('Invalid OTel endpoint')
  })
})
