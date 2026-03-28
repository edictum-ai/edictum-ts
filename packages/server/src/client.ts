/**
 * Async HTTP client for edictum-server.
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's client.py
 * (210 LOC). TLS enforcement, identifier validation, tag validation, and
 * retry logic form a single cohesive HTTP client.
 */

import { EdictumConfigError } from '@edictum/core'

// Safe identifier: alphanumeric, hyphens, underscores, dots. No path separators,
// control chars, or whitespace. Matches tool_name validation in toolCall.
export const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

/** Raised when the server returns an error response. */
export class EdictumServerError extends Error {
  readonly statusCode: number
  readonly detail: string

  constructor(statusCode: number, detail: string) {
    super(`HTTP ${statusCode}: ${detail}`)
    this.name = 'EdictumServerError'
    this.statusCode = statusCode
    this.detail = detail
  }
}

export interface EdictumServerClientOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly agentId?: string
  readonly env?: string
  readonly bundleName?: string | null
  readonly tags?: Record<string, string> | null
  readonly timeout?: number
  readonly maxRetries?: number
  readonly allowInsecure?: boolean
}

/**
 * Async HTTP client for the edictum-server API.
 *
 * Handles auth (Bearer API key), retries, and connection management.
 */
export class EdictumServerClient {
  readonly baseUrl: string
  private readonly _apiKey: string
  readonly agentId: string
  readonly env: string
  private _bundleName: string | null
  readonly tags: Readonly<Record<string, string>> | null
  readonly timeout: number
  readonly maxRetries: number

  /** Current bundle name. Read-only externally. */
  get bundleName(): string | null {
    return this._bundleName
  }

  // No public setter — bundleName is mutated only via the package-internal
  // _setClientBundleName() function which validates before calling this.

  constructor(options: EdictumServerClientOptions) {
    const {
      baseUrl,
      apiKey,
      agentId = 'default',
      env = 'production',
      bundleName = null,
      tags = null,
      timeout = 30_000,
      maxRetries = 3,
      allowInsecure = false,
    } = options

    // Validate apiKey is non-empty and free of control characters
    if (!apiKey) {
      throw new EdictumConfigError('apiKey must be a non-empty string')
    }
    if (/[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(apiKey)) {
      throw new EdictumConfigError('apiKey contains invalid control characters')
    }

    // Validate identifiers
    for (const [name, value] of [
      ['agentId', agentId],
      ['env', env],
    ] as const) {
      if (value.length > 128 || !SAFE_IDENTIFIER_RE.test(value)) {
        throw new EdictumConfigError(
          `Invalid ${name}: ${JSON.stringify(value)}. Must be 1-128 alphanumeric chars, hyphens, underscores, or dots.`,
        )
      }
    }

    if (bundleName !== null && (bundleName.length > 128 || !SAFE_IDENTIFIER_RE.test(bundleName))) {
      throw new EdictumConfigError(
        `Invalid bundleName: ${JSON.stringify(bundleName)}. Must be 1-128 alphanumeric chars, hyphens, underscores, or dots.`,
      )
    }

    if (tags !== null) {
      const entries = Object.entries(tags)
      if (entries.length > 64) {
        throw new EdictumConfigError(
          `Too many tags (${entries.length} > 64); maximum is 64 entries`,
        )
      }
      for (const [k, v] of entries) {
        if (k.length === 0) {
          throw new EdictumConfigError('Tag keys must be non-empty strings')
        }
        if (typeof v !== 'string') {
          throw new EdictumConfigError(
            `Tag values must be strings, got ${typeof v} for key ${JSON.stringify(k)}`,
          )
        }
        if (k.length > 128) {
          throw new EdictumConfigError(`Tag key too long (${k.length} > 128): ${JSON.stringify(k)}`)
        }
        if (v.length > 256) {
          throw new EdictumConfigError(
            `Tag value too long (${v.length} > 256) for key ${JSON.stringify(k)}`,
          )
        }
        // Reject control characters in tag keys and values
        if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(k)) {
          throw new EdictumConfigError(`Tag key contains control characters: ${JSON.stringify(k)}`)
        }
        if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(v)) {
          throw new EdictumConfigError(
            `Tag value contains control characters for key ${JSON.stringify(k)}`,
          )
        }
      }
    }

    // TLS enforcement: refuse plaintext HTTP to non-loopback hosts
    const url = new URL(baseUrl)
    if (url.protocol === 'http:') {
      const host = url.hostname
      // URL spec wraps IPv6 in brackets: new URL("http://[::1]").hostname === "[::1]"
      const isLoopback =
        host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
      if (!isLoopback) {
        if (!allowInsecure) {
          throw new EdictumConfigError(
            `Refusing plaintext HTTP connection to ${host}. ` +
              `Use HTTPS or pass allowInsecure: true for non-production use.`,
          )
        }
        console.warn(
          `[edictum] WARNING: allowInsecure is true — API key will be sent over plaintext HTTP to ${host}. ` +
            `Do not use this in production.`,
        )
      }
    }

    // Validate maxRetries is a positive integer
    if (!Number.isFinite(maxRetries) || !Number.isInteger(maxRetries) || maxRetries < 1) {
      throw new EdictumConfigError(`maxRetries must be a positive integer >= 1, got ${maxRetries}`)
    }

    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this._apiKey = apiKey
    this.agentId = agentId
    this.env = env
    this._bundleName = bundleName
    this.tags = tags !== null ? Object.freeze({ ...tags }) : null
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new EdictumConfigError(`timeout must be a positive number, got ${timeout}`)
    }
    this.timeout = timeout
    this.maxRetries = maxRetries
  }

  private _headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this._apiKey}`,
      'X-Edictum-Agent-Id': this.agentId,
      'Content-Type': 'application/json',
    }
  }

  /** Send a GET request with retry logic. */
  async get(
    path: string,
    params?: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    return this._request('GET', path, { params, signal: options?.signal })
  }

  /** Send a POST request with retry logic. */
  async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._request('POST', path, { body })
  }

  /** Send a PUT request with retry logic. */
  async put(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._request('PUT', path, { body })
  }

  /** Send a DELETE request with retry logic. */
  async delete(path: string): Promise<Record<string, unknown>> {
    return this._request('DELETE', path)
  }

  /** Execute an HTTP request with exponential backoff retry for 5xx errors. */
  private async _request(
    method: string,
    path: string,
    options?: {
      params?: Record<string, string>
      body?: Record<string, unknown>
      signal?: AbortSignal
    },
  ): Promise<Record<string, unknown>> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        let url = `${this.baseUrl}${path}`
        if (options?.params) {
          const searchParams = new URLSearchParams(options.params)
          url += `?${searchParams.toString()}`
        }

        const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)]
        if (options?.signal) signals.push(options.signal)
        const fetchOptions: RequestInit = {
          method,
          headers: this._headers(),
          signal: AbortSignal.any(signals),
        }

        if (options?.body !== undefined) {
          fetchOptions.body = JSON.stringify(options.body)
        }

        const response = await fetch(url, fetchOptions)

        if (response.status >= 500) {
          lastError = new EdictumServerError(response.status, await response.text())
          if (attempt < this.maxRetries - 1) {
            const delay = 2 ** attempt * 500
            await sleep(delay)
            continue
          }
          throw lastError
        }

        if (response.status >= 400) {
          throw new EdictumServerError(response.status, await response.text())
        }

        // 204 No Content has no body — return empty object instead of
        // calling .json() which would throw a parse error.
        if (response.status === 204) {
          return {}
        }

        return (await response.json()) as Record<string, unknown>
      } catch (error) {
        if (error instanceof EdictumServerError) {
          throw error
        }
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < this.maxRetries - 1) {
          const delay = 2 ** attempt * 500
          await sleep(delay)
          continue
        }
        throw lastError
      }
    }

    throw lastError ?? new Error('Request failed after retries')
  }

  /**
   * Make a raw fetch request (for SSE streaming).
   * No retry logic — caller handles reconnection.
   */
  async rawFetch(
    path: string,
    params?: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<Response> {
    let url = `${this.baseUrl}${path}`
    if (params) {
      const searchParams = new URLSearchParams(params)
      url += `?${searchParams.toString()}`
    }
    // Connection timeout: abort if server doesn't respond within timeout.
    // Once response headers arrive, only the caller's signal controls the stream.
    const connectAbort = new AbortController()
    const connectTimer = setTimeout(() => connectAbort.abort(), this.timeout)
    const signals: AbortSignal[] = [connectAbort.signal]
    if (options?.signal) signals.push(options.signal)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this._headers(),
        signal: AbortSignal.any(signals),
      })
      clearTimeout(connectTimer)
      return response
    } catch (err) {
      clearTimeout(connectTimer)
      throw err
    }
  }

  /** Close this client (no-op for fetch-based client, kept for API parity). */
  async close(): Promise<void> {
    // Native fetch() doesn't require explicit connection cleanup.
  }
}

/**
 * Update a client's effective bundle name. Internal to the server package —
 * only used by the factory's SSE watcher after a successful rule reload.
 * Not exported from index.ts. Accessible via subpath import but validated —
 * callers who bypass the public API do so at their own risk.
 *
 * Only accepts non-null strings — once a bundle is assigned, it can only
 * transition to another named bundle. Resetting to null (assignment revocation)
 * is not supported; the watcher would need to be restarted for that case.
 *
 * @internal
 */
export function _setClientBundleName(client: EdictumServerClient, name: string): void {
  if (name.length > 128 || !SAFE_IDENTIFIER_RE.test(name)) {
    throw new EdictumConfigError(
      `Invalid bundleName: ${JSON.stringify(name)}. Must be 1-128 alphanumeric chars, hyphens, underscores, or dots.`,
    )
  }
  // Access private field — safe because this is a package-internal function
  // co-located with the class definition. Validation is the single owner above.
  ;(client as unknown as { _bundleName: string | null })._bundleName = name
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
