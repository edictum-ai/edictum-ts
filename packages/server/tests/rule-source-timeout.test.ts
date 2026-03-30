import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { EdictumServerClient } from '../src/client.js'
import { ServerRuleSource } from '../src/rule-source.js'

// ---------------------------------------------------------------------------
// SSE timeout — connection timeout must not kill long-lived streams
// Ref: edictum-ai/edictum#133
// ---------------------------------------------------------------------------

describe('SSE connection timeout isolation', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    fetchSpy?.mockRestore()
    fetchSpy = null
  })

  it('SSE stream survives beyond connection timeout', { timeout: 5000 }, async () => {
    // Exercises the real rawFetch connection-timeout logic by mocking
    // globalThis.fetch (not rawFetch). The correct implementation clears the
    // connectTimer once fetch() resolves, so advancing fake time past the
    // timeout window does NOT abort the stream.
    //
    // LIMITATION: This test verifies the setTimeout/clearTimeout path in
    // rawFetch. It does NOT detect a regression to AbortSignal.timeout(),
    // because AbortSignal.timeout() is not controlled by vi.useFakeTimers().
    // If a future refactor re-introduces AbortSignal.timeout(), this test
    // would still pass. See edictum-ai/edictum#133 for the original bug.
    // Tracked: https://github.com/edictum-ai/edictum-ts/issues/113
    const bundle = { name: 'default', version: 1, survived: true }
    const connectionTimeout = 100 // ms — short timeout for testing

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    })

    // Mock globalThis.fetch so the real rawFetch connection timer logic runs
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )

    const client = new EdictumServerClient({
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      timeout: connectionTimeout,
    })
    const source = new ServerRuleSource(client)
    const results: Record<string, unknown>[] = []

    const watchPromise = (async () => {
      for await (const item of source.watch()) {
        results.push(item)
        await source.close()
      }
    })()

    // Advance past the connection timeout window
    await vi.advanceTimersByTimeAsync(connectionTimeout * 3)

    // Connection was established and stream survived the timeout window
    expect(source.connected).toBe(true)
    if (!streamController) throw new Error('streamController must not be null')
    const encoder = new TextEncoder()
    const sseData = `event: ruleset_updated\ndata: ${JSON.stringify(bundle)}\n\n`
    streamController.enqueue(encoder.encode(sseData))

    // Let the event loop process the enqueued chunk
    await vi.advanceTimersByTimeAsync(10)
    await watchPromise

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(bundle)
  })

  it('connection times out when fetch never resolves', { timeout: 5000 }, async () => {
    // Exercises the connectAbort.abort() kill-path: fetch() never resolves,
    // so the connectTimer fires and aborts via connectAbort.
    const connectionTimeout = 100

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // Wire up abort so the promise rejects when the signal fires.
          // RequestInit.signal is AbortSignal | null | undefined; both null
          // and undefined are falsy, so the truthiness guard handles all cases.
          const signal = init?.signal as AbortSignal | null | undefined
          if (signal) {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          }
        }),
    )

    const client = new EdictumServerClient({
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      timeout: connectionTimeout,
    })

    const fetchPromise = client.rawFetch('/v1/stream', undefined, {})

    // Register the rejection handler BEFORE advancing timers to prevent
    // Node from flagging the rejection as unhandled during timer execution.
    const rejection = expect(fetchPromise).rejects.toThrow()

    // Advance past the connection timeout — connectAbort.abort() should fire
    await vi.advanceTimersByTimeAsync(connectionTimeout + 50)

    await rejection
  })
})
