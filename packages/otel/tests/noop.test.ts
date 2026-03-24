/**
 * Tests for no-op implementations (NoOpSpan, NoOpTelemetry).
 *
 * Verifies that all methods succeed silently without OTel installed.
 */

import { describe, expect, it } from 'vitest'

import { NoOpSpan, NoOpTelemetry } from '../src/noop.js'
import type { TelemetryEnvelope } from '../src/types.js'

const ENVELOPE: TelemetryEnvelope = {
  toolName: 'Bash',
  sideEffect: 'irreversible',
  callIndex: 0,
  environment: 'test',
  runId: 'run-1',
}

describe('NoOpSpan', () => {
  it('setAttribute is a no-op', () => {
    const span = new NoOpSpan()
    expect(() => span.setAttribute('key', 'value')).not.toThrow()
  })

  it('setStatus is a no-op', () => {
    const span = new NoOpSpan()
    expect(() => span.setStatus({ code: 0 })).not.toThrow()
    expect(() => span.setStatus({ code: 2, message: 'reason' })).not.toThrow()
  })

  it('addEvent is a no-op', () => {
    const span = new NoOpSpan()
    expect(() => span.addEvent('event')).not.toThrow()
    expect(() => span.addEvent('event', { key: 'val' })).not.toThrow()
  })

  it('end is a no-op', () => {
    const span = new NoOpSpan()
    expect(() => span.end()).not.toThrow()
  })
})

describe('NoOpTelemetry', () => {
  it('startToolSpan returns a NoOpSpan', () => {
    const telemetry = new NoOpTelemetry()
    const span = telemetry.startToolSpan(ENVELOPE)
    expect(span).toBeInstanceOf(NoOpSpan)
  })

  it('recordDenial is a no-op', () => {
    const telemetry = new NoOpTelemetry()
    expect(() => telemetry.recordDenial(ENVELOPE, 'reason')).not.toThrow()
  })

  it('recordAllowed is a no-op', () => {
    const telemetry = new NoOpTelemetry()
    expect(() => telemetry.recordAllowed(ENVELOPE)).not.toThrow()
  })

  it('setSpanError is a no-op', () => {
    const telemetry = new NoOpTelemetry()
    const span = telemetry.startToolSpan(ENVELOPE)
    expect(() => telemetry.setSpanError(span, 'reason')).not.toThrow()
  })

  it('setSpanOk is a no-op', () => {
    const telemetry = new NoOpTelemetry()
    const span = telemetry.startToolSpan(ENVELOPE)
    expect(() => telemetry.setSpanOk(span)).not.toThrow()
  })

  it('implements GovernanceTelemetryLike', () => {
    const telemetry = new NoOpTelemetry()
    // All methods exist and are callable
    expect(typeof telemetry.startToolSpan).toBe('function')
    expect(typeof telemetry.recordDenial).toBe('function')
    expect(typeof telemetry.recordAllowed).toBe('function')
    expect(typeof telemetry.setSpanError).toBe('function')
    expect(typeof telemetry.setSpanOk).toBe('function')
  })
})
