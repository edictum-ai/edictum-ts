/**
 * SSE client for receiving contract bundle updates from edictum-server.
 *
 * SIZE APPROVAL: This file exceeds 200 lines. SSE parsing, reconnect
 * logic, and event handling form a cohesive streaming client.
 */

import { EdictumConfigError } from '@edictum/core'

import type { EdictumServerClient } from './client.js'
import { SAFE_IDENTIFIER_RE } from './client.js'

const STABLE_CONNECTION_MS = 30_000
const MAX_SSE_BUFFER = 1_048_576 // 1 MB
const SSE_IDLE_TIMEOUT_MS = 120_000 // 2 minutes

/**
 * Receives contract bundle updates from edictum-server via SSE.
 *
 * Subscribes to /api/v1/stream and yields updated bundles.
 * Implements auto-reconnect with exponential backoff.
 */
export class ServerContractSource {
  private readonly _client: EdictumServerClient
  private readonly _reconnectDelay: number
  private readonly _maxReconnectDelay: number
  private _connected: boolean = false
  private _closed: boolean = false
  private _currentRevision: string | null = null
  private _abortController: AbortController | null = null

  constructor(
    client: EdictumServerClient,
    options?: {
      reconnectDelay?: number
      maxReconnectDelay?: number
    },
  ) {
    this._client = client
    const reconnectDelay = options?.reconnectDelay ?? 1_000
    const maxReconnectDelay = options?.maxReconnectDelay ?? 60_000
    if (!Number.isFinite(reconnectDelay) || reconnectDelay <= 0) {
      throw new EdictumConfigError(
        `reconnectDelay must be a positive finite number, got ${reconnectDelay}`,
      )
    }
    if (!Number.isFinite(maxReconnectDelay) || maxReconnectDelay < reconnectDelay) {
      throw new EdictumConfigError(
        `maxReconnectDelay must be a finite number >= reconnectDelay (${reconnectDelay}), got ${maxReconnectDelay}`,
      )
    }
    this._reconnectDelay = reconnectDelay
    this._maxReconnectDelay = maxReconnectDelay
  }

  /** Mark the source as ready to receive events.
   * Note: _connected stays false until watch() establishes an HTTP connection. */
  async connect(): Promise<void> {
    this._closed = false
  }

  /**
   * Yield contract bundles as they arrive via SSE.
   *
   * Passes env, bundle_name, and policy_version as query params
   * so the server can filter events and detect drift.
   * Auto-reconnects on disconnect with exponential backoff.
   */
  async *watch(): AsyncGenerator<Record<string, unknown>> {
    let delay = this._reconnectDelay
    // Track consecutive failures for backoff reset
    let connectedAt: number | null = null

    while (!this._closed) {
      try {
        const params: Record<string, string> = { env: this._client.env }
        if (this._client.bundleName) {
          params['bundle_name'] = this._client.bundleName
        }
        if (this._currentRevision) {
          params['policy_version'] = this._currentRevision
        }
        if (this._client.tags) {
          params['tags'] = JSON.stringify(this._client.tags)
        }

        this._abortController = new AbortController()

        const response = await this._client.rawFetch('/api/v1/stream', params, {
          signal: this._abortController.signal,
        })

        if (!response.ok) {
          throw new Error(`SSE connection failed: HTTP ${response.status}`)
        }

        if (!response.body) {
          throw new Error('SSE response has no body')
        }

        this._connected = true
        connectedAt = Date.now()

        // Parse SSE stream
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let currentEvent = ''
        let currentData = ''

        // Idle timeout: abort if no data received for 2 minutes
        // Idle timeout: if no data for 2 minutes, abort the connection.
        // This kills the fetch/reader and triggers the reconnect logic.
        let idleTimer: ReturnType<typeof setTimeout> | null = null
        const resetIdleTimer = (): void => {
          if (idleTimer !== null) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            // Abort the connection if still active — reader.read() will throw, triggering reconnect. No-op if source is already closed.
            this._abortController?.abort()
          }, SSE_IDLE_TIMEOUT_MS)
        }
        const clearIdleTimer = (): void => {
          if (idleTimer !== null) {
            clearTimeout(idleTimer)
            idleTimer = null
          }
        }

        try {
          resetIdleTimer()
          while (!this._closed) {
            const { done, value } = await reader.read()
            if (done) break
            resetIdleTimer()

            buffer += decoder.decode(value, { stream: true })

            // Guard against unbounded SSE buffer (e.g. server sends no newlines)
            if (buffer.length > MAX_SSE_BUFFER) {
              buffer = ''
              currentEvent = ''
              currentData = ''
              continue
            }

            // SSE spec: lines end with \n, \r\n, or \r
            const lines = buffer.split(/\r\n|\r|\n/)
            // Keep the last incomplete line in buffer
            buffer = lines.pop() ?? ''

            for (const line of lines) {
              if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim()
              } else if (line.startsWith('data:')) {
                // SSE spec: multi-line data fields are concatenated with \n
                if (currentData) {
                  currentData += '\n'
                }
                const rawField = line.slice(5)
                currentData += rawField[0] === ' ' ? rawField.slice(1) : rawField
              } else if (line === '') {
                // Empty line = end of event
                if (currentEvent && currentData) {
                  const result = this._processEvent(currentEvent, currentData)
                  if (result !== null) {
                    yield result
                  }
                }
                currentEvent = ''
                currentData = ''
              }
            }
          }
        } finally {
          clearIdleTimer()
          reader.releaseLock()
        }

        if (this._closed) {
          return
        }

        // Stream ended cleanly — wait before reconnecting to avoid tight loop
        this._connected = false
        connectedAt = null
        delay = this._reconnectDelay
        await sleep(delay)
      } catch {
        if (this._closed) {
          return
        }

        this._connected = false

        if (connectedAt !== null) {
          const elapsed = Date.now() - connectedAt
          if (elapsed >= STABLE_CONNECTION_MS) {
            delay = this._reconnectDelay
          }
          connectedAt = null
        }

        await sleep(delay)
        delay = Math.min(delay * 2, this._maxReconnectDelay)
      }
    }
  }

  private _processEvent(eventType: string, data: string): Record<string, unknown> | null {
    if (eventType === 'contract_update') {
      let bundle: unknown
      try {
        bundle = JSON.parse(data)
      } catch {
        return null // Invalid JSON
      }
      if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
        return null // Not an object
      }
      const bundleObj = bundle as Record<string, unknown>
      if ('revision_hash' in bundleObj && typeof bundleObj['revision_hash'] === 'string') {
        const hash = bundleObj['revision_hash'].slice(0, 128)
        // Accept any printable string (opaque to the client)
        if (hash.length > 0 && !/[\x00-\x1f\x7f]/.test(hash)) {
          this._currentRevision = hash
        }
      }
      return bundleObj
    }

    if (eventType === 'assignment_changed') {
      let data_obj: unknown
      try {
        data_obj = JSON.parse(data)
      } catch {
        return null
      }
      if (typeof data_obj !== 'object' || data_obj === null || Array.isArray(data_obj)) {
        return null
      }
      const obj = data_obj as Record<string, unknown>
      const newBundle = obj['bundle_name']
      if (
        typeof newBundle !== 'string' ||
        newBundle.length > 128 ||
        !SAFE_IDENTIFIER_RE.test(newBundle)
      ) {
        return null
      }
      // Do NOT update _client.bundleName here.
      // The watcher updates it after a successful reload.
      return { _assignment_changed: true, bundle_name: newBundle }
    }

    return null
  }

  /** Stop watching for updates. */
  async close(): Promise<void> {
    this._closed = true
    this._connected = false
    if (this._abortController) {
      this._abortController.abort()
      this._abortController = null
    }
  }

  get connected(): boolean {
    return this._connected
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
