import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { EdictumServerClient } from '../src/client.js'
import { ServerRuleSource } from '../src/rule-source.js'

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

function sseResponse(lines: string[]): Response {
  return new Response(sseStream(lines), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('ServerRuleSource.watch', () => {
  it('yields ruleset_updated events', async () => {
    const ruleset = { name: 'default', version: 2 }
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([`event: ruleset_updated`, `data: ${JSON.stringify(ruleset)}`, ``]),
    )

    const source = new ServerRuleSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toEqual([ruleset])
  })

  it('ignores decision events from the combined stream', async () => {
    const ruleset = { name: 'default', version: 3 }
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: decision`,
        `data: ${JSON.stringify({ agent_id: 'mimi', call_id: 'c1' })}`,
        ``,
        `event: ruleset_updated`,
        `data: ${JSON.stringify(ruleset)}`,
        ``,
      ]),
    )

    const source = new ServerRuleSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toEqual([ruleset])
  })

  it('skips invalid JSON in ruleset_updated', async () => {
    const validRuleset = { name: 'default', version: 1 }
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: ruleset_updated`,
        `data: not-json`,
        ``,
        `event: ruleset_updated`,
        `data: ${JSON.stringify(validRuleset)}`,
        ``,
      ]),
    )

    const source = new ServerRuleSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toEqual([validRuleset])
  })

  it('skips non-object payloads', async () => {
    const validRuleset = { name: 'default', version: 4 }
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: ruleset_updated`,
        `data: "just a string"`,
        ``,
        `event: ruleset_updated`,
        `data: [1, 2, 3]`,
        ``,
        `event: ruleset_updated`,
        `data: ${JSON.stringify(validRuleset)}`,
        ``,
      ]),
    )

    const source = new ServerRuleSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toEqual([validRuleset])
  })

  it('skips events with invalid ruleset names', async () => {
    const validRuleset = { name: 'valid-name', version: 5 }
    const client = mockClient()
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: ruleset_updated`,
        `data: ${JSON.stringify({ name: '../escape', version: 1 })}`,
        ``,
        `event: ruleset_updated`,
        `data: ${JSON.stringify(validRuleset)}`,
        ``,
      ]),
    )

    const source = new ServerRuleSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toEqual([validRuleset])
  })

  it('filters updates to the configured ruleset name', async () => {
    const client = mockClient({ bundleName: 'target-ruleset' })
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: ruleset_updated`,
        `data: ${JSON.stringify({ name: 'other-ruleset', version: 1 })}`,
        ``,
        `event: ruleset_updated`,
        `data: ${JSON.stringify({ name: 'target-ruleset', version: 2 })}`,
        ``,
      ]),
    )

    const source = new ServerRuleSource(client)
    const results: Record<string, unknown>[] = []

    for await (const item of source.watch()) {
      results.push(item)
      await source.close()
    }

    expect(results).toEqual([{ name: 'target-ruleset', version: 2 }])
  })

  it('passes the canonical stream path to rawFetch', async () => {
    const client = mockClient()
    const source = new ServerRuleSource(client)

    vi.mocked(client.rawFetch).mockImplementation(async () => {
      await source.close()
      return sseResponse([])
    })

    for await (const _ of source.watch()) {
      // noop
    }

    expect(client.rawFetch).toHaveBeenCalledWith('/v1/stream', undefined, {
      signal: expect.any(AbortSignal),
    })
  })
})

describe('ServerRuleSource.close', () => {
  it('sets connected to false', async () => {
    const client = mockClient()
    const source = new ServerRuleSource(client)

    await source.connect()
    expect(source.connected).toBe(false)

    await source.close()
    expect(source.connected).toBe(false)
  })
})

describe('ServerRuleSource reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconnects on HTTP error', async () => {
    const client = mockClient()
    const ruleset = { name: 'default', version: 6 }

    vi.mocked(client.rawFetch)
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
      .mockResolvedValueOnce(
        sseResponse([`event: ruleset_updated`, `data: ${JSON.stringify(ruleset)}`, ``]),
      )

    const source = new ServerRuleSource(client, { reconnectDelay: 100 })
    const results: Record<string, unknown>[] = []

    const watchPromise = (async () => {
      for await (const item of source.watch()) {
        results.push(item)
        await source.close()
      }
    })()

    await vi.advanceTimersByTimeAsync(200)
    await watchPromise

    expect(results).toEqual([ruleset])
    expect(client.rawFetch).toHaveBeenCalledTimes(2)
  })
})

describe('constructor validation', () => {
  it('rejects reconnectDelay = 0', () => {
    const client = mockClient()
    expect(() => new ServerRuleSource(client, { reconnectDelay: 0 })).toThrow(/reconnectDelay/)
  })

  it('rejects reconnectDelay = NaN', () => {
    const client = mockClient()
    expect(() => new ServerRuleSource(client, { reconnectDelay: NaN })).toThrow(/reconnectDelay/)
  })

  it('rejects reconnectDelay = Infinity', () => {
    const client = mockClient()
    expect(() => new ServerRuleSource(client, { reconnectDelay: Infinity })).toThrow(
      /reconnectDelay/,
    )
  })

  it('rejects negative reconnectDelay', () => {
    const client = mockClient()
    expect(() => new ServerRuleSource(client, { reconnectDelay: -1 })).toThrow(/reconnectDelay/)
  })

  it('rejects maxReconnectDelay < reconnectDelay', () => {
    const client = mockClient()
    expect(
      () => new ServerRuleSource(client, { reconnectDelay: 5000, maxReconnectDelay: 1000 }),
    ).toThrow(/maxReconnectDelay/)
  })

  it('rejects maxReconnectDelay = NaN', () => {
    const client = mockClient()
    expect(() => new ServerRuleSource(client, { maxReconnectDelay: NaN })).toThrow(
      /maxReconnectDelay/,
    )
  })

  it('rejects maxReconnectDelay = Infinity', () => {
    const client = mockClient()
    expect(() => new ServerRuleSource(client, { maxReconnectDelay: Infinity })).toThrow(
      /maxReconnectDelay/,
    )
  })

  it('accepts valid reconnectDelay and maxReconnectDelay', () => {
    const client = mockClient()
    expect(
      () => new ServerRuleSource(client, { reconnectDelay: 500, maxReconnectDelay: 5000 }),
    ).not.toThrow()
  })

  it('reconnectDelay is used as initial delay value', () => {
    const client = mockClient()
    const source = new ServerRuleSource(client, { reconnectDelay: 200 })
    expect((source as { _reconnectDelay: number })._reconnectDelay).toBe(200)
  })

  it('maxReconnectDelay caps backoff', () => {
    const client = mockClient()
    const source = new ServerRuleSource(client, {
      reconnectDelay: 500,
      maxReconnectDelay: 2000,
    })
    expect((source as { _maxReconnectDelay: number })._maxReconnectDelay).toBe(2000)
  })
})

describe('security', () => {
  it('resets buffer when SSE data exceeds 1 MB without crashing', async () => {
    const client = mockClient()
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

    client.rawFetch = vi.fn().mockResolvedValueOnce(new Response(stream, { status: 200 }))

    const source = new ServerRuleSource(client)
    await source.connect()

    const watchPromise = (async () => {
      for await (const _ruleset of source.watch()) {
        // Should not yield anything from garbage.
      }
    })()

    await new Promise((resolve) => setTimeout(resolve, 100))
    await source.close()
    await watchPromise

    expect(source.connected).toBe(false)
  })
})
