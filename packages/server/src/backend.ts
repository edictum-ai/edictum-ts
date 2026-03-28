/**
 * Server-backed storage backend for distributed session state.
 *
 * Fail-closed rule: when the server is unreachable or returns a
 * non-404 error, methods raise rather than returning defaults. The
 * governance pipeline treats unhandled exceptions as deny decisions,
 * so propagating errors here ensures that session-based rate limits
 * cannot be silently bypassed by a network outage.
 */

import type { StorageBackend } from '@edictum/core'
import { EdictumConfigError } from '@edictum/core'

import type { EdictumServerClient } from './client.js'
import { EdictumServerError } from './client.js'

/**
 * Validate a storage key: reject empty strings and control characters.
 * Mirrors core session.ts _validateStorageKeyComponent logic.
 * Covers C0 (U+0000–U+001F), DEL (U+007F), C1 (U+0080–U+009F),
 * and Unicode line/paragraph separators (U+2028, U+2029).
 */
function validateKey(key: string): void {
  if (!key) {
    throw new EdictumConfigError(`Invalid storage key: ${JSON.stringify(key)}`)
  }
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      throw new EdictumConfigError(`Invalid storage key: contains control character at index ${i}`)
    }
  }
}

/**
 * Storage backend that delegates session state to edictum-server.
 *
 * Implements the StorageBackend protocol, forwarding all operations
 * to the server's session state API.
 */
export class ServerBackend implements StorageBackend {
  private readonly _client: EdictumServerClient

  constructor(client: EdictumServerClient) {
    this._client = client
  }

  /**
   * Retrieve a value from the server session store.
   *
   * Returns null only when the key genuinely does not exist (HTTP 404).
   * All other errors propagate so the pipeline fails closed.
   */
  async get(key: string): Promise<string | null> {
    validateKey(key)
    try {
      const response = await this._client.get(`/api/v1/sessions/${encodeURIComponent(key)}`)
      return (response['value'] as string) ?? null
    } catch (error) {
      if (error instanceof EdictumServerError && error.statusCode === 404) {
        return null
      }
      throw error
    }
  }

  /** Set a value in the server session store. */
  async set(key: string, value: string): Promise<void> {
    validateKey(key)
    await this._client.put(`/api/v1/sessions/${encodeURIComponent(key)}`, { value })
  }

  /** Delete a key from the server session store. */
  async delete(key: string): Promise<void> {
    validateKey(key)
    try {
      await this._client.delete(`/api/v1/sessions/${encodeURIComponent(key)}`)
    } catch (error) {
      if (error instanceof EdictumServerError && error.statusCode === 404) {
        return
      }
      throw error
    }
  }

  /** Atomically increment a counter on the server. */
  async increment(key: string, amount: number = 1): Promise<number> {
    validateKey(key)
    if (!Number.isFinite(amount)) {
      throw new EdictumConfigError(
        `Invalid increment amount: ${JSON.stringify(amount)}. Must be a finite number.`,
      )
    }
    const response = await this._client.post(
      `/api/v1/sessions/${encodeURIComponent(key)}/increment`,
      { amount },
    )
    const value = response['value']
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Server returned invalid value for increment: ${JSON.stringify(value)}`)
    }
    return value
  }

  /**
   * Retrieve multiple session values in a single HTTP call.
   *
   * Falls back to individual get() calls if the server returns 404
   * or 405 (endpoint not available on older servers).
   *
   * Fail-closed: other errors propagate so the pipeline denies
   * rather than silently allowing with missing data.
   */
  async batchGet(keys: readonly string[]): Promise<Record<string, string | null>> {
    for (const key of keys) {
      validateKey(key)
    }
    if (keys.length === 0) {
      return {}
    }

    try {
      const response = await this._client.post('/api/v1/sessions/batch', {
        keys: [...keys],
      })
      const values = (response['values'] as Record<string, string>) ?? {}
      const result: Record<string, string | null> = {}
      for (const key of keys) {
        result[key] = (values[key] as string) ?? null
      }
      return result
    } catch (error) {
      if (
        error instanceof EdictumServerError &&
        (error.statusCode === 404 || error.statusCode === 405)
      ) {
        // Server doesn't support batch endpoint -- fall back
        const result: Record<string, string | null> = {}
        for (const key of keys) {
          result[key] = await this.get(key)
        }
        return result
      }
      throw error
    }
  }
}
