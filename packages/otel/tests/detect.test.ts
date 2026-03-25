/**
 * Tests for runtime detection and createTelemetry factory.
 */

import { describe, expect, it, afterEach } from 'vitest'

import { createTelemetry, hasOtel, _resetHasOtelCache } from '../src/detect.js' // @internal import for test only
import { GovernanceTelemetry } from '../src/telemetry.js'

afterEach(() => {
  _resetHasOtelCache()
})

describe('hasOtel', () => {
  it('returns true when @opentelemetry/api is installed', () => {
    // In our test environment, OTel is installed as a devDependency
    expect(hasOtel()).toBe(true)
  })

  it('caches the result across calls', () => {
    const first = hasOtel()
    const second = hasOtel()
    expect(first).toBe(second)
  })

  it('cache can be reset with _resetHasOtelCache', () => {
    hasOtel() // populate cache
    _resetHasOtelCache()
    // After reset, next call re-probes
    expect(hasOtel()).toBe(true)
  })
})

describe('security', () => {
  it('rejects non-boolean globalThis.__edictum_has_otel injection', () => {
    _resetHasOtelCache()
    // Attacker tries to suppress telemetry with a non-boolean
    ;(globalThis as Record<string, unknown>).__edictum_has_otel = 'false'
    // Should fall through to CJS require.resolve (works in test env)
    expect(hasOtel()).toBe(true)
    // globalThis should be cleaned up
    expect((globalThis as Record<string, unknown>).__edictum_has_otel).toBeUndefined()
  })

  it('consumes and deletes globalThis.__edictum_has_otel after first read', () => {
    _resetHasOtelCache()
    ;(globalThis as Record<string, unknown>).__edictum_has_otel = true
    expect(hasOtel()).toBe(true)
    // After consumption, globalThis entry must be deleted
    expect((globalThis as Record<string, unknown>).__edictum_has_otel).toBeUndefined()
  })

  it('_resetHasOtelCache clears globalThis.__edictum_has_otel', () => {
    ;(globalThis as Record<string, unknown>).__edictum_has_otel = false
    _resetHasOtelCache()
    expect((globalThis as Record<string, unknown>).__edictum_has_otel).toBeUndefined()
  })
})

describe('createTelemetry', () => {
  it('returns GovernanceTelemetry when OTel is available', async () => {
    const telemetry = await createTelemetry()
    expect(telemetry).toBeInstanceOf(GovernanceTelemetry)
  })

  it('returned instance implements GovernanceTelemetryLike', async () => {
    const telemetry = await createTelemetry()
    expect(typeof telemetry.startToolSpan).toBe('function')
    expect(typeof telemetry.recordDenial).toBe('function')
    expect(typeof telemetry.recordAllowed).toBe('function')
    expect(typeof telemetry.setSpanError).toBe('function')
    expect(typeof telemetry.setSpanOk).toBe('function')
  })

  it('returns real GovernanceTelemetry (not silently falling back)', async () => {
    // Verify the factory returns a real instance, not a silent no-op.
    const telemetry = await createTelemetry()
    expect(telemetry).toBeInstanceOf(GovernanceTelemetry)
  })
})
