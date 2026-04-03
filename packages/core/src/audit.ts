/** Structured Event Log with Redaction. */

import { appendFile } from 'node:fs/promises'

import { RedactionPolicy } from './redaction.js'

// -- AuditAction --------------------------------------------------------------

export const AuditAction = {
  CALL_DENIED: 'call_denied',
  CALL_WOULD_DENY: 'call_would_deny',
  CALL_ALLOWED: 'call_allowed',
  CALL_EXECUTED: 'call_executed',
  CALL_FAILED: 'call_failed',
  WORKFLOW_STAGE_ADVANCED: 'workflow_stage_advanced',
  WORKFLOW_COMPLETED: 'workflow_completed',
  WORKFLOW_STATE_UPDATED: 'workflow_state_updated',
  POSTCONDITION_WARNING: 'postcondition_warning',
  CALL_APPROVAL_REQUESTED: 'call_approval_requested',
  CALL_APPROVAL_GRANTED: 'call_approval_granted',
  CALL_APPROVAL_DENIED: 'call_approval_denied',
  CALL_APPROVAL_TIMEOUT: 'call_approval_timeout',
} as const

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction]

// -- AuditEvent ---------------------------------------------------------------

export interface AuditEvent {
  schemaVersion: string
  timestamp: Date
  runId: string
  callId: string
  callIndex: number
  parentCallId: string | null
  sessionId: string | null
  parentSessionId: string | null
  toolName: string
  toolArgs: Record<string, unknown>
  sideEffect: string
  environment: string
  principal: Record<string, unknown> | null
  action: AuditAction
  decisionSource: string | null
  decisionName: string | null
  reason: string | null
  hooksEvaluated: Record<string, unknown>[]
  contractsEvaluated: Record<string, unknown>[]
  workflow: Record<string, unknown> | null
  toolSuccess: boolean | null
  postconditionsPassed: boolean | null
  durationMs: number
  error: string | null
  resultSummary: string | null
  sessionAttemptCount: number
  sessionExecutionCount: number
  mode: string
  policyVersion: string | null
  policyError: boolean
}

/** Factory with defaults matching the Python dataclass. */
export function createAuditEvent(f: Partial<AuditEvent> = {}): AuditEvent {
  return {
    schemaVersion: f.schemaVersion ?? '0.3.0',
    timestamp: f.timestamp ?? new Date(),
    runId: f.runId ?? '',
    callId: f.callId ?? '',
    callIndex: f.callIndex ?? 0,
    parentCallId: f.parentCallId ?? null,
    sessionId: f.sessionId ?? null,
    parentSessionId: f.parentSessionId ?? null,
    toolName: f.toolName ?? '',
    toolArgs: f.toolArgs ?? {},
    sideEffect: f.sideEffect ?? '',
    environment: f.environment ?? '',
    principal: f.principal ?? null,
    action: f.action ?? AuditAction.CALL_DENIED,
    decisionSource: f.decisionSource ?? null,
    decisionName: f.decisionName ?? null,
    reason: f.reason ?? null,
    hooksEvaluated: f.hooksEvaluated ?? [],
    contractsEvaluated: f.contractsEvaluated ?? [],
    workflow: f.workflow ?? null,
    toolSuccess: f.toolSuccess ?? null,
    postconditionsPassed: f.postconditionsPassed ?? null,
    durationMs: f.durationMs ?? 0,
    error: f.error ?? null,
    resultSummary: f.resultSummary ?? null,
    sessionAttemptCount: f.sessionAttemptCount ?? 0,
    sessionExecutionCount: f.sessionExecutionCount ?? 0,
    mode: f.mode ?? 'enforce',
    policyVersion: f.policyVersion ?? null,
    policyError: f.policyError ?? false,
  }
}

// -- AuditSink ----------------------------------------------------------------

export interface AuditSink {
  emit(event: AuditEvent): Promise<void>
}

// -- MarkEvictedError ---------------------------------------------------------

/** Raised when a mark references events evicted from the buffer. */
export class MarkEvictedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarkEvictedError'
  }
}

// -- CompositeSink ------------------------------------------------------------

/** Fan-out sink: emits to all sinks, raises AggregateError on failures. */
export class CompositeSink implements AuditSink {
  private readonly _sinks: AuditSink[]

  constructor(sinks: AuditSink[]) {
    if (sinks.length === 0) throw new Error('CompositeSink requires at least one sink')
    this._sinks = [...sinks]
  }

  get sinks(): AuditSink[] {
    return [...this._sinks]
  }

  async emit(event: AuditEvent): Promise<void> {
    const errors: Error[] = []
    for (const sink of this._sinks) {
      try {
        await sink.emit(event)
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'CompositeSink: one or more sinks failed')
    }
  }
}

// -- Shared serialization -----------------------------------------------------

function _toPlain(event: AuditEvent): Record<string, unknown> {
  const { timestamp, ...rest } = event
  return { ...rest, timestamp: timestamp.toISOString() }
}

// -- StdoutAuditSink ----------------------------------------------------------

export class StdoutAuditSink implements AuditSink {
  private readonly _redaction: RedactionPolicy
  constructor(redaction?: RedactionPolicy | null) {
    this._redaction = redaction ?? new RedactionPolicy()
  }
  async emit(event: AuditEvent): Promise<void> {
    process.stdout.write(JSON.stringify(this._redaction.capPayload(_toPlain(event))) + '\n')
  }
}

// -- FileAuditSink ------------------------------------------------------------

export class FileAuditSink implements AuditSink {
  private readonly _path: string
  private readonly _redaction: RedactionPolicy
  constructor(path: string, redaction?: RedactionPolicy | null) {
    this._path = path
    this._redaction = redaction ?? new RedactionPolicy()
  }
  async emit(event: AuditEvent): Promise<void> {
    const data = this._redaction.capPayload(_toPlain(event))
    await appendFile(this._path, JSON.stringify(data) + '\n', 'utf-8')
  }
}

// -- CollectingAuditSink ------------------------------------------------------

/** In-memory ring buffer sink for programmatic inspection. */
export class CollectingAuditSink implements AuditSink {
  private _events: AuditEvent[] = []
  private readonly _maxEvents: number
  private _totalEmitted: number = 0

  constructor(maxEvents: number = 50_000) {
    if (maxEvents < 1) throw new Error(`max_events must be >= 1, got ${maxEvents}`)
    this._maxEvents = maxEvents
  }

  async emit(event: AuditEvent): Promise<void> {
    this._events.push(event)
    this._totalEmitted += 1
    if (this._events.length > this._maxEvents) this._events = this._events.slice(-this._maxEvents)
  }

  get events(): AuditEvent[] {
    return [...this._events]
  }
  mark(): number {
    return this._totalEmitted
  }

  sinceMark(m: number): AuditEvent[] {
    if (m > this._totalEmitted) {
      throw new Error(`Mark ${m} is ahead of total emitted (${this._totalEmitted})`)
    }
    const evictedCount = this._totalEmitted - this._events.length
    if (m < evictedCount) {
      throw new MarkEvictedError(
        `Mark ${m} references evicted events (buffer starts at ${evictedCount}, max_events=${this._maxEvents})`,
      )
    }
    return [...this._events.slice(m - evictedCount)]
  }

  last(): AuditEvent {
    if (this._events.length === 0) throw new Error('No events collected')
    const last = this._events[this._events.length - 1]
    if (!last) throw new Error('No events collected')
    return last
  }

  filter(action: AuditAction): AuditEvent[] {
    return this._events.filter((e) => e.action === action)
  }

  clear(): void {
    this._events = []
  }
}
