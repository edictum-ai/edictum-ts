import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { EdictumConfigError } from '@edictum/core'

import { createServerGuard } from '../src/factory.js'
import type { WatchErrorHandler } from '../src/factory.js'
import {
  TEST_YAML,
  BASE_OPTS,
  mockJson,
  mockSse,
  extractUrl,
  createMockFetch,
} from './factory-helpers.js'
import type { FetchFn } from './factory-helpers.js'

let mockFetch: ReturnType<typeof vi.fn<FetchFn>>
const mock = createMockFetch()

beforeEach(() => {
  mock.install()
  mockFetch = mock.mockFetch
  mockFetch.mockReset()
})

afterEach(() => {
  mock.restore()
})

describe('security', () => {
  it('rejects oversized yaml payloads (memory exhaustion attack)', async () => {
    mockFetch.mockImplementation(async () => mockJson({ yaml: 'x'.repeat(600_000) }))
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: 'b', autoWatch: false }),
    ).rejects.toThrow(/exceeds maximum size/)
  })

  it('rejects oversized yaml_bytes payloads (memory exhaustion attack)', async () => {
    mockFetch.mockImplementation(async () => mockJson({ yaml_bytes: 'A'.repeat(700_000) }))
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: 'b', autoWatch: false }),
    ).rejects.toThrow(/exceeds maximum size/)
  })

  it('rejects tampered YAML with a signature for different content', async () => {
    const keypair = generateKeyPairSync('ed25519')
    const pubDer = keypair.publicKey.export({ type: 'spki', format: 'der' })
    const pubHex = Buffer.from(pubDer.subarray(-32)).toString('hex')
    const legitimateSig = sign(null, Buffer.from(TEST_YAML), keypair.privateKey).toString('base64')
    const tamperedYaml = TEST_YAML.replace('rm -rf', 'ls')

    mockFetch.mockImplementation(async () =>
      mockJson({ yaml: tamperedYaml, signature: legitimateSig }),
    )

    await expect(
      createServerGuard({
        ...BASE_OPTS,
        bundleName: 'b',
        autoWatch: false,
        verifySignatures: true,
        signingPublicKey: pubHex,
      }),
    ).rejects.toThrow()
  })

  it('keeps existing rules when an updated ruleset fetch fails signature verification', async () => {
    const onWatchError = vi.fn<WatchErrorHandler>()
    const keypair = generateKeyPairSync('ed25519')
    const pubDer = keypair.publicKey.export({ type: 'spki', format: 'der' })
    const pubHex = Buffer.from(pubDer.subarray(-32)).toString('hex')
    const validSig = sign(null, Buffer.from(TEST_YAML), keypair.privateKey).toString('base64')
    let currentFetchCount = 0

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input)
      if (url.includes('/v1/rulesets/test-bundle/current')) {
        currentFetchCount++
        if (currentFetchCount === 1) {
          return mockJson({ yaml: TEST_YAML, signature: validSig })
        }
        return mockJson({ yaml: TEST_YAML, signature: 'badsig' })
      }
      if (url.includes('/v1/stream')) {
        return mockSse([
          { event: 'ruleset_updated', data: JSON.stringify({ name: 'test-bundle', version: 2 }) },
        ])
      }
      return mockJson({ error: 'not found' }, 404)
    })

    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      verifySignatures: true,
      signingPublicKey: pubHex,
      onWatchError,
    })
    const initialVersion = sg.guard.policyVersion

    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'signature_rejected', bundleName: 'test-bundle' }),
      )
    })

    expect(sg.guard.policyVersion).toBe(initialVersion)
    await sg.close()
  })

  it('does not fetch a malicious ruleset path from stream data', async () => {
    let fetchedMaliciousRuleset = false
    let sseCallCount = 0

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input)
      if (url.includes('/v1/rulesets/test-bundle/current')) {
        return mockJson({ yaml: TEST_YAML })
      }
      if (url.includes('/v1/stream')) {
        sseCallCount++
        return mockSse([
          { event: 'ruleset_updated', data: JSON.stringify({ name: '../../evil', version: 2 }) },
        ])
      }
      if (url.includes('evil')) {
        fetchedMaliciousRuleset = true
      }
      return mockJson({ error: 'not found' }, 404)
    })

    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle' })
    await vi.waitFor(() => {
      expect(sseCallCount).toBeGreaterThanOrEqual(1)
    })
    expect(fetchedMaliciousRuleset).toBe(false)
    expect(sg.client.bundleName).toBe('test-bundle')
    await sg.close()
  })

  it('ruleset_updated events refetch the current ruleset and reload the guard', async () => {
    const updatedYaml = TEST_YAML.replace('no-rm', 'no-rm-v2')
    let currentFetchCount = 0

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input)
      if (url.includes('/v1/rulesets/test-bundle/current')) {
        currentFetchCount++
        return mockJson({ yaml: currentFetchCount === 1 ? TEST_YAML : updatedYaml })
      }
      if (url.includes('/v1/stream')) {
        return mockSse([
          { event: 'ruleset_updated', data: JSON.stringify({ name: 'test-bundle', version: 2 }) },
        ])
      }
      return mockJson({ error: 'not found' }, 404)
    })

    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle' })
    const initialVersion = sg.guard.policyVersion

    await vi.waitFor(() => {
      expect(sg.guard.policyVersion).not.toBe(initialVersion)
    })

    expect(currentFetchCount).toBeGreaterThanOrEqual(2)
    expect(sg.client.bundleName).toBe('test-bundle')
    await sg.close()
  })
})

describe('unsupported assignment flow', () => {
  it('rejects bundleName=null because /v1 API requires an explicit ruleset', async () => {
    await expect(
      createServerGuard({
        ...BASE_OPTS,
        bundleName: null,
        autoWatch: true,
      }),
    ).rejects.toThrow(EdictumConfigError)
  })
})

describe('SSE watcher errors', () => {
  it('onWatchError receives parse_error when updated ruleset response is missing yaml', async () => {
    const onWatchError = vi.fn<WatchErrorHandler>()
    let currentFetchCount = 0

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input)
      if (url.includes('/v1/rulesets/test-bundle/current')) {
        currentFetchCount++
        return currentFetchCount === 1 ? mockJson({ yaml: TEST_YAML }) : mockJson({ version: 2 })
      }
      if (url.includes('/v1/stream')) {
        return mockSse([
          { event: 'ruleset_updated', data: JSON.stringify({ name: 'test-bundle', version: 2 }) },
        ])
      }
      return mockJson({ error: 'not found' }, 404)
    })

    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle', onWatchError })
    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'parse_error',
          message: expect.stringContaining('yaml'),
          bundleName: 'test-bundle',
        }),
      )
    })
    await sg.close()
  })

  it('onWatchError receives fetch_error when updated ruleset fetch fails', async () => {
    const onWatchError = vi.fn<WatchErrorHandler>()
    let currentFetchCount = 0

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input)
      if (url.includes('/v1/rulesets/test-bundle/current')) {
        currentFetchCount++
        return currentFetchCount === 1
          ? mockJson({ yaml: TEST_YAML })
          : mockJson({ error: 'not found' }, 404)
      }
      if (url.includes('/v1/stream')) {
        return mockSse([
          { event: 'ruleset_updated', data: JSON.stringify({ name: 'test-bundle', version: 2 }) },
        ])
      }
      return mockJson({ error: 'not found' }, 404)
    })

    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle', onWatchError })
    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'fetch_error', bundleName: 'test-bundle' }),
      )
    })
    await sg.close()
  })

  it('onWatchError receives reload_error when updated ruleset YAML is invalid', async () => {
    const onWatchError = vi.fn<WatchErrorHandler>()
    let currentFetchCount = 0

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input)
      if (url.includes('/v1/rulesets/test-bundle/current')) {
        currentFetchCount++
        return currentFetchCount === 1
          ? mockJson({ yaml: TEST_YAML })
          : mockJson({ yaml: 'not: valid: yaml: bundle' })
      }
      if (url.includes('/v1/stream')) {
        return mockSse([
          { event: 'ruleset_updated', data: JSON.stringify({ name: 'test-bundle', version: 2 }) },
        ])
      }
      return mockJson({ error: 'not found' }, 404)
    })

    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle', onWatchError })
    const initialVersion = sg.guard.policyVersion

    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(expect.objectContaining({ type: 'reload_error' }))
    })

    expect(sg.guard.policyVersion).toBe(initialVersion)
    await sg.close()
  })

  it('watcher survives an onWatchError callback that throws', async () => {
    const throwingHandler = vi.fn(() => {
      throw new Error('callback error')
    })
    let currentFetchCount = 0

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input)
      if (url.includes('/v1/rulesets/test-bundle/current')) {
        currentFetchCount++
        return currentFetchCount === 1 ? mockJson({ yaml: TEST_YAML }) : mockJson({ version: 2 })
      }
      if (url.includes('/v1/stream')) {
        return mockSse([
          { event: 'ruleset_updated', data: JSON.stringify({ name: 'test-bundle', version: 2 }) },
        ])
      }
      return mockJson({ error: 'not found' }, 404)
    })

    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      onWatchError: throwingHandler,
    })

    await vi.waitFor(() => {
      expect(throwingHandler).toHaveBeenCalledTimes(1)
    })

    expect(sg.guard.policyVersion).toBeTruthy()
    await sg.close()
  })
})
