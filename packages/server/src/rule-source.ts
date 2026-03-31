/**
 * SSE client for receiving ruleset updates from edictum-api.
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

type RuleSourceParseError = Readonly<{
  type: 'parse_error'
  message: string
}>

/**
 * Receives ruleset update notifications from edictum-api via SSE.
 *
 * Subscribes to /v1/stream and yields matching ruleset update events.
 * Implements auto-reconnect with exponential backoff.
 */
export class ServerRuleSource {
  private readonly _client: EdictumServerClient
  private readonly _reconnectDelay: number
  private readonly _maxReconnectDelay: number
  private readonly _onParseError: ((error: RuleSourceParseError) => void) | null
  private _connected: boolean = false
  private _closed: boolean = false
  private _abortController: AbortController | null = null

  constructor(
    client: EdictumServerClient,
    options?: {
      reconnectDelay?: number
      maxReconnectDelay?: number
      onParseError?: (error: RuleSourceParseError) => void
    },
  ) {
    this._client = client
    const reconnectDelay = options?.reconnectDelay ?? 1_000
    const maxReconnectDelay = options?.maxReconnectDelay ?? 60_000
    this._onParseError = options?.onParseError ?? null
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
   * Yield matching ruleset update events as they arrive via SSE.
   *
   * Ignores non-ruleset stream events such as live decision updates.
   * Auto-reconnects on disconnect with exponential backoff.
   */
  async *watch(): AsyncGenerator<Record<string, unknown>> {
    let delay = this._reconnectDelay
    // Track consecutive failures for backoff reset
    let connectedAt: number | null = null

    while (!this._closed) {
      try {
        this._abortController = new AbortController()

        const response = await this._client.rawFetch('/v1/stream', undefined, {
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

  private _notifyParseError(message: string): void {
    try {
      this._onParseError?.({ type: 'parse_error', message })
    } catch {
      /* user callback error swallowed */
    }
  }

  private _processEvent(eventType: string, data: string): Record<string, unknown> | null {
    if (eventType === 'ruleset_updated') {
      let ruleset: unknown
      try {
        ruleset = JSON.parse(data)
      } catch {
        this._notifyParseError('Invalid JSON in ruleset_updated event')
        return null
      }
      if (typeof ruleset !== 'object' || ruleset === null || Array.isArray(ruleset)) {
        this._notifyParseError('ruleset_updated event payload must be an object')
        return null
      }
      const rulesetObj = ruleset as Record<string, unknown>
      const name = rulesetObj['name']
      if (typeof name !== 'string' || name.length > 128 || !SAFE_IDENTIFIER_RE.test(name)) {
        this._notifyParseError('Invalid ruleset name in ruleset_updated event')
        return null
      }
      if (this._client.bundleName !== null && name !== this._client.bundleName) {
        return null
      }
      const version = rulesetObj['version']
      if (
        version !== undefined &&
        (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
      ) {
        this._notifyParseError('Invalid ruleset version in ruleset_updated event')
        return null
      }
      return rulesetObj
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
