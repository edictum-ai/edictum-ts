/**
 * @edictum/vercel-ai — Vercel AI SDK adapter for edictum.
 *
 * Translates Edictum pipeline decisions into Vercel AI SDK callback format.
 * The adapter does NOT contain governance logic — that lives in CheckPipeline.
 *
 * Integration point: experimental_onToolCallStart / experimental_onToolCallFinish
 * callbacks for generateText / streamText.
 */

import { randomUUID } from 'node:crypto'

import {
  type AuditAction,
  AuditAction as AA,
  ApprovalStatus,
  createAuditEvent,
  createEnvelope,
  type Edictum,
  EdictumDenied,
  type Violation,
  CheckPipeline,
  type PostCallResult,
  type PostDecisionLike,
  createPostCallResult,
  type PreDecision,
  type Principal,
  Session,
  type WorkflowContext,
  buildViolations,
  defaultSuccessCheck,
} from '@edictum/core'

export const VERSION = '0.1.0' as const
const MAX_WORKFLOW_APPROVAL_ROUNDS = 32

// ---------------------------------------------------------------------------
// Vercel AI SDK event types (structural — no framework import needed)
// ---------------------------------------------------------------------------

/** Shape of the event passed to experimental_onToolCallStart. */
export interface OnToolCallStartEvent {
  readonly toolCall: {
    readonly toolCallId: string
    readonly toolName: string
    readonly input?: Record<string, unknown> // AI SDK v6 (MCP-aligned)
    readonly args?: Record<string, unknown> // AI SDK v5 (backward compat)
  }
}

/** Shape of the event passed to experimental_onToolCallFinish. */
export interface OnToolCallFinishEvent {
  readonly toolCall: {
    readonly toolCallId: string
    readonly toolName: string
    readonly input?: Record<string, unknown> // AI SDK v6 (MCP-aligned)
    readonly args?: Record<string, unknown> // AI SDK v5 (backward compat)
  }
  readonly output?: unknown
  readonly error?: unknown
}

// ---------------------------------------------------------------------------
// VercelAIAdapter options
// ---------------------------------------------------------------------------

export interface VercelAIAdapterOptions {
  readonly sessionId?: string
  readonly parentSessionId?: string
  readonly principal?: Principal
  readonly principalResolver?: (toolName: string, toolInput: Record<string, unknown>) => Principal
}

export interface AsCallbacksOptions {
  readonly onPostconditionWarn?: (result: unknown, violations: Violation[]) => void
}

// ---------------------------------------------------------------------------
// Pending state
// ---------------------------------------------------------------------------

interface PendingCall {
  readonly toolCall: ReturnType<typeof createEnvelope>
  readonly workflowStageId: string | null
  readonly workflowInvolved: boolean
}

// ---------------------------------------------------------------------------
// VercelAIAdapter
// ---------------------------------------------------------------------------

/**
 * Translate Edictum pipeline decisions into Vercel AI SDK callback format.
 *
 * The adapter does NOT contain governance logic — that lives in
 * CheckPipeline. The adapter only:
 * 1. Creates envelopes from SDK callback data
 * 2. Manages pending state (toolCall) between onToolCallStart/onToolCallFinish
 * 3. Translates PreDecision/PostDecision into callback behavior
 * 4. Handles observe mode (deny -> allow conversion)
 */
export class VercelAIAdapter {
  private readonly _guard: Edictum
  private readonly _pipeline: CheckPipeline
  private readonly _sessionId: string
  private readonly _parentSessionId: string | null
  private readonly _session: Session
  private _callIndex: number = 0
  private readonly _pending: Map<string, PendingCall> = new Map()
  private _principal: Principal | null
  private readonly _principalResolver:
    | ((toolName: string, toolInput: Record<string, unknown>) => Principal)
    | null

  constructor(guard: Edictum, options?: VercelAIAdapterOptions) {
    this._guard = guard
    this._pipeline = new CheckPipeline(guard)
    this._sessionId = options?.sessionId ?? randomUUID()
    this._parentSessionId = options?.parentSessionId ?? null
    this._session = new Session(this._sessionId, guard.backend)
    this._principal = options?.principal ?? null
    this._principalResolver = options?.principalResolver ?? null
  }

  get sessionId(): string {
    return this._sessionId
  }

  setPrincipal(principal: Principal): void {
    this._principal = principal
  }

  // -----------------------------------------------------------------------
  // Principal resolution
  // -----------------------------------------------------------------------

  private _resolvePrincipal(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Principal | null {
    if (this._principalResolver != null) {
      return this._principalResolver(toolName, toolInput)
    }
    return this._principal
  }

  // -----------------------------------------------------------------------
  // asCallbacks
  // -----------------------------------------------------------------------

  /**
   * Returns Vercel AI SDK callbacks for generateText / streamText.
   *
   * Usage:
   * ```ts
   * const adapter = new VercelAIAdapter(guard);
   * const result = await generateText({
   *   ...options,
   *   ...adapter.asCallbacks(),
   * });
   * ```
   */
  asCallbacks(options?: AsCallbacksOptions): {
    experimental_onToolCallStart: (event: OnToolCallStartEvent) => Promise<void>
    experimental_onToolCallFinish: (event: OnToolCallFinishEvent) => Promise<void>
  } {
    const onPostconditionWarn = options?.onPostconditionWarn ?? null

    return {
      experimental_onToolCallStart: async (event: OnToolCallStartEvent): Promise<void> => {
        const { toolCallId, toolName } = event.toolCall
        // Fail closed: deny if neither input (v6) nor args (v5) is present.
        // Uses == null to catch both null and undefined (JS callers, type assertions).
        // Emit audit + fire on_deny directly (cannot route through _pre — it would
        // emit CALL_ALLOWED when no rules deny the empty-args toolCall).
        // NOTE: observe mode does NOT apply here — we cannot evaluate rules against
        // unknown args, so we always fail closed regardless of mode.
        if (event.toolCall.input == null && event.toolCall.args == null) {
          const reason = 'Cannot determine tool arguments — neither input nor args present in event'
          await this._session.incrementAttempts()
          const toolCall = createEnvelope(
            toolName,
            {},
            {
              runId: this._sessionId,
              callIndex: this._callIndex,
              toolUseId: toolCallId,
              environment: this._guard.environment,
              registry: this._guard.toolRegistry,
              principal: this._resolvePrincipal(toolName, {}),
            },
          )
          this._callIndex += 1
          await this._guard.auditSink.emit(
            createAuditEvent({
              action: AA.CALL_DENIED,
              runId: toolCall.runId,
              callId: toolCall.callId,
              callIndex: toolCall.callIndex,
              sessionId: this._session.sessionId,
              toolName: toolCall.toolName,
              toolArgs: {},
              sideEffect: toolCall.sideEffect,
              environment: toolCall.environment,
              principal: toolCall.principal
                ? ({ ...toolCall.principal } as Record<string, unknown>)
                : null,
              parentSessionId: this._parentSessionId,
              decisionSource: 'adapter',
              reason,
              sessionAttemptCount: await this._session.attemptCount(),
              sessionExecutionCount: await this._session.executionCount(),
              mode: this._guard.mode,
              policyVersion: this._guard.policyVersion,
            }),
          )
          if (this._guard._onDeny) {
            try {
              this._guard._onDeny(toolCall, reason, null)
            } catch {
              // on_deny callback errors are swallowed
            }
          }
          throw new EdictumDenied(`DENIED: ${reason}`)
        }
        // Safe: the guard above ensures at least one is defined
        const args = (event.toolCall.input ?? event.toolCall.args) as Record<string, unknown>
        const result = await this._pre(toolName, args, toolCallId)
        if (result != null) {
          throw new EdictumDenied(result)
        }
      },

      experimental_onToolCallFinish: async (event: OnToolCallFinishEvent): Promise<void> => {
        const { toolCallId } = event.toolCall
        // Determine response: error takes precedence
        const toolResponse = event.error !== undefined ? String(event.error) : event.output

        const postResult = await this._post(toolCallId, toolResponse)

        if (!postResult.postconditionsPassed && onPostconditionWarn != null) {
          try {
            onPostconditionWarn(postResult.result, [...postResult.violations])
          } catch {
            // Callback errors are swallowed — they must not affect the SDK flow
          }
        }
      },
    }
  }

  // -----------------------------------------------------------------------
  // _pre — pre-execution governance
  // -----------------------------------------------------------------------

  /**
   * Run pre-execution governance. Returns denial reason string or null to allow.
   *
   * Exposed for direct testing without framework imports.
   */
  async _pre(
    toolName: string,
    toolInput: Record<string, unknown>,
    callId: string,
  ): Promise<string | null> {
    const toolCall = createEnvelope(toolName, toolInput, {
      runId: this._sessionId,
      callIndex: this._callIndex,
      toolUseId: callId,
      environment: this._guard.environment,
      registry: this._guard.toolRegistry,
      principal: this._resolvePrincipal(toolName, toolInput),
    })
    this._callIndex += 1

    // Increment attempts BEFORE governance
    await this._session.incrementAttempts()

    let decision = await this._pipeline.preExecute(toolCall, this._session)
    let workflowSnapshot = decision.workflow
    const initialWorkflowSnapshot = await this._emitWorkflowAuditEvents(
      toolCall,
      decision.workflowEvents,
    )
    if (initialWorkflowSnapshot != null) {
      workflowSnapshot = initialWorkflowSnapshot
      decision = { ...decision, workflow: initialWorkflowSnapshot }
    }

    for (let approvalRound = 0; decision.action === 'pending_approval'; approvalRound += 1) {
      if (this._guard._approvalBackend == null) {
        return `DENIED: Approval required but no approval backend configured: ${decision.reason}`
      }

      const principalDict = toolCall.principal
        ? ({ ...toolCall.principal } as Record<string, unknown>)
        : null

      const approvalRequest = await this._guard._approvalBackend.requestApproval(
        toolCall.toolName,
        toolCall.args as Record<string, unknown>,
        decision.approvalMessage ?? decision.reason ?? '',
        {
          timeout: decision.approvalTimeout,
          timeoutEffect: decision.approvalTimeoutEffect,
          principal: principalDict,
        },
      )

      await this._emitAuditPre(toolCall, decision, AA.CALL_ASKED)

      const approvalDecision = await this._guard._approvalBackend.waitForDecision(
        approvalRequest.approvalId,
        decision.approvalTimeout,
      )

      let approved = false
      if (approvalDecision.status === ApprovalStatus.TIMEOUT) {
        await this._emitAuditPre(toolCall, decision, AA.CALL_APPROVAL_TIMEOUT)
        if (decision.approvalTimeoutEffect === 'allow') {
          approved = true
        }
      } else if (!approvalDecision.approved) {
        await this._emitAuditPre(toolCall, decision, AA.CALL_APPROVAL_BLOCKED)
      } else {
        approved = true
        await this._emitAuditPre(toolCall, decision, AA.CALL_APPROVAL_GRANTED)
      }

      if (!approved) {
        const blockReason = approvalDecision.reason ?? decision.reason ?? ''
        if (this._guard._onDeny) {
          try {
            this._guard._onDeny(toolCall, blockReason, decision.decisionName)
          } catch {
            // on_deny callback raised — swallow
          }
        }
        this._pending.delete(callId)
        return `DENIED: ${blockReason}`
      }

      if (
        decision.decisionSource === 'workflow' &&
        decision.workflowStageId != null &&
        decision.workflowStageId !== ''
      ) {
        const workflowRuntime = this._guard.getWorkflowRuntime()
        if (workflowRuntime == null) {
          throw new Error(
            `workflow approval requested for ${JSON.stringify(decision.workflowStageId)} but no workflow runtime configured`,
          )
        }
        if (approvalRound >= MAX_WORKFLOW_APPROVAL_ROUNDS) {
          throw new Error(
            `workflow: exceeded maximum approval rounds (${MAX_WORKFLOW_APPROVAL_ROUNDS})`,
          )
        }
        await workflowRuntime.recordApproval(this._session, decision.workflowStageId)
        decision = await this._pipeline.preExecute(toolCall, this._session)
        workflowSnapshot = decision.workflow
        const approvalWorkflowSnapshot = await this._emitWorkflowAuditEvents(
          toolCall,
          decision.workflowEvents,
        )
        if (approvalWorkflowSnapshot != null) {
          workflowSnapshot = approvalWorkflowSnapshot
          decision = { ...decision, workflow: approvalWorkflowSnapshot }
        }
        continue
      }

      if (this._guard._onAllow) {
        try {
          this._guard._onAllow(toolCall)
        } catch {
          // on_allow callback raised — swallow
        }
      }
      this._pending.set(callId, {
        toolCall,
        workflowStageId: decision.workflowStageId,
        workflowInvolved: decision.workflowInvolved,
      })
      return null
    }

    if (this._guard.mode === 'observe' && decision.action === 'deny') {
      await this._emitAuditPre(toolCall, decision, AA.CALL_WOULD_BLOCK)
      this._pending.set(callId, {
        toolCall,
        workflowStageId: decision.workflowStageId,
        workflowInvolved: decision.workflowInvolved,
      })
      return null
    }

    if (decision.action === 'deny') {
      await this._emitAuditPre(toolCall, decision)
      if (this._guard._onDeny) {
        try {
          this._guard._onDeny(toolCall, decision.reason ?? '', decision.decisionName)
        } catch {
          // on_deny callback raised — swallow
        }
      }
      this._pending.delete(callId)
      return `DENIED: ${decision.reason}`
    }

    if (decision.observed) {
      for (const cr of decision.contractsEvaluated) {
        if (cr['observed'] && !cr['passed']) {
          await this._guard.auditSink.emit(
            createAuditEvent({
              action: AA.CALL_WOULD_BLOCK,
              runId: toolCall.runId,
              callId: toolCall.callId,
              callIndex: toolCall.callIndex,
              sessionId: this._session.sessionId,
              toolName: toolCall.toolName,
              toolArgs: this._guard.redaction.redactArgs(toolCall.args) as Record<string, unknown>,
              sideEffect: toolCall.sideEffect,
              environment: toolCall.environment,
              principal: toolCall.principal
                ? ({ ...toolCall.principal } as Record<string, unknown>)
                : null,
              parentSessionId: this._parentSessionId,
              decisionSource: 'precondition',
              decisionName: cr['name'] as string,
              reason: cr['message'] as string | null,
              mode: 'observe',
              policyVersion: this._guard.policyVersion,
              policyError: decision.policyError,
              workflow: workflowSnapshot,
            }),
          )
        }
      }
    }

    await this._emitAuditPre(toolCall, decision)
    if (this._guard._onAllow) {
      try {
        this._guard._onAllow(toolCall)
      } catch {
        // on_allow callback raised — swallow
      }
    }
    this._pending.set(callId, {
      toolCall,
      workflowStageId: decision.workflowStageId,
      workflowInvolved: decision.workflowInvolved,
    })

    for (const sr of decision.observeResults) {
      try {
        const observeAction = sr['passed'] ? AA.CALL_ALLOWED : AA.CALL_WOULD_BLOCK
        await this._guard.auditSink.emit(
          createAuditEvent({
            action: observeAction,
            runId: toolCall.runId,
            callId: toolCall.callId,
            callIndex: toolCall.callIndex,
            sessionId: this._session.sessionId,
            toolName: toolCall.toolName,
            toolArgs: this._guard.redaction.redactArgs(toolCall.args) as Record<string, unknown>,
            sideEffect: toolCall.sideEffect,
            environment: toolCall.environment,
            principal: toolCall.principal
              ? ({ ...toolCall.principal } as Record<string, unknown>)
              : null,
            parentSessionId: this._parentSessionId,
            decisionSource: sr['source'] as string | null,
            decisionName: sr['name'] as string | null,
            reason: sr['message'] as string | null,
            mode: 'observe',
            policyVersion: this._guard.policyVersion,
            workflow: workflowSnapshot,
          }),
        )
      } catch {
        // Observe audit errors must not block tool execution — continue with remaining
      }
    }

    return null
  }

  // -----------------------------------------------------------------------
  // _post — post-execution governance
  // -----------------------------------------------------------------------

  /**
   * Run post-execution governance. Returns PostCallResult with violations.
   *
   * Exposed for direct testing without framework imports.
   */
  async _post(callId: string, toolResponse: unknown = undefined): Promise<PostCallResult> {
    const pending = this._pending.get(callId)
    this._pending.delete(callId)

    if (!pending) {
      return createPostCallResult({ result: toolResponse })
    }

    const { toolCall, workflowStageId, workflowInvolved } = pending

    // Derive tool_success from response
    const toolSuccess = this._checkToolSuccess(toolCall.toolName, toolResponse)

    // Run pipeline
    const postDecision = await this._pipeline.postExecute(toolCall, toolResponse, toolSuccess)

    const effectiveResponse =
      postDecision.redactedResponse != null ? postDecision.redactedResponse : toolResponse

    let workflowEvents: Record<string, unknown>[] = []
    if (toolSuccess && workflowInvolved && workflowStageId != null) {
      const workflowRuntime = this._guard.getWorkflowRuntime()
      if (workflowRuntime != null) {
        workflowEvents = await workflowRuntime.recordResult(
          this._session,
          workflowStageId,
          toolCall,
        )
      }
    }

    await this._session.recordExecution(toolCall.toolName, toolSuccess)
    let workflowSnapshot = await this._emitWorkflowAuditEvents(toolCall, workflowEvents)
    if (workflowSnapshot == null) {
      workflowSnapshot = await this._buildWorkflowContext()
    }

    // Emit audit
    const action: AuditAction = toolSuccess ? AA.CALL_EXECUTED : AA.CALL_FAILED
    await this._guard.auditSink.emit(
      createAuditEvent({
        action,
        runId: toolCall.runId,
        callId: toolCall.callId,
        callIndex: toolCall.callIndex,
        sessionId: this._session.sessionId,
        toolName: toolCall.toolName,
        toolArgs: this._guard.redaction.redactArgs(toolCall.args) as Record<string, unknown>,
        sideEffect: toolCall.sideEffect,
        environment: toolCall.environment,
        principal: toolCall.principal
          ? ({ ...toolCall.principal } as Record<string, unknown>)
          : null,
        parentSessionId: this._parentSessionId,
        toolSuccess,
        postconditionsPassed: postDecision.postconditionsPassed,
        contractsEvaluated: postDecision.contractsEvaluated,
        workflow: workflowSnapshot,
        sessionAttemptCount: await this._session.attemptCount(),
        sessionExecutionCount: await this._session.executionCount(),
        mode: this._guard.mode,
        policyVersion: this._guard.policyVersion,
        policyError: postDecision.policyError,
      }),
    )

    const violations = buildViolations(postDecision as unknown as PostDecisionLike)
    return createPostCallResult({
      result: effectiveResponse,
      postconditionsPassed: postDecision.postconditionsPassed,
      violations,
      outputSuppressed: postDecision.outputSuppressed,
    })
  }

  // -----------------------------------------------------------------------
  // Audit helpers
  // -----------------------------------------------------------------------

  private async _emitAuditPre(
    toolCall: ReturnType<typeof createEnvelope>,
    decision: PreDecision,
    auditAction?: AuditAction,
  ): Promise<void> {
    const action: AuditAction =
      auditAction ?? (decision.action === 'deny' ? AA.CALL_BLOCKED : AA.CALL_ALLOWED)

    await this._guard.auditSink.emit(
      createAuditEvent({
        action,
        runId: toolCall.runId,
        callId: toolCall.callId,
        callIndex: toolCall.callIndex,
        sessionId: this._session.sessionId,
        toolName: toolCall.toolName,
        toolArgs: this._guard.redaction.redactArgs(toolCall.args) as Record<string, unknown>,
        sideEffect: toolCall.sideEffect,
        environment: toolCall.environment,
        principal: toolCall.principal
          ? ({ ...toolCall.principal } as Record<string, unknown>)
          : null,
        parentSessionId: this._parentSessionId,
        decisionSource: decision.decisionSource,
        decisionName: decision.decisionName,
        reason: decision.reason,
        hooksEvaluated: decision.hooksEvaluated,
        contractsEvaluated: decision.contractsEvaluated,
        workflow: decision.workflow,
        sessionAttemptCount: await this._session.attemptCount(),
        sessionExecutionCount: await this._session.executionCount(),
        mode: this._guard.mode,
        policyVersion: this._guard.policyVersion,
        policyError: decision.policyError,
      }),
    )
  }

  private async _emitWorkflowAuditEvents(
    toolCall: ReturnType<typeof createEnvelope>,
    events: readonly Record<string, unknown>[],
  ): Promise<WorkflowContext | null> {
    let latest: WorkflowContext | null = null

    for (const record of events) {
      const action = record['action']
      const workflow = record['workflow']
      if (!this._isWorkflowAuditAction(action) || !this._isWorkflowContext(workflow)) {
        continue
      }

      latest = workflow
      await this._guard.auditSink.emit(
        createAuditEvent({
          action,
          runId: toolCall.runId,
          callId: toolCall.callId,
          callIndex: toolCall.callIndex,
          sessionId: this._session.sessionId,
          toolName: toolCall.toolName,
          toolArgs: this._guard.redaction.redactArgs(toolCall.args) as Record<string, unknown>,
          sideEffect: toolCall.sideEffect,
          environment: toolCall.environment,
          principal: toolCall.principal
            ? ({ ...toolCall.principal } as Record<string, unknown>)
            : null,
          parentSessionId: this._parentSessionId,
          workflow,
          sessionAttemptCount: await this._session.attemptCount(),
          sessionExecutionCount: await this._session.executionCount(),
          mode: this._guard.mode,
          policyVersion: this._guard.policyVersion,
        }),
      )
    }

    return latest
  }

  private async _buildWorkflowContext(): Promise<WorkflowContext | null> {
    const workflowRuntime = this._guard.getWorkflowRuntime()
    if (workflowRuntime == null) {
      return null
    }

    const state = await workflowRuntime.state(this._session)
    const context: WorkflowContext = {
      name: workflowRuntime.definition.metadata.name,
      activeStage: state.activeStage,
      completedStages: [...state.completedStages],
      blockedReason: state.blockedReason,
      pendingApproval: { ...state.pendingApproval },
    }

    if (typeof workflowRuntime.definition.metadata.version === 'string') {
      ;(context as { version?: string }).version = workflowRuntime.definition.metadata.version
    }
    if (state.lastBlockedAction != null) {
      ;(context as { lastBlockedAction?: WorkflowContext['lastBlockedAction'] }).lastBlockedAction =
        { ...state.lastBlockedAction }
    }
    if (state.lastRecordedEvidence != null) {
      ;(
        context as { lastRecordedEvidence?: WorkflowContext['lastRecordedEvidence'] }
      ).lastRecordedEvidence = { ...state.lastRecordedEvidence }
    }

    return context
  }

  private _isWorkflowAuditAction(action: unknown): action is AuditAction {
    return (
      action === AA.WORKFLOW_STAGE_ADVANCED ||
      action === AA.WORKFLOW_COMPLETED ||
      action === AA.WORKFLOW_STATE_UPDATED
    )
  }

  private _isWorkflowContext(value: unknown): value is WorkflowContext {
    if (typeof value !== 'object' || value == null || Array.isArray(value)) {
      return false
    }
    const workflow = value as Record<string, unknown>
    return (
      typeof workflow['name'] === 'string' &&
      typeof workflow['activeStage'] === 'string' &&
      Array.isArray(workflow['completedStages']) &&
      (typeof workflow['blockedReason'] === 'string' || workflow['blockedReason'] === null) &&
      typeof workflow['pendingApproval'] === 'object' &&
      workflow['pendingApproval'] != null
    )
  }

  // -----------------------------------------------------------------------
  // Tool success detection
  // -----------------------------------------------------------------------

  private _checkToolSuccess(toolName: string, toolResponse: unknown): boolean {
    if (this._guard._successCheck != null) {
      return this._guard._successCheck(toolName, toolResponse)
    }
    return defaultSuccessCheck(toolName, toolResponse)
  }
}
