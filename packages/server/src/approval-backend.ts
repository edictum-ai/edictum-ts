/** Server-backed approval backend for human-in-the-loop workflows. */

import type { ApprovalBackend, ApprovalDecision, ApprovalRequest } from '@edictum/core'
import { ApprovalStatus, deepFreeze } from '@edictum/core'

import { EdictumConfigError } from '@edictum/core'

import type { EdictumServerClient } from './client.js'
import { SAFE_IDENTIFIER_RE } from './client.js'

/**
 * Approval backend that delegates to the edictum-server approval queue.
 *
 * Creates approval requests via HTTP POST, then polls GET until resolved.
 */
export class ServerApprovalBackend implements ApprovalBackend {
  /** Maximum number of concurrent pending approval requests to prevent unbounded memory growth. */
  static readonly MAX_PENDING = 10_000

  private readonly _client: EdictumServerClient
  private readonly _pollInterval: number
  private readonly _pending: Map<string, ApprovalRequest> = new Map()

  constructor(
    client: EdictumServerClient,
    options?: {
      pollInterval?: number
    },
  ) {
    this._client = client
    this._pollInterval = options?.pollInterval ?? 2_000
    if (!Number.isFinite(this._pollInterval) || this._pollInterval <= 0) {
      throw new EdictumConfigError(
        `pollInterval must be a positive finite number, got ${this._pollInterval}`,
      )
    }
  }

  /** Create an approval request on the server. */
  async requestApproval(
    toolName: string,
    toolArgs: Record<string, unknown>,
    message: string,
    options?: {
      timeout?: number
      timeoutEffect?: 'deny' | 'allow'
      principal?: Record<string, unknown> | null
      metadata?: Record<string, unknown> | null
    },
  ): Promise<ApprovalRequest> {
    // Validate toolName — must be a safe identifier to prevent injection
    // when interpolated into server API paths or log messages.
    if (!toolName || toolName.length > 128 || !SAFE_IDENTIFIER_RE.test(toolName)) {
      const display = JSON.stringify(
        typeof toolName === 'string' ? toolName.slice(0, 64) : toolName,
      )
      throw new EdictumConfigError(
        `Invalid toolName: ${display}${typeof toolName === 'string' && toolName.length > 64 ? '…' : ''}. Must start with alphanumeric, followed by alphanumeric, hyphens, underscores, or dots (1-128 chars total).`,
      )
    }

    // Validate message — must be non-empty, length-capped, and free of control characters.
    if (!message) {
      throw new EdictumConfigError('message must be a non-empty string')
    }
    if (message.length > 4096) {
      throw new EdictumConfigError(`message too long (${message.length} > 4096)`)
    }
    // Allow TAB (\x09) and LF (\x0a) for multi-line messages; block CR (\x0d),
    // C1 chars (\x7f-\x9f), and Unicode line/paragraph separators.
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(message)) {
      throw new EdictumConfigError('message contains invalid control characters')
    }

    const timeout = options?.timeout ?? 300
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new EdictumConfigError(`timeout must be a positive finite number, got ${timeout}`)
    }

    const timeoutEffect = options?.timeoutEffect ?? 'deny'
    if (timeoutEffect !== 'deny' && timeoutEffect !== 'allow') {
      throw new EdictumConfigError(
        `timeoutEffect must be "deny" or "allow", got ${JSON.stringify(timeoutEffect)}`,
      )
    }

    if (this._pending.size >= ServerApprovalBackend.MAX_PENDING) {
      throw new EdictumConfigError(
        `Maximum pending approvals (${ServerApprovalBackend.MAX_PENDING}) exceeded — cannot track more concurrent requests`,
      )
    }

    const body = {
      agent_id: this._client.agentId,
      tool_name: toolName,
      tool_args: toolArgs,
      message,
      timeout,
      timeout_action: timeoutEffect,
    }

    const response = await this._client.post('/v1/approvals', body)
    const approvalId = response['id']

    // Validate server-returned approvalId — this is a local validation
    // failure on the server's response, not an HTTP-layer error.
    if (
      typeof approvalId !== 'string' ||
      approvalId.length > 128 ||
      !SAFE_IDENTIFIER_RE.test(approvalId)
    ) {
      const display =
        typeof approvalId === 'string'
          ? JSON.stringify(approvalId.slice(0, 64)) + (approvalId.length > 64 ? '…' : '')
          : JSON.stringify(approvalId)
      throw new EdictumConfigError(
        `Server returned invalid approvalId: ${display}. Must match SAFE_IDENTIFIER_RE.`,
      )
    }

    // Deep-copy THEN freeze — prevents freezing caller-owned nested objects.
    // structuredClone handles most JSON-like data; falls back to shallow spread
    // for non-cloneable types (Buffer, typed arrays) which are already edge cases
    // since toolArgs must be JSON-serializable for the HTTP POST.
    let safeArgs: Record<string, unknown>
    let safePrincipal: Record<string, unknown> | null
    let safeMeta: Record<string, unknown>
    try {
      safeArgs = structuredClone(toolArgs)
      safePrincipal = options?.principal ? structuredClone(options.principal) : null
      safeMeta = structuredClone(options?.metadata ?? {})
    } catch {
      safeArgs = JSON.parse(JSON.stringify(toolArgs)) as Record<string, unknown>
      safePrincipal = options?.principal
        ? (JSON.parse(JSON.stringify(options.principal)) as Record<string, unknown>)
        : null
      safeMeta = JSON.parse(JSON.stringify(options?.metadata ?? {})) as Record<string, unknown>
    }
    const request: ApprovalRequest = deepFreeze({
      approvalId,
      toolName,
      toolArgs: safeArgs,
      message,
      timeout,
      timeoutEffect,
      principal: safePrincipal,
      metadata: safeMeta,
      createdAt: new Date(),
    })

    this._pending.set(approvalId, request)
    return request
  }

  /** Poll the server until the approval is resolved or timeout is exceeded. */
  async waitForDecision(approvalId: string, timeout?: number | null): Promise<ApprovalDecision> {
    // Validate approvalId before interpolating into URL path
    if (!approvalId || approvalId.length > 128 || !SAFE_IDENTIFIER_RE.test(approvalId)) {
      const display = JSON.stringify(
        typeof approvalId === 'string' ? approvalId.slice(0, 64) : approvalId,
      )
      throw new EdictumConfigError(
        `Invalid approvalId: ${display}${typeof approvalId === 'string' && approvalId.length > 64 ? '…' : ''}. Must match SAFE_IDENTIFIER_RE.`,
      )
    }

    const request = this._pending.get(approvalId)
    const effectiveTimeout = timeout ?? (request ? request.timeout : 300)
    const timeoutEffect = request ? request.timeoutEffect : 'deny'

    const deadline = Date.now() + effectiveTimeout * 1000

    // Clean up pending map now that we have the id — avoid unbounded growth
    this._pending.delete(approvalId)

    while (true) {
      const response = await this._client.get(`/v1/approvals/${approvalId}`)
      const status = response['status'] as string

      if (status === 'approved') {
        return deepFreeze({
          approved: true,
          approver: (response['decided_by'] as string) ?? null,
          reason: (response['decision_reason'] as string) ?? null,
          status: ApprovalStatus.APPROVED,
          timestamp: new Date(),
        })
      }

      if (status === 'rejected' || status === 'denied') {
        return deepFreeze({
          approved: false,
          approver: (response['decided_by'] as string) ?? null,
          reason: (response['decision_reason'] as string) ?? null,
          status: ApprovalStatus.DENIED,
          timestamp: new Date(),
        })
      }

      if (status === 'timed_out' || status === 'timeout') {
        return deepFreeze({
          approved: timeoutEffect === 'allow',
          approver: null,
          reason: null,
          status: ApprovalStatus.TIMEOUT,
          timestamp: new Date(),
        })
      }

      // Still pending — check local deadline
      if (Date.now() >= deadline) {
        return deepFreeze({
          approved: timeoutEffect === 'allow',
          approver: null,
          reason: null,
          status: ApprovalStatus.TIMEOUT,
          timestamp: new Date(),
        })
      }

      await sleep(this._pollInterval)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
