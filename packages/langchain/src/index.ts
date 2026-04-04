/**
 * @edictum/langchain -- LangChain.js adapter for edictum.
 *
 * Translates Edictum pipeline decisions into LangChain middleware format.
 * The adapter does NOT contain governance logic -- that lives in CheckPipeline.
 *
 * Integration point: wrapToolCall middleware for ToolNode.
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
// LangChain types (structural -- no framework import needed)
// ---------------------------------------------------------------------------

/** Structural type for a LangChain tool call request. */
export interface ToolCallRequest {
  readonly toolCall: {
    readonly name: string
    readonly args: Record<string, unknown>
    readonly id: string
  }
}

/** Handler function that executes the actual tool. */
export type ToolCallHandler = (request: ToolCallRequest) => Promise<unknown>

// ---------------------------------------------------------------------------
// LangChainAdapterOptions
// ---------------------------------------------------------------------------

export interface LangChainAdapterOptions {
  readonly sessionId?: string
  readonly parentSessionId?: string
  readonly principal?: Principal
  readonly principalResolver?: (toolName: string, toolInput: Record<string, unknown>) => Principal
}

// ---------------------------------------------------------------------------
// AsMiddlewareOptions
// ---------------------------------------------------------------------------

export interface AsMiddlewareOptions {
  readonly onPostconditionWarn?: (result: unknown, violations: Violation[]) => void
}

// ---------------------------------------------------------------------------
// AsToolWrapperOptions
// ---------------------------------------------------------------------------

export interface AsToolWrapperOptions {
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
// LangChainAdapter
// ---------------------------------------------------------------------------

/**
 * Translate Edictum pipeline decisions into LangChain middleware format.
 *
 * The adapter does NOT contain governance logic -- that lives in
 * CheckPipeline. The adapter only:
 * 1. Creates envelopes from LangChain ToolCallRequest
 * 2. Manages pending state (toolCall) between pre/post
 * 3. Translates PreDecision/PostDecision into middleware behavior
 * 4. Handles observe mode (deny -> allow conversion)
 */
export class LangChainAdapter {
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

  constructor(guard: Edictum, options?: LangChainAdapterOptions) {
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
  // asMiddleware
  // -----------------------------------------------------------------------

  /**
   * Returns a middleware-compatible object for LangChain ToolNode.
   *
   * Usage:
   * ```ts
   * const adapter = new LangChainAdapter(guard);
   * const middleware = adapter.asMiddleware();
   * // Pass to ToolNode or agent as tool_call_middleware
   * ```
   */
  asMiddleware(options?: AsMiddlewareOptions): {
    name: string
    wrapToolCall: (request: ToolCallRequest, handler: ToolCallHandler) => Promise<unknown>
  } {
    const onPostconditionWarn = options?.onPostconditionWarn ?? null

    return {
      name: 'edictum',
      wrapToolCall: async (
        request: ToolCallRequest,
        handler: ToolCallHandler,
      ): Promise<unknown> => {
        const { name: toolName, args: toolArgs, id: callId } = request.toolCall

        // Pre-execution governance
        const preResult = await this._pre(toolName, toolArgs, callId)
        if (preResult != null) {
          throw new EdictumDenied(preResult)
        }

        // Execute the tool
        let result: unknown
        let toolSuccess = true
        try {
          result = await handler(request)
        } catch (err) {
          result = String(err)
          toolSuccess = false
        }

        // Post-execution governance (always runs, even on tool failure)
        const postResult = await this._post(callId, result)

        // Fire callback on postcondition failure
        if (!postResult.postconditionsPassed && onPostconditionWarn != null) {
          try {
            onPostconditionWarn(postResult.result, [...postResult.violations])
          } catch {
            // on_postcondition_warn callback raised -- swallow
          }
        }

        // Re-throw tool errors after recording the execution
        if (!toolSuccess) {
          throw new Error(String(result))
        }

        return postResult.result
      },
    }
  }

  // -----------------------------------------------------------------------
  // asToolWrapper
  // -----------------------------------------------------------------------

  /**
   * Returns a wrapper function for any tool callable.
   *
   * The wrapper runs pre-execution governance before calling the tool,
   * then post-execution governance after. Throws EdictumDenied on deny.
   *
   * Usage:
   * ```ts
   * const adapter = new LangChainAdapter(guard);
   * const wrapper = adapter.asToolWrapper();
   * const governed = wrapper(myToolFn);
   * const result = await governed("MyTool", { arg: "value" });
   * ```
   */
  asToolWrapper(
    options?: AsToolWrapperOptions,
  ): (
    toolCallable: (args: Record<string, unknown>) => unknown | Promise<unknown>,
  ) => (toolName: string, toolInput: Record<string, unknown>, callId?: string) => Promise<unknown> {
    const onPostconditionWarn = options?.onPostconditionWarn ?? null

    return (toolCallable: (args: Record<string, unknown>) => unknown | Promise<unknown>) => {
      return async (
        toolName: string,
        toolInput: Record<string, unknown>,
        callId?: string,
      ): Promise<unknown> => {
        const resolvedCallId = callId ?? randomUUID()

        // Pre-execution governance
        const preResult = await this._pre(toolName, toolInput, resolvedCallId)
        if (preResult != null) {
          throw new EdictumDenied(preResult)
        }

        // Execute the tool
        let result: unknown
        let toolSuccess = true
        try {
          result = await toolCallable(toolInput)
        } catch (err) {
          result = String(err)
          toolSuccess = false
        }

        // Post-execution governance (always runs, even on tool failure)
        const postResult = await this._post(resolvedCallId, result)

        // Fire callback on postcondition failure
        if (!postResult.postconditionsPassed && onPostconditionWarn != null) {
          try {
            onPostconditionWarn(postResult.result, [...postResult.violations])
          } catch {
            // on_postcondition_warn callback raised -- swallow
          }
        }

        // Re-throw tool errors after recording the execution
        if (!toolSuccess) {
          throw new Error(String(result))
        }

        return postResult.result
      }
    }
  }

  // -----------------------------------------------------------------------
  // _pre -- pre-execution governance
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
            // on_deny callback raised -- swallow
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
          // on_allow callback raised -- swallow
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
          // on_deny callback raised -- swallow
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
        // on_allow callback raised -- swallow
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
  // _post -- post-execution governance
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
