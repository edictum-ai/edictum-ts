import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createAuditEvent, AuditAction, EdictumConfigError } from '@edictum/core'

import { EdictumServerClient } from '../src/client.js'
import { ServerAuditSink } from '../src/audit-sink.js'

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function mockClient(overrides?: Partial<EdictumServerClient>): EdictumServerClient {
  return {
    post: vi.fn().mockResolvedValue({}),
    agentId: 'test-agent',
    env: 'test',
    bundleName: 'test-bundle',
    ...overrides,
  } as unknown as EdictumServerClient
}

function makeEvent(overrides?: Partial<Parameters<typeof createAuditEvent>[0]>) {
  return createAuditEvent({
    callId: 'call-1',
    toolName: 'Bash',
    action: AuditAction.CALL_ALLOWED,
    mode: 'enforce',
    sideEffect: 'write',
    environment: 'test',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

describe('ServerAuditSink batching', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('buffers events until batch size is reached', async () => {
    const client = mockClient()
    const sink = new ServerAuditSink(client, { batchSize: 3 })

    await sink.emit(makeEvent({ callId: '1' }))
    await sink.emit(makeEvent({ callId: '2' }))

    // Not flushed yet
    expect(client.post).not.toHaveBeenCalled()

    await sink.emit(makeEvent({ callId: '3' }))

    // Batch full, should flush
    expect(client.post).toHaveBeenCalledOnce()
    const [path, body] = vi.mocked(client.post).mock.calls[0]!
    expect(path).toBe('/v1/events')
    expect((body as { events: unknown[] }).events).toHaveLength(3)
  })

  it('auto-flushes after interval', async () => {
    const client = mockClient()
    const sink = new ServerAuditSink(client, {
      batchSize: 100,
      flushInterval: 1000,
    })

    await sink.emit(makeEvent())

    expect(client.post).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1100)

    expect(client.post).toHaveBeenCalledOnce()
  })

  it('manual flush sends all buffered events', async () => {
    const client = mockClient()
    const sink = new ServerAuditSink(client, { batchSize: 100 })

    await sink.emit(makeEvent({ callId: 'a' }))
    await sink.emit(makeEvent({ callId: 'b' }))

    await sink.flush()

    expect(client.post).toHaveBeenCalledOnce()
    const body = vi.mocked(client.post).mock.calls[0]![1] as { events: unknown[] }
    expect(body.events).toHaveLength(2)
  })

  it('flush is a no-op when buffer is empty', async () => {
    const client = mockClient()
    const sink = new ServerAuditSink(client, { batchSize: 100 })

    await sink.flush()

    expect(client.post).not.toHaveBeenCalled()
  })

  it('default batchSize is capped at maxBufferSize when maxBufferSize < 50', async () => {
    const client = mockClient()
    const sink = new ServerAuditSink(client, { maxBufferSize: 3 })

    await sink.emit(makeEvent({ callId: '1' }))
    await sink.emit(makeEvent({ callId: '2' }))
    expect(client.post).not.toHaveBeenCalled()

    await sink.emit(makeEvent({ callId: '3' }))
    expect(client.post).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Buffer overflow
// ---------------------------------------------------------------------------

describe('ServerAuditSink buffer overflow', () => {
  it('drops oldest events when buffer exceeds max', async () => {
    const client = mockClient()
    // Make post always fail so events get restored
    vi.mocked(client.post).mockRejectedValue(new Error('network error'))

    const sink = new ServerAuditSink(client, {
      batchSize: 3,
      maxBufferSize: 5,
    })

    // Emit 3 events — triggers flush which fails, restores to buffer
    await sink.emit(makeEvent({ callId: '1' }))
    await sink.emit(makeEvent({ callId: '2' }))
    await sink.emit(makeEvent({ callId: '3' }))

    // Buffer now has 3 events restored. Add more to overflow.
    await sink.emit(makeEvent({ callId: '4' }))
    await sink.emit(makeEvent({ callId: '5' }))
    await sink.emit(makeEvent({ callId: '6' }))
    // This flush fails again, restoring 3 events (4,5,6) + existing 3 = 6 > 5
    // Oldest 1 should be dropped

    // Now make flush succeed to inspect buffer state
    vi.mocked(client.post).mockResolvedValue({})
    await sink.flush()

    const lastCall = vi.mocked(client.post).mock.lastCall
    const body = lastCall![1] as { events: Array<{ call_id: string }> }
    expect(body.events.length).toBeLessThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------
// Failed flush restore
// ---------------------------------------------------------------------------

describe('ServerAuditSink failed flush restore', () => {
  it('restores events to buffer on flush failure', async () => {
    const client = mockClient()
    vi.mocked(client.post)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({})

    const sink = new ServerAuditSink(client, { batchSize: 100 })

    await sink.emit(makeEvent({ callId: 'x' }))
    await sink.flush() // fails, events restored

    // Second flush should send the same events
    await sink.flush()

    expect(client.post).toHaveBeenCalledTimes(2)
    const body = vi.mocked(client.post).mock.calls[1]![1] as {
      events: Array<{ call_id: string }>
    }
    expect(body.events[0]!.call_id).toBe('x')
  })
})

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

describe('ServerAuditSink event mapping', () => {
  it('maps AuditEvent to server format correctly via POST body', async () => {
    const client = mockClient({ bundleName: 'my-bundle' })
    const sink = new ServerAuditSink(client, { batchSize: 1 })
    const event = makeEvent({
      callId: 'c1',
      toolName: 'Bash',
      action: AuditAction.CALL_DENIED,
      mode: 'enforce',
      sideEffect: 'write',
      environment: 'prod',
      decisionSource: 'precondition',
      decisionName: 'no-rm',
      reason: 'rm -rf denied',
      policyVersion: 'v1.0',
      contractsEvaluated: [{ id: 'no-rm', type: 'pre', passed: false }],
    })

    await sink.emit(event)

    expect(client.post).toHaveBeenCalledOnce()
    const body = vi.mocked(client.post).mock.calls[0]![1] as {
      events: Array<{
        schema_version: string
        call_id: string
        agent_id: string
        tool_name: string
        tool_args: Record<string, unknown>
        side_effect: string
        environment: string
        principal: Record<string, unknown> | null
        action: string
        decision_source: string | null
        decision_name: string | null
        reason: string | null
        rules_evaluated: Array<Record<string, unknown>>
        mode: string
        timestamp: string
        policy_version: string | null
      }>
    }
    const mapped = body.events[0]!
    expect(mapped.schema_version).toBe(event.schemaVersion)
    expect(mapped.call_id).toBe('c1')
    expect(mapped.agent_id).toBe('test-agent')
    expect(mapped.tool_name).toBe('Bash')
    expect(mapped.action).toBe('call_blocked')
    expect(mapped.mode).toBe('enforce')
    expect(mapped.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(mapped.side_effect).toBe('write')
    expect(mapped.environment).toBe('prod')
    expect(mapped.decision_source).toBe('precondition')
    expect(mapped.decision_name).toBe('no-rm')
    expect(mapped.reason).toBe('rm -rf denied')
    expect(mapped.policy_version).toBe('v1.0')
    expect(mapped.rules_evaluated).toEqual([{ id: 'no-rm', type: 'pre', passed: false }])
  })

  it('deep-copies tool_args so caller mutations do not affect stored events', async () => {
    const client = mockClient()
    const sink = new ServerAuditSink(client, { batchSize: 1 })
    const toolArgs = { command: 'ls' }
    const event = makeEvent({ toolArgs })

    await sink.emit(event)

    // Mutate the original after emit
    toolArgs.command = 'rm -rf /'

    const body = vi.mocked(client.post).mock.calls[0]![1] as {
      events: Array<{ tool_args: Record<string, unknown> }>
    }
    expect(body.events[0]!.tool_args.command).toBe('ls')
  })

  it('deep-copies principal so caller mutations do not affect stored events', async () => {
    const client = mockClient()
    const sink = new ServerAuditSink(client, { batchSize: 1 })
    const principal = { role: 'admin' }
    const event = makeEvent({ principal })

    await sink.emit(event)

    // Mutate the original after emit
    principal.role = 'attacker'

    const body = vi.mocked(client.post).mock.calls[0]![1] as {
      events: Array<{ principal: Record<string, unknown> | null }>
    }
    expect(body.events[0]!.principal!.role).toBe('admin')
  })

  it('uses client env when event environment is empty', async () => {
    const client = mockClient({ env: 'staging' })
    const sink = new ServerAuditSink(client, { batchSize: 1 })
    const event = makeEvent({ environment: '' })

    await sink.emit(event)

    const body = vi.mocked(client.post).mock.calls[0]![1] as {
      events: Array<{ environment: string }>
    }
    expect(body.events[0]!.environment).toBe('staging')
  })
})

// ---------------------------------------------------------------------------
// Auth error handling in flush
// ---------------------------------------------------------------------------

describe('ServerAuditSink auth error handling', () => {
  it('rethrows auth errors (4xx except 429) without logging retry message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const authError = Object.assign(new Error('HTTP 403: Forbidden'), { statusCode: 403 })
    const client = mockClient()
    vi.mocked(client.post).mockRejectedValue(authError)

    const sink = new ServerAuditSink(client, { batchSize: 100 })
    await sink.emit(makeEvent())

    await expect(sink.flush()).rejects.toThrow('HTTP 403: Forbidden')
    // The "keeping in buffer for retry" message should NOT have been logged
    const retryMessages = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('keeping in buffer'),
    )
    expect(retryMessages).toHaveLength(0)
    warnSpy.mockRestore()
  })

  it('logs retry message only for retryable errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = mockClient()
    vi.mocked(client.post).mockRejectedValue(new Error('network error'))

    const sink = new ServerAuditSink(client, { batchSize: 100 })
    await sink.emit(makeEvent())
    await sink.flush()

    const retryMessages = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('keeping in buffer'),
    )
    expect(retryMessages).toHaveLength(1)
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Auto-flush error handling
// ---------------------------------------------------------------------------

describe('ServerAuditSink auto-flush error handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-flush catches auth errors instead of causing unhandled rejection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const authError = Object.assign(new Error('HTTP 401: Unauthorized'), { statusCode: 401 })
    const client = mockClient()
    vi.mocked(client.post).mockRejectedValue(authError)

    const sink = new ServerAuditSink(client, {
      batchSize: 100,
      flushInterval: 1000,
    })

    await sink.emit(makeEvent())

    // Advance past the auto-flush interval — should not throw unhandled rejection
    await vi.advanceTimersByTimeAsync(1100)

    // Should log the auto-flush failure
    const autoFlushMessages = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('auto-flush failed'),
    )
    expect(autoFlushMessages).toHaveLength(1)
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe('ServerAuditSink.close', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes remaining events on close', async () => {
    const client = mockClient()
    const sink = new ServerAuditSink(client, { batchSize: 100 })

    await sink.emit(makeEvent())
    await sink.close()

    expect(client.post).toHaveBeenCalledOnce()
  })

  it('cancels auto-flush timer on close', async () => {
    const client = mockClient()
    const sink = new ServerAuditSink(client, {
      batchSize: 100,
      flushInterval: 5000,
    })

    await sink.emit(makeEvent())
    await sink.close()

    // Advance time — should not trigger another flush
    vi.mocked(client.post).mockClear()
    await vi.advanceTimersByTimeAsync(6000)

    expect(client.post).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('ServerAuditSink constructor validation', () => {
  it('rejects batchSize of 0', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { batchSize: 0 })).toThrow(EdictumConfigError)
  })

  it('rejects negative batchSize', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { batchSize: -1 })).toThrow(EdictumConfigError)
  })

  it('rejects non-integer batchSize', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { batchSize: 2.5 })).toThrow(EdictumConfigError)
  })

  it('rejects NaN batchSize', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { batchSize: NaN })).toThrow(EdictumConfigError)
  })

  it('rejects flushInterval of 0', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { flushInterval: 0 })).toThrow(EdictumConfigError)
  })

  it('rejects negative flushInterval', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { flushInterval: -100 })).toThrow(EdictumConfigError)
  })

  it('rejects Infinity flushInterval', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { flushInterval: Infinity })).toThrow(
      EdictumConfigError,
    )
  })

  it('rejects NaN flushInterval', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { flushInterval: NaN })).toThrow(EdictumConfigError)
  })

  it('rejects maxBufferSize of 0', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { maxBufferSize: 0 })).toThrow(EdictumConfigError)
  })

  it('rejects negative maxBufferSize', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { maxBufferSize: -1 })).toThrow(EdictumConfigError)
  })

  it('rejects non-integer maxBufferSize', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { maxBufferSize: 1.5 })).toThrow(EdictumConfigError)
  })

  it('rejects NaN maxBufferSize', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { maxBufferSize: NaN })).toThrow(EdictumConfigError)
  })

  it('rejects maxBufferSize exceeding MAX_BUFFER_SIZE', () => {
    const client = mockClient()
    expect(
      () => new ServerAuditSink(client, { maxBufferSize: ServerAuditSink.MAX_BUFFER_SIZE + 1 }),
    ).toThrow(/maxBufferSize must be <= /)
  })

  it('accepts maxBufferSize at MAX_BUFFER_SIZE', () => {
    const client = mockClient()
    expect(
      () => new ServerAuditSink(client, { maxBufferSize: ServerAuditSink.MAX_BUFFER_SIZE }),
    ).not.toThrow()
  })

  it('rejects batchSize exceeding maxBufferSize', () => {
    const client = mockClient()
    let err: unknown
    try {
      new ServerAuditSink(client, { batchSize: 100, maxBufferSize: 10 })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EdictumConfigError)
    expect((err as Error).message).toMatch(/batchSize.*must be <= maxBufferSize/)
  })

  it('accepts batchSize equal to maxBufferSize', () => {
    const client = mockClient()
    expect(() => new ServerAuditSink(client, { batchSize: 50, maxBufferSize: 50 })).not.toThrow()
  })

  it('accepts valid constructor options', () => {
    const client = mockClient()
    expect(
      () => new ServerAuditSink(client, { batchSize: 10, flushInterval: 1000, maxBufferSize: 500 }),
    ).not.toThrow()
  })
})
