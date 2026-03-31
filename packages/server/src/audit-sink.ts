/** Server-backed audit sink with batching. */

import type { AuditEvent, AuditSink } from '@edictum/core'
import { EdictumConfigError } from '@edictum/core'

import type { EdictumServerClient } from './client.js'

/** Deep-copy with fallback to JSON roundtrip for non-cloneable values. */
function safeClone<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

interface ServerEventPayload {
  schema_version: string
  call_id: string
  agent_id: string
  tool_name: string
  tool_args: Record<string, unknown>
  side_effect: string
  environment: string
  principal: Record<string, unknown> | null
  action: string
  decision_source: string | null
  decision_name: string | null
  reason: string | null
  hooks_evaluated: Record<string, unknown>[]
  rules_evaluated: Record<string, unknown>[]
  mode: string
  policy_version: string | null
  timestamp: string
  run_id: string
  call_index: number
  parent_call_id: string | null
  tool_success: boolean | null
  postconditions_passed: boolean | null
  duration_ms: number
  error: string | null
  result_summary: string | null
  session_attempt_count: number
  session_execution_count: number
  policy_error: boolean
}

function toCanonicalAction(action: string): string {
  switch (action) {
    case 'call_denied':
      return 'call_blocked'
    case 'call_would_deny':
      return 'call_would_block'
    case 'call_approval_denied':
      return 'call_approval_blocked'
    case 'call_approval_timeout':
      // Spec 007 keeps call_approval_timeout as the canonical /v1 value.
      return 'call_approval_timeout'
    default:
      return action
  }
}

/**
 * Audit sink that sends events to the edictum-server.
 *
 * Batches events and flushes periodically or when batch is full.
 */
export class ServerAuditSink implements AuditSink {
  static readonly MAX_BUFFER_SIZE = 10_000

  private readonly _client: EdictumServerClient
  private readonly _batchSize: number
  private readonly _flushInterval: number
  private readonly _maxBufferSize: number
  private _buffer: ServerEventPayload[] = []
  private _flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    client: EdictumServerClient,
    options?: {
      batchSize?: number
      flushInterval?: number
      maxBufferSize?: number
    },
  ) {
    this._client = client
    this._flushInterval = options?.flushInterval ?? 5_000
    this._maxBufferSize = options?.maxBufferSize ?? ServerAuditSink.MAX_BUFFER_SIZE

    // Validate maxBufferSize BEFORE using it to compute the default batchSize —
    // otherwise invalid maxBufferSize values propagate and produce misleading errors.
    if (!Number.isInteger(this._maxBufferSize) || this._maxBufferSize < 1) {
      throw new EdictumConfigError(
        `maxBufferSize must be an integer >= 1, got ${this._maxBufferSize}`,
      )
    }
    if (this._maxBufferSize > ServerAuditSink.MAX_BUFFER_SIZE) {
      throw new EdictumConfigError(
        `maxBufferSize must be <= ${ServerAuditSink.MAX_BUFFER_SIZE}, got ${this._maxBufferSize}`,
      )
    }

    this._batchSize = options?.batchSize ?? Math.min(50, this._maxBufferSize)

    if (!Number.isInteger(this._batchSize) || this._batchSize < 1) {
      throw new EdictumConfigError(`batchSize must be an integer >= 1, got ${this._batchSize}`)
    }
    if (this._batchSize > this._maxBufferSize) {
      throw new EdictumConfigError(
        `batchSize (${this._batchSize}) must be <= maxBufferSize (${this._maxBufferSize})`,
      )
    }
    if (!Number.isFinite(this._flushInterval) || this._flushInterval <= 0) {
      throw new EdictumConfigError(
        `flushInterval must be a positive finite number, got ${this._flushInterval}`,
      )
    }
  }

  /** Convert an AuditEvent to server format and add to batch buffer. */
  async emit(event: AuditEvent): Promise<void> {
    const payload = this._mapEvent(event)
    this._buffer.push(payload)
    const needsFlush = this._buffer.length >= this._batchSize

    if (needsFlush) {
      await this._flush()
    } else {
      this._scheduleAutoFlush()
    }
  }

  /** Map an AuditEvent to the server EventPayload format. */
  private _mapEvent(event: AuditEvent): ServerEventPayload {
    return {
      schema_version: event.schemaVersion,
      call_id: event.callId,
      agent_id: this._client.agentId,
      tool_name: event.toolName,
      tool_args: safeClone(event.toolArgs),
      side_effect: event.sideEffect,
      environment: event.environment || this._client.env,
      principal: event.principal !== null ? safeClone(event.principal) : null,
      action: toCanonicalAction(event.action),
      decision_source: event.decisionSource,
      decision_name: event.decisionName,
      reason: event.reason,
      hooks_evaluated: safeClone(event.hooksEvaluated),
      // contractsEvaluated is the internal field name; rules_evaluated is the
      // canonical /v1 wire name from spec 007.
      rules_evaluated: safeClone(event.contractsEvaluated),
      mode: event.mode,
      policy_version: event.policyVersion,
      timestamp: event.timestamp.toISOString(),
      run_id: event.runId,
      call_index: event.callIndex,
      parent_call_id: event.parentCallId,
      tool_success: event.toolSuccess,
      postconditions_passed: event.postconditionsPassed,
      duration_ms: event.durationMs,
      error: event.error,
      result_summary: event.resultSummary,
      session_attempt_count: event.sessionAttemptCount,
      session_execution_count: event.sessionExecutionCount,
      policy_error: event.policyError,
    }
  }

  /** Flush all buffered events to the server. */
  async flush(): Promise<void> {
    await this._flush()
  }

  private async _flush(): Promise<void> {
    if (this._buffer.length === 0) {
      return
    }

    const events = [...this._buffer]
    this._buffer = []

    try {
      await this._client.post('/v1/events', { events })
    } catch (error) {
      this._restoreEvents(events)
      // Rethrow non-Error throwables and client auth errors (4xx except 429)
      // so credential failures surface immediately instead of silently retrying
      if (!(error instanceof Error)) throw error
      const status = (error as { statusCode?: number }).statusCode
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw error
      }
      // Only log retry message for retryable errors (network, 5xx, 429)
      console.warn(`Failed to flush ${events.length} audit events, keeping in buffer for retry`)
    }
  }

  private _restoreEvents(events: ServerEventPayload[]): void {
    this._buffer = [...events, ...this._buffer]
    if (this._buffer.length > this._maxBufferSize) {
      const dropped = this._buffer.length - this._maxBufferSize
      console.warn(
        `[edictum] audit buffer overflow: dropping ${dropped} oldest events (buffer capped at ${this._maxBufferSize})`,
      )
      this._buffer = this._buffer.slice(dropped)
    }
  }

  private _scheduleAutoFlush(): void {
    if (this._flushTimer !== null) {
      return
    }
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      this.flush().catch((err: unknown) => {
        // Auto-flush is fire-and-forget. Auth errors (4xx) will surface on
        // the next explicit emit→flush path. Log here to aid debugging.
        console.warn(
          `[edictum] auto-flush failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }, this._flushInterval)
  }

  /** Flush remaining events and cancel the background flush timer. */
  async close(): Promise<void> {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    await this.flush()
  }
}
