import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { EdictumServerClient } from '../src/client.js'
import { ServerContractSource } from '../src/contract-source.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockClient(overrides?: Partial<EdictumServerClient>): EdictumServerClient {
  return {
    rawFetch: vi.fn(),
    agentId: 'test-agent',
    env: 'test',
    bundleName: null,
    tags: null,
    ...overrides,
  } as unknown as EdictumServerClient
}

/** Create a ReadableStream from SSE text lines. */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const text = lines.join('\n') + '\n'
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

/** Create a Response with an SSE body. */
function sseResponse(lines: string[]): Response {
  return new Response(sseStream(lines), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

describe('ServerContractSource.watch', () => {
  it('yields contract_update events', async () => {
    const bundle = { apiVersion: 'edictum/v1', revision_hash: 'abc123' }
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([`event: contract_update`, `data: ${JSON.stringify(bundle)}`, ``]),
    )

    const source = new ServerContractSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      // Close after first event to stop the loop
      await source.close()
    }

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(bundle)
  })

  it('yields assignment_changed events', async () => {
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: assignment_changed`,
        `data: ${JSON.stringify({ bundle_name: 'new-bundle' })}`,
        ``,
      ]),
    )

    const source = new ServerContractSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      _assignment_changed: true,
      bundle_name: 'new-bundle',
    })
  })

  it('skips invalid JSON in contract_update', async () => {
    const validBundle = { valid: true, revision_hash: 'r1' }
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: contract_update`,
        `data: not-json`,
        ``,
        `event: contract_update`,
        `data: ${JSON.stringify(validBundle)}`,
        ``,
      ]),
    )

    const source = new ServerContractSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(validBundle)
  })

  it('skips non-object payloads', async () => {
    const validBundle = { ok: true }
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: contract_update`,
        `data: "just a string"`,
        ``,
        `event: contract_update`,
        `data: [1, 2, 3]`,
        ``,
        `event: contract_update`,
        `data: ${JSON.stringify(validBundle)}`,
        ``,
      ]),
    )

    const source = new ServerContractSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(validBundle)
  })

  it('skips assignment_changed with invalid bundle_name', async () => {
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: assignment_changed`,
        `data: ${JSON.stringify({ bundle_name: '../escape' })}`,
        ``,
        `event: assignment_changed`,
        `data: ${JSON.stringify({ bundle_name: 'valid-name' })}`,
        ``,
      ]),
    )

    const source = new ServerContractSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toHaveLength(1)
    expect(results[0]!['bundle_name']).toBe('valid-name')
  })

  it('ignores unknown event types', async () => {
    const bundle = { data: true }
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: heartbeat`,
        `data: {}`,
        ``,
        `event: contract_update`,
        `data: ${JSON.stringify(bundle)}`,
        ``,
      ]),
    )

    const source = new ServerContractSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(bundle)
  })
})

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

describe('ServerContractSource query params', () => {
  it('passes env to rawFetch', async () => {
    const client = mockClient({ env: 'production' })
    const source = new ServerContractSource(client)

    // Close after first fetch attempt to prevent reconnect loop
    vi.mocked(client.rawFetch).mockImplementation(async () => {
      await source.close()
      return sseResponse([])
    })

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of source.watch()) {
      // Should not yield anything
    }

    expect(client.rawFetch).toHaveBeenCalledWith(
      '/api/v1/stream',
      { env: 'production' },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('passes bundle_name when set', async () => {
    const client = mockClient({ bundleName: 'my-bundle' })
    const source = new ServerContractSource(client)

    vi.mocked(client.rawFetch).mockImplementation(async () => {
      await source.close()
      return sseResponse([])
    })

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of source.watch()) {
      // noop
    }

    const params = vi.mocked(client.rawFetch).mock.calls[0]![1]
    expect(params).toHaveProperty('bundle_name', 'my-bundle')
  })

  it('passes tags as JSON when set', async () => {
    const client = mockClient({ tags: { team: 'platform' } })
    const source = new ServerContractSource(client)

    vi.mocked(client.rawFetch).mockImplementation(async () => {
      await source.close()
      return sseResponse([])
    })

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of source.watch()) {
      // noop
    }

    const params = vi.mocked(client.rawFetch).mock.calls[0]![1]
    expect(params).toHaveProperty('tags', JSON.stringify({ team: 'platform' }))
  })
})

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe('ServerContractSource.close', () => {
  it('sets connected to false', async () => {
    const client = mockClient()
    const source = new ServerContractSource(client)

    await source.connect()
    // connected stays false until watch() establishes HTTP connection
    expect(source.connected).toBe(false)

    await source.close()
    expect(source.connected).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Reconnect (unit-level)
// ---------------------------------------------------------------------------

describe('ServerContractSource reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconnects on HTTP error', async () => {
    const client = mockClient()
    const bundle = { reconnected: true }

    vi.mocked(client.rawFetch)
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
      .mockResolvedValueOnce(
        sseResponse([`event: contract_update`, `data: ${JSON.stringify(bundle)}`, ``]),
      )

    const source = new ServerContractSource(client, { reconnectDelay: 100 })
    const results: Record<string, unknown>[] = []

    const watchPromise = (async () => {
      for await (const item of source.watch()) {
        results.push(item)
        await source.close()
      }
    })()

    // Advance past reconnect delay
    await vi.advanceTimersByTimeAsync(200)
    await watchPromise

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(bundle)
    expect(client.rawFetch).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('constructor validation', () => {
  it('rejects reconnectDelay = 0', () => {
    const client = mockClient()
    expect(() => new ServerContractSource(client, { reconnectDelay: 0 })).toThrow(/reconnectDelay/)
  })

  it('rejects reconnectDelay = NaN', () => {
    const client = mockClient()
    expect(() => new ServerContractSource(client, { reconnectDelay: NaN })).toThrow(
      /reconnectDelay/,
    )
  })

  it('rejects reconnectDelay = Infinity', () => {
    const client = mockClient()
    expect(() => new ServerContractSource(client, { reconnectDelay: Infinity })).toThrow(
      /reconnectDelay/,
    )
  })

  it('rejects negative reconnectDelay', () => {
    const client = mockClient()
    expect(() => new ServerContractSource(client, { reconnectDelay: -1 })).toThrow(/reconnectDelay/)
  })

  it('rejects maxReconnectDelay < reconnectDelay', () => {
    const client = mockClient()
    expect(
      () => new ServerContractSource(client, { reconnectDelay: 5000, maxReconnectDelay: 1000 }),
    ).toThrow(/maxReconnectDelay/)
  })

  it('rejects maxReconnectDelay = NaN', () => {
    const client = mockClient()
    expect(() => new ServerContractSource(client, { maxReconnectDelay: NaN })).toThrow(
      /maxReconnectDelay/,
    )
  })

  it('rejects maxReconnectDelay = Infinity', () => {
    const client = mockClient()
    expect(() => new ServerContractSource(client, { maxReconnectDelay: Infinity })).toThrow(
      /maxReconnectDelay/,
    )
  })

  it('accepts valid reconnectDelay and maxReconnectDelay', () => {
    const client = mockClient()
    expect(
      () => new ServerContractSource(client, { reconnectDelay: 500, maxReconnectDelay: 5000 }),
    ).not.toThrow()
  })

  it('reconnectDelay is used as initial delay value', () => {
    const client = mockClient()
    const source = new ServerContractSource(client, { reconnectDelay: 200 })
    expect((source as any)._reconnectDelay).toBe(200)
  })

  it('maxReconnectDelay caps backoff', () => {
    const client = mockClient()
    const source = new ServerContractSource(client, {
      reconnectDelay: 500,
      maxReconnectDelay: 2000,
    })
    expect((source as any)._maxReconnectDelay).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// SSE timeout — connection timeout must not kill long-lived streams
// ---------------------------------------------------------------------------

describe("SSE connection timeout isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("SSE stream survives beyond connection timeout", async () => {
    // Exercises the real rawFetch connection timeout logic by mocking
    // globalThis.fetch (not rawFetch). A real EdictumServerClient with a
    // short timeout creates the connectAbort + setTimeout pair. If the
    // timeout applied to the entire fetch (bug edictum#133), the stream
    // would abort before the delayed event arrives.
    const bundle = { survived: true, revision_hash: "t1" };
    const connectionTimeout = 100; // ms — short timeout for testing

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    // Mock globalThis.fetch so the real rawFetch connection timer logic runs
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const client = new EdictumServerClient({
      baseUrl: "https://example.com",
      apiKey: "test-key",
      timeout: connectionTimeout,
    });
    const source = new ServerContractSource(client);
    const results: Record<string, unknown>[] = [];

    const watchPromise = (async () => {
      for await (const item of source.watch()) {
        results.push(item);
        await source.close();
      }
    })();

    // Advance past the connection timeout — if rawFetch used
    // AbortSignal.timeout() for the entire request, the stream
    // would be aborted here
    await vi.advanceTimersByTimeAsync(connectionTimeout * 3);

    // Stream is still alive — deliver an event now
    expect(streamController).not.toBeNull();
    const encoder = new TextEncoder();
    const sseData =
      `event: contract_update\ndata: ${JSON.stringify(bundle)}\n\n`;
    (streamController as ReadableStreamDefaultController<Uint8Array>).enqueue(
      encoder.encode(sseData),
    );

    // Let the event loop process the enqueued chunk
    await vi.advanceTimersByTimeAsync(10);
    await watchPromise;

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(bundle);

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Security — SSE buffer overflow
// ---------------------------------------------------------------------------

describe('security', () => {
  it('resets buffer when SSE data exceeds 1 MB without crashing', async () => {
    const client = mockClient()
    // 1 MB+ of garbage with no newlines, then stream closes
    const garbage = 'x'.repeat(1_100_000) + '\n'

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = encoder.encode(garbage)
        const chunkSize = 65536
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize))
        }
        controller.close()
      },
    })

    // First call: oversized stream. Second call: never (close before reconnect).
    client.rawFetch = vi.fn().mockResolvedValueOnce(new Response(stream, { status: 200 }))

    const source = new ServerContractSource(client)
    await source.connect()

    // Start watch, close immediately after first stream ends
    const watchPromise = (async () => {
      for await (const _bundle of source.watch()) {
        // Should not yield anything from garbage
      }
    })()

    // Give stream time to process, then close
    await new Promise((r) => setTimeout(r, 100))
    await source.close()
    await watchPromise

    // Watcher survived the oversized buffer — did not crash
    expect(source.connected).toBe(false)
  })
})
