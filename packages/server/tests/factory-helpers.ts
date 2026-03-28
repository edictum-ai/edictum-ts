/**
 * Shared test fixtures and helpers for createServerGuard() tests.
 */

import { vi } from 'vitest'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

export const TEST_YAML = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: test-bundle
defaults:
  mode: enforce
rules:
  - id: no-rm
    type: pre
    tool: Bash
    when:
      args.command:
        contains: "rm -rf"
    then:
      action: block
      message: "Cannot run rm -rf"
`

export const TEST_YAML_OBSERVE = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: observe-bundle
defaults:
  mode: observe
rules:
  - id: log-all
    type: pre
    tool: "*"
    when:
      args.x:
        exists: true
    then:
      action: block
      message: "logged"
`

export const TEST_YAML_B64 = Buffer.from(TEST_YAML).toString('base64')
export const TEST_YAML_OBSERVE_B64 = Buffer.from(TEST_YAML_OBSERVE).toString('base64')

export const BASE_OPTS = {
  url: 'http://localhost:8000',
  apiKey: 'test-key',
  agentId: 'test-agent',
} as const

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

export type FetchFn = typeof globalThis.fetch

export function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function mockSse(events: Array<{ event: string; data: string }>): Response {
  const lines = events.map((e) => `event:${e.event}\ndata:${e.data}\n\n`).join('')
  return new Response(lines, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

export function extractUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/** Standard mock that serves bundle + empty SSE + session endpoints. */
export function setupFullMock(
  mockFetch: ReturnType<typeof vi.fn<FetchFn>>,
  bundleResponse?: Record<string, unknown>,
): void {
  const bundle = bundleResponse ?? { yaml_bytes: TEST_YAML_B64 }
  mockFetch.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = extractUrl(input)
    if (url.includes('/api/v1/bundles/')) return mockJson(bundle)
    if (url.includes('/api/v1/stream')) return mockSse([])
    if (url.includes('/api/v1/sessions/') && init?.method === 'POST') return mockJson({ value: 1 })
    if (url.includes('/api/v1/sessions/')) return mockJson({ value: null })
    if (url.includes('/api/v1/events')) return mockJson({ ok: true })
    return mockJson({ error: 'not found' }, 404)
  })
}

// ---------------------------------------------------------------------------
// Setup / Teardown helpers
// ---------------------------------------------------------------------------

export function createMockFetch(): {
  mockFetch: ReturnType<typeof vi.fn<FetchFn>>
  install: () => void
  restore: () => void
} {
  let originalFetch: FetchFn
  const mockFetch = vi.fn<FetchFn>()
  return {
    mockFetch,
    install: () => {
      originalFetch = globalThis.fetch
      globalThis.fetch = mockFetch
    },
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}
