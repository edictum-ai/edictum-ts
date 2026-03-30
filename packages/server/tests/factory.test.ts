import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { Edictum, EdictumConfigError } from '@edictum/core'

import { createServerGuard } from '../src/factory.js'
import type { ServerGuard, WatchErrorHandler } from '../src/factory.js'
import {
  TEST_YAML,
  TEST_YAML_B64,
  TEST_YAML_OBSERVE,
  BASE_OPTS,
  mockJson,
  mockSse,
  extractUrl,
  setupFullMock,
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

function setup(bundleResponse?: Record<string, unknown>): void {
  setupFullMock(mockFetch, bundleResponse)
}

describe('validation', () => {
  it('rejects bundleName=null', async () => {
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: null, autoWatch: false }),
    ).rejects.toThrow(EdictumConfigError)
  })

  it('rejects verifySignatures without signingPublicKey', async () => {
    await expect(
      createServerGuard({
        ...BASE_OPTS,
        bundleName: 'b',
        verifySignatures: true,
        autoWatch: false,
      }),
    ).rejects.toThrow(EdictumConfigError)
  })

  it('rejects invalid URL (HTTP to non-loopback)', async () => {
    await expect(
      createServerGuard({
        ...BASE_OPTS,
        url: 'http://remote.example.com',
        bundleName: 'b',
        autoWatch: false,
      }),
    ).rejects.toThrow(/plaintext HTTP/)
  })

  it('rejects assignmentTimeout because /v1 API has no assignment flow', async () => {
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: 'b', assignmentTimeout: 1 }),
    ).rejects.toThrow(/assignmentTimeout/)
  })
})

describe('basic connection', () => {
  let sg: ServerGuard

  afterEach(async () => {
    if (sg) await sg.close()
  })

  it('fetches the initial ruleset and returns a working guard', async () => {
    setup()
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle', autoWatch: false })

    expect(sg.guard).toBeInstanceOf(Edictum)
    expect(sg.guard.policyVersion).toBeTruthy()

    const rulesetCall = mockFetch.mock.calls.find((call) =>
      extractUrl(call[0]).includes('/v1/rulesets/test-bundle/current'),
    )
    expect(rulesetCall).toBeTruthy()
  })

  it('wires up ServerAuditSink by default', async () => {
    setup()
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle', autoWatch: false })
    expect(sg.guard.auditSink).toBeTruthy()
  })

  it('creates guard without autoWatch', async () => {
    setup()
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle', autoWatch: false })
    const sseCalls = mockFetch.mock.calls.filter((call) =>
      extractUrl(call[0]).includes('/v1/stream'),
    )
    expect(sseCalls).toHaveLength(0)
  })

  it('uses ruleset defaults.mode when mode is omitted', async () => {
    setup({ yaml: TEST_YAML_OBSERVE })
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle', autoWatch: false })
    expect(sg.guard.mode).toBe('observe')
  })

  it('supports legacy yaml_bytes ruleset responses', async () => {
    setup({ yaml_bytes: TEST_YAML_B64 })
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle', autoWatch: false })
    expect(sg.guard).toBeInstanceOf(Edictum)
  })

  it('explicit mode overrides ruleset defaults.mode', async () => {
    setup({ yaml: TEST_YAML_OBSERVE })
    sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      mode: 'enforce',
    })
    expect(sg.guard.mode).toBe('enforce')
  })
})

describe('error handling', () => {
  it('throws on auth failure (401)', async () => {
    mockFetch.mockImplementation(async () => mockJson({ detail: 'Unauthorized' }, 401))
    await expect(
      createServerGuard({ ...BASE_OPTS, apiKey: 'bad-key', bundleName: 'b', autoWatch: false }),
    ).rejects.toThrow(/401/)
  })

  it('throws on missing yaml in response', async () => {
    mockFetch.mockImplementation(async () => mockJson({ some_other_field: 'value' }))
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: 'b', autoWatch: false }),
    ).rejects.toThrow(/yaml/)
  })

  it('throws on invalid YAML content', async () => {
    mockFetch.mockImplementation(async () => mockJson({ yaml: 'not: valid: yaml: bundle' }))
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: 'b', autoWatch: false }),
    ).rejects.toThrow()
  })
})

describe('signature verification', () => {
  const keypair = generateKeyPairSync('ed25519')
  const publicKeyDer = keypair.publicKey.export({ type: 'spki', format: 'der' })
  const publicKeyHex = Buffer.from(publicKeyDer.subarray(-32)).toString('hex')
  const signatureB64 = sign(null, Buffer.from(TEST_YAML), keypair.privateKey).toString('base64')
  const sigOpts = {
    verifySignatures: true,
    signingPublicKey: publicKeyHex,
    autoWatch: false,
  } as const

  it('accepts a valid signature', async () => {
    mockFetch.mockImplementation(async () => mockJson({ yaml: TEST_YAML, signature: signatureB64 }))
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'b', ...sigOpts })
    expect(sg.guard).toBeInstanceOf(Edictum)
    await sg.close()
  })

  it('rejects an invalid signature', async () => {
    mockFetch.mockImplementation(async () =>
      mockJson({ yaml: TEST_YAML, signature: Buffer.from('bad').toString('base64') }),
    )
    await expect(createServerGuard({ ...BASE_OPTS, bundleName: 'b', ...sigOpts })).rejects.toThrow()
  })

  it('rejects a missing signature when verification is enabled', async () => {
    mockFetch.mockImplementation(async () => mockJson({ yaml: TEST_YAML }))
    await expect(createServerGuard({ ...BASE_OPTS, bundleName: 'b', ...sigOpts })).rejects.toThrow(
      /signature missing/i,
    )
  })
})

describe('guard works end-to-end', () => {
  let sg: ServerGuard

  afterEach(async () => {
    if (sg) await sg.close()
  })

  it('enforces rules from the fetched ruleset', async () => {
    setup()
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: 'test-bundle', autoWatch: false })

    const safeResult = await sg.guard.run('Bash', { command: 'ls -la' }, async () => 'output')
    expect(safeResult).toBe('output')

    await expect(
      sg.guard.run('Bash', { command: 'rm -rf /' }, async () => 'should not run'),
    ).rejects.toThrow(/rm -rf/)
  })
})

describe('close()', () => {
  it('can be called multiple times safely', async () => {
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
    })
    await sg.close()
    await sg.close()
  })
})

describe('parameter behavior', () => {
  it('tags are forwarded to the client', async () => {
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      tags: { team: 'security' },
    })
    expect(sg.client.tags).toEqual({ team: 'security' })
    await sg.close()
  })

  it('timeout propagates to the client', async () => {
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      timeout: 5_000,
    })
    expect(sg.client.timeout).toBe(5_000)
    await sg.close()
  })

  it('maxRetries propagates to the client', async () => {
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      maxRetries: 5,
    })
    expect(sg.client.maxRetries).toBe(5)
    await sg.close()
  })

  it('onDeny callback fires on denied tool call', async () => {
    const onDeny = vi.fn()
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      onDeny,
    })
    await expect(
      sg.guard.run('Bash', { command: 'rm -rf /' }, async () => 'nope'),
    ).rejects.toThrow()
    expect(onDeny).toHaveBeenCalledTimes(1)
    await sg.close()
  })

  it('onAllow callback fires on allowed tool call', async () => {
    const onAllow = vi.fn()
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      onAllow,
    })
    await sg.guard.run('Bash', { command: 'ls' }, async () => 'ok')
    expect(onAllow).toHaveBeenCalledTimes(1)
    await sg.close()
  })

  it('custom audit sink receives events', async () => {
    const customSink = { emit: vi.fn(async () => {}) }
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      auditSink: customSink,
    })
    await sg.guard.run('SafeTool', { arg: 'value' }, async () => 'ok')
    expect(customSink.emit).toHaveBeenCalled()
    await sg.close()
  })

  it('mode override applies', async () => {
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      mode: 'observe',
    })
    expect(sg.guard.mode).toBe('observe')
    await sg.close()
  })

  it('allowInsecure permits HTTP to non-loopback', async () => {
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      url: 'http://remote.example.com',
      bundleName: 'test-bundle',
      autoWatch: false,
      allowInsecure: true,
    })
    expect(sg.guard).toBeInstanceOf(Edictum)
    await sg.close()
  })

  it('principal is forwarded to the guard', async () => {
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      principal: { userId: 'u1', role: 'admin' },
    })
    await sg.guard.run('SafeTool', {}, async () => 'ok')
    const events = sg.guard.localSink.events
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].principal).toMatchObject({ userId: 'u1', role: 'admin' })
    await sg.close()
  })

  it('onWatchError receives signature rejection from a ruleset update fetch', async () => {
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
    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'signature_rejected', bundleName: 'test-bundle' }),
      )
    })
    await sg.close()
  })

  it('successCheck override affects tool result evaluation', async () => {
    const successCheck = vi.fn(() => false)
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      successCheck,
    })
    await expect(sg.guard.run('SafeTool', { x: 1 }, async () => 'result')).rejects.toThrow()
    expect(successCheck).toHaveBeenCalledWith('SafeTool', 'result')
    await sg.close()
  })

  it('principalResolver override is used during tool calls', async () => {
    const principalResolver = vi.fn(() => ({ userId: 'resolved-user', role: 'operator' }))
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      principalResolver,
    })
    await sg.guard.run('SafeTool', { x: 1 }, async () => 'ok')
    expect(principalResolver).toHaveBeenCalledTimes(1)
    const events = sg.guard.localSink.events
    expect(events[0].principal).toMatchObject({ userId: 'resolved-user', role: 'operator' })
    await sg.close()
  })

  it('custom storageBackend is used for session state', async () => {
    const customBackend = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      increment: vi.fn(async () => 1),
    }
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      storageBackend: customBackend,
    })
    await sg.guard.run('SafeTool', {}, async () => 'ok')
    expect(customBackend.increment).toHaveBeenCalled()
    await sg.close()
  })

  it('custom approvalBackend is wired to the guard', async () => {
    const customApproval = {
      requestApproval: vi.fn(async () => ({ approvalId: 'test' })),
      waitForDecision: vi.fn(async () => ({ approved: true, status: 'approved' })),
    }
    setup()
    const sg = await createServerGuard({
      ...BASE_OPTS,
      bundleName: 'test-bundle',
      autoWatch: false,
      approvalBackend: customApproval,
    })
    expect(sg.guard._approvalBackend).toBe(customApproval)
    await sg.close()
  })
})
