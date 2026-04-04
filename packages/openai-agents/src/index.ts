/**
 * OpenAI Agents SDK adapter -- per-tool input/output guardrail integration.
 *
 * The adapter does NOT contain governance logic -- that lives in
 * CheckPipeline. The adapter only:
 * 1. Creates envelopes from SDK guardrail data
 * 2. Manages pending state (toolCall + span) between input/output guardrails
 * 3. Translates PreDecision/PostDecision into guardrail output format
 * 4. Handles observe mode (deny -> allow conversion)
 *
 * Note: Native guardrails (asGuardrails) cannot substitute tool results.
 * Postcondition effect=redact requires the wrapper integration path.
 * Postcondition effect=deny is enforced natively via tripwireTriggered.
 */

import { randomUUID } from 'node:crypto'

import {
  ApprovalStatus,
  AuditAction,
  createAuditEvent,
  createEnvelope,
  type Edictum,
  CheckPipeline,
  type PostCallResult,
  type Principal,
  type ToolCall,
  Session,
  buildViolations,
  createPostCallResult,
  defaultSuccessCheck,
  type Violation,
  type PreDecision,
  type PostDecisionLike,
  type WorkflowContext,
} from '@edictum/core'

export const VERSION = '0.1.0' as const
const MAX_WORKFLOW_APPROVAL_ROUNDS = 32

// ---------------------------------------------------------------------------
// InputGuardrail / OutputGuardrail types (structural, no SDK import needed)
// ---------------------------------------------------------------------------

/** Structural type matching @openai/agents InputGuardrail. */
export interface InputGuardrail {
  readonly name: string
  readonly execute: (ctx: { input: unknown }) => Promise<{
    tripwireTriggered: boolean
    outputInfo?: unknown
  }>
}

/** Structural type matching @openai/agents OutputGuardrail. */
export interface OutputGuardrail {
  readonly name: string
  readonly execute: (ctx: { agentOutput: unknown }) => Promise<{
    tripwireTriggered: boolean
    outputInfo?: unknown
  }>
}

// ---------------------------------------------------------------------------
// AdapterOptions
// ---------------------------------------------------------------------------

export interface OpenAIAgentsAdapterOptions {
  readonly sessionId?: string
  readonly parentSessionId?: string
  readonly principal?: Principal
  readonly principalResolver?: (toolName: string, toolInput: Record<string, unknown>) => Principal
}

// ---------------------------------------------------------------------------
// AsGuardrailsOptions
// ---------------------------------------------------------------------------

export interface AsGuardrailsOptions {
  readonly onPostconditionWarn?: (result: unknown, violations: Violation[]) => void
}

// ---------------------------------------------------------------------------
// OpenAIAgentsAdapter
// ---------------------------------------------------------------------------

export class OpenAIAgentsAdapter {
  private readonly _guard: Edictum
  private readonly _pipeline: CheckPipeline
  private readonly _sessionId: string
  private readonly _parentSessionId: string | null
  private readonly _session: Session
  private _callIndex: number
  private readonly _pending: Map<
    string,
    {
      toolCall: Readonly<ToolCall>
      workflowStageId: string | null
      workflowInvolved: boolean
    }
  >
  private _principal: Principal | null
  private readonly _principalResolver:
    | ((toolName: string, toolInput: Record<string, unknown>) => Principal)
    | null
  private _onPostconditionWarn: ((result: unknown, violations: Violation[]) => void) | null

  constructor(guard: Edictum, options?: OpenAIAgentsAdapterOptions) {
    this._guard = guard
    this._pipeline = new CheckPipeline(guard)
    this._sessionId = options?.sessionId ?? randomUUID()
    this._parentSessionId = options?.parentSessionId ?? null
    this._session = new Session(this._sessionId, guard.backend)
    this._callIndex = 0
    this._pending = new Map()
    this._principal = options?.principal ?? null
    this._principalResolver = options?.principalResolver ?? null
    this._onPostconditionWarn = null
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
  // asGuardrails
  // -----------------------------------------------------------------------

  asGuardrails(options?: AsGuardrailsOptions): {
    inputGuardrail: InputGuardrail
    outputGuardrail: OutputGuardrail
  } {
    this._onPostconditionWarn = options?.onPostconditionWarn ?? null

    const inputGuardrail: InputGuardrail = {
      name: 'edictum_input_guardrail',
      execute: async ({ input }) => {
        // Parse input: expect { toolName, toolInput, callId } or similar
        const parsed = this._parseInput(input)
        const result = await this._pre(parsed.toolName, parsed.toolInput, parsed.callId)
        if (result != null) {
          return { tripwireTriggered: true, outputInfo: result }
        }
        return { tripwireTriggered: false }
      },
    }

    const outputGuardrail: OutputGuardrail = {
      name: 'edictum_output_guardrail',
      execute: async ({ agentOutput }) => {
        // Preserve structured output for postcondition/success inspection
        const toolOutput = agentOutput ?? ''

        // Correlate to pending call — only if unambiguous (exactly one pending).
        //
        // LIMITATION: The OpenAI Agents SDK output guardrail receives the agent's
        // text output (agentOutput), not per-tool output. There is no callId or
        // toolName in the guardrail context, so we can only correlate by pending
        // count. When multiple tool calls are in-flight simultaneously,
        // postcondition evaluation is skipped to avoid misattributing output to
        // the wrong call. This means postconditions are not enforced under
        // concurrent load. For guaranteed postcondition enforcement, use the
        // wrapper integration path (_pre/_post with explicit callIds).
        if (this._pending.size === 1) {
          const callId = this._pending.keys().next().value as string
          const postResult = await this._post(callId, toolOutput)
          if (postResult.outputSuppressed) {
            return {
              tripwireTriggered: true,
              outputInfo: String(postResult.result),
            }
          }
        }

        return { tripwireTriggered: false }
      },
    }

    return { inputGuardrail, outputGuardrail }
  }

  // -----------------------------------------------------------------------
  // _parseInput — extract tool info from guardrail input
  // -----------------------------------------------------------------------

  private _parseInput(input: unknown): {
    toolName: string
    toolInput: Record<string, unknown>
    callId: string
  } {
    if (input != null && typeof input === 'object') {
      const obj = input as Record<string, unknown>
      return {
        toolName: typeof obj['toolName'] === 'string' ? obj['toolName'] : 'unknown',
        toolInput:
          typeof obj['toolInput'] === 'object' && obj['toolInput'] != null
            ? (obj['toolInput'] as Record<string, unknown>)
            : {},
        callId: typeof obj['callId'] === 'string' ? obj['callId'] : randomUUID(),
      }
    }
    return { toolName: 'unknown', toolInput: {}, callId: randomUUID() }
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

    try {
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

        await this._emitAuditPre(toolCall, decision, AuditAction.CALL_ASKED)

        const approvalDecision = await this._guard._approvalBackend.waitForDecision(
          approvalRequest.approvalId,
          decision.approvalTimeout,
        )

        let approved = false
        if (approvalDecision.status === ApprovalStatus.TIMEOUT) {
          await this._emitAuditPre(toolCall, decision, AuditAction.CALL_APPROVAL_TIMEOUT)
          if (decision.approvalTimeoutEffect === 'allow') {
            approved = true
          }
        } else if (!approvalDecision.approved) {
          await this._emitAuditPre(toolCall, decision, AuditAction.CALL_APPROVAL_BLOCKED)
        } else {
          approved = true
          await this._emitAuditPre(toolCall, decision, AuditAction.CALL_APPROVAL_GRANTED)
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
        await this._emitAuditPre(toolCall, decision, AuditAction.CALL_WOULD_BLOCK)
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
                action: AuditAction.CALL_WOULD_BLOCK,
                runId: toolCall.runId,
                callId: toolCall.callId,
                callIndex: toolCall.callIndex,
                sessionId: this._session.sessionId,
                toolName: toolCall.toolName,
                toolArgs: this._guard.redaction.redactArgs(toolCall.args) as Record<
                  string,
                  unknown
                >,
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
          const observeAction = sr['passed']
            ? AuditAction.CALL_ALLOWED
            : AuditAction.CALL_WOULD_BLOCK
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
    } catch (err) {
      if (!this._pending.has(callId)) {
        // No pending state to clean up
      }
      throw err
    }
  }

  // -----------------------------------------------------------------------
  // _post — post-execution governance
  // -----------------------------------------------------------------------

  /**
   * Run post-execution governance. Returns PostCallResult with violations.
   *
   * Exposed for direct testing without framework imports.
   */
  async _post(callId: string, toolResponse: unknown = null): Promise<PostCallResult> {
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
    const action = toolSuccess ? AuditAction.CALL_EXECUTED : AuditAction.CALL_FAILED
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
    const postResult = createPostCallResult({
      result: effectiveResponse,
      postconditionsPassed: postDecision.postconditionsPassed,
      violations,
      outputSuppressed: postDecision.outputSuppressed,
    })

    // Call callback for side effects
    if (!postResult.postconditionsPassed && this._onPostconditionWarn) {
      try {
        this._onPostconditionWarn(postResult.result, [...postResult.violations])
      } catch {
        // on_postcondition_warn callback raised — swallow
      }
    }

    return postResult
  }

  // -----------------------------------------------------------------------
  // _emitAuditPre
  // -----------------------------------------------------------------------

  private async _emitAuditPre(
    toolCall: Readonly<ToolCall>,
    decision: PreDecision,
    auditAction?: AuditAction,
  ): Promise<void> {
    const action =
      auditAction ??
      (decision.action === 'deny' ? AuditAction.CALL_BLOCKED : AuditAction.CALL_ALLOWED)

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
    toolCall: Readonly<ToolCall>,
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
      action === AuditAction.WORKFLOW_STAGE_ADVANCED ||
      action === AuditAction.WORKFLOW_COMPLETED ||
      action === AuditAction.WORKFLOW_STATE_UPDATED
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
  // _checkToolSuccess
  // -----------------------------------------------------------------------

  private _checkToolSuccess(toolName: string, toolResponse: unknown): boolean {
    if (this._guard._successCheck != null) {
      return this._guard._successCheck(toolName, toolResponse)
    }
    return defaultSuccessCheck(toolName, toolResponse)
  }
}
