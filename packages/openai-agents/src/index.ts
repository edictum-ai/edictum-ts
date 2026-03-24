/**
 * OpenAI Agents SDK adapter -- per-tool input/output guardrail integration.
 *
 * The adapter does NOT contain governance logic -- that lives in
 * GovernancePipeline. The adapter only:
 * 1. Creates envelopes from SDK guardrail data
 * 2. Manages pending state (envelope + span) between input/output guardrails
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
  GovernancePipeline,
  type PostCallResult,
  type Principal,
  type ToolEnvelope,
  Session,
  buildFindings,
  createPostCallResult,
  defaultSuccessCheck,
  type Finding,
  type PreDecision,
  type PostDecisionLike,
} from '@edictum/core'

export const VERSION = '0.1.0' as const

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
  readonly principal?: Principal
  readonly principalResolver?: (toolName: string, toolInput: Record<string, unknown>) => Principal
}

// ---------------------------------------------------------------------------
// AsGuardrailsOptions
// ---------------------------------------------------------------------------

export interface AsGuardrailsOptions {
  readonly onPostconditionWarn?: (result: unknown, findings: Finding[]) => void
}

// ---------------------------------------------------------------------------
// OpenAIAgentsAdapter
// ---------------------------------------------------------------------------

export class OpenAIAgentsAdapter {
  private readonly _guard: Edictum
  private readonly _pipeline: GovernancePipeline
  private readonly _sessionId: string
  private readonly _session: Session
  private _callIndex: number
  private readonly _pending: Map<string, { envelope: Readonly<ToolEnvelope> }>
  private _principal: Principal | null
  private readonly _principalResolver:
    | ((toolName: string, toolInput: Record<string, unknown>) => Principal)
    | null
  private _onPostconditionWarn: ((result: unknown, findings: Finding[]) => void) | null

  constructor(guard: Edictum, options?: OpenAIAgentsAdapterOptions) {
    this._guard = guard
    this._pipeline = new GovernancePipeline(guard)
    this._sessionId = options?.sessionId ?? randomUUID()
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

        // Try FIFO correlation (insertion-order) for sequential execution
        if (this._pending.size > 0) {
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
    const envelope = createEnvelope(toolName, toolInput, {
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
      // Run pipeline
      const decision = await this._pipeline.preExecute(envelope, this._session)

      // Finding 1: Handle pending_approval
      if (decision.action === 'pending_approval') {
        if (this._guard._approvalBackend == null) {
          return `DENIED: Approval required but no approval backend configured: ${decision.reason}`
        }

        const principalDict = envelope.principal
          ? ({ ...envelope.principal } as Record<string, unknown>)
          : null

        const approvalRequest = await this._guard._approvalBackend.requestApproval(
          envelope.toolName,
          envelope.args as Record<string, unknown>,
          decision.approvalMessage ?? decision.reason ?? '',
          {
            timeout: decision.approvalTimeout,
            timeoutEffect: decision.approvalTimeoutEffect,
            principal: principalDict,
          },
        )

        await this._emitAuditPre(envelope, decision, AuditAction.CALL_APPROVAL_REQUESTED)

        const approvalDecision = await this._guard._approvalBackend.waitForDecision(
          approvalRequest.approvalId,
          decision.approvalTimeout,
        )

        let approved = false
        if (approvalDecision.status === ApprovalStatus.TIMEOUT) {
          await this._emitAuditPre(envelope, decision, AuditAction.CALL_APPROVAL_TIMEOUT)
          if (decision.approvalTimeoutEffect === 'allow') {
            approved = true
          }
        } else if (!approvalDecision.approved) {
          await this._emitAuditPre(envelope, decision, AuditAction.CALL_APPROVAL_DENIED)
        } else {
          approved = true
          await this._emitAuditPre(envelope, decision, AuditAction.CALL_APPROVAL_GRANTED)
        }

        if (approved) {
          if (this._guard._onAllow) {
            try {
              this._guard._onAllow(envelope)
            } catch {
              // on_allow callback raised — swallow
            }
          }
          this._pending.set(callId, { envelope })
          return null
        } else {
          const denyReason = approvalDecision.reason ?? decision.reason ?? ''
          if (this._guard._onDeny) {
            try {
              this._guard._onDeny(envelope, denyReason, decision.decisionName)
            } catch {
              // on_deny callback raised — swallow
            }
          }
          this._pending.delete(callId)
          return `DENIED: ${denyReason}`
        }
      }

      // Handle observe mode: convert deny to allow with warning
      if (this._guard.mode === 'observe' && decision.action === 'deny') {
        await this._emitAuditPre(envelope, decision, AuditAction.CALL_WOULD_DENY)
        this._pending.set(callId, { envelope })
        return null // allow through
      }

      // Handle deny
      if (decision.action === 'deny') {
        await this._emitAuditPre(envelope, decision)
        if (this._guard._onDeny) {
          try {
            this._guard._onDeny(envelope, decision.reason ?? '', decision.decisionName)
          } catch {
            // on_deny callback raised — swallow
          }
        }
        this._pending.delete(callId)
        return `DENIED: ${decision.reason}`
      }

      // Handle per-contract observed denials
      if (decision.observed) {
        for (const cr of decision.contractsEvaluated) {
          if (cr['observed'] && !cr['passed']) {
            await this._guard.auditSink.emit(
              createAuditEvent({
                action: AuditAction.CALL_WOULD_DENY,
                runId: envelope.runId,
                callId: envelope.callId,
                callIndex: envelope.callIndex,
                toolName: envelope.toolName,
                toolArgs: this._guard.redaction.redactArgs(envelope.args) as Record<
                  string,
                  unknown
                >,
                sideEffect: envelope.sideEffect,
                environment: envelope.environment,
                principal: envelope.principal
                  ? ({ ...envelope.principal } as Record<string, unknown>)
                  : null,
                decisionSource: 'precondition',
                decisionName: cr['name'] as string,
                reason: cr['message'] as string | null,
                mode: 'observe',
                policyVersion: this._guard.policyVersion,
                policyError: decision.policyError,
              }),
            )
          }
        }
      }

      // Handle allow
      await this._emitAuditPre(envelope, decision)
      if (this._guard._onAllow) {
        try {
          this._guard._onAllow(envelope)
        } catch {
          // on_allow callback raised — swallow
        }
      }
      this._pending.set(callId, { envelope })

      // Observe-mode audits — errors swallowed (must not block execution)
      for (const sr of decision.observeResults) {
        try {
          const observeAction = sr['passed']
            ? AuditAction.CALL_ALLOWED
            : AuditAction.CALL_WOULD_DENY
          await this._guard.auditSink.emit(
            createAuditEvent({
              action: observeAction,
              runId: envelope.runId,
              callId: envelope.callId,
              callIndex: envelope.callIndex,
              toolName: envelope.toolName,
              toolArgs: this._guard.redaction.redactArgs(envelope.args) as Record<string, unknown>,
              sideEffect: envelope.sideEffect,
              environment: envelope.environment,
              principal: envelope.principal
                ? ({ ...envelope.principal } as Record<string, unknown>)
                : null,
              decisionSource: sr['source'] as string | null,
              decisionName: sr['name'] as string | null,
              reason: sr['message'] as string | null,
              mode: 'observe',
              policyVersion: this._guard.policyVersion,
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
   * Run post-execution governance. Returns PostCallResult with findings.
   *
   * Exposed for direct testing without framework imports.
   */
  async _post(callId: string, toolResponse: unknown = null): Promise<PostCallResult> {
    const pending = this._pending.get(callId)
    this._pending.delete(callId)

    if (!pending) {
      return createPostCallResult({ result: toolResponse })
    }

    const { envelope } = pending

    // Derive tool_success from response
    const toolSuccess = this._checkToolSuccess(envelope.toolName, toolResponse)

    // Run pipeline
    const postDecision = await this._pipeline.postExecute(envelope, toolResponse, toolSuccess)

    const effectiveResponse =
      postDecision.redactedResponse != null ? postDecision.redactedResponse : toolResponse

    // Record in session
    await this._session.recordExecution(envelope.toolName, toolSuccess)

    // Emit audit
    const action = toolSuccess ? AuditAction.CALL_EXECUTED : AuditAction.CALL_FAILED
    await this._guard.auditSink.emit(
      createAuditEvent({
        action,
        runId: envelope.runId,
        callId: envelope.callId,
        callIndex: envelope.callIndex,
        toolName: envelope.toolName,
        toolArgs: this._guard.redaction.redactArgs(envelope.args) as Record<string, unknown>,
        sideEffect: envelope.sideEffect,
        environment: envelope.environment,
        principal: envelope.principal
          ? ({ ...envelope.principal } as Record<string, unknown>)
          : null,
        toolSuccess,
        postconditionsPassed: postDecision.postconditionsPassed,
        contractsEvaluated: postDecision.contractsEvaluated,
        sessionAttemptCount: await this._session.attemptCount(),
        sessionExecutionCount: await this._session.executionCount(),
        mode: this._guard.mode,
        policyVersion: this._guard.policyVersion,
        policyError: postDecision.policyError,
      }),
    )

    const findings = buildFindings(postDecision as unknown as PostDecisionLike)
    const postResult = createPostCallResult({
      result: effectiveResponse,
      postconditionsPassed: postDecision.postconditionsPassed,
      findings,
      outputSuppressed: postDecision.outputSuppressed,
    })

    // Call callback for side effects
    if (!postResult.postconditionsPassed && this._onPostconditionWarn) {
      try {
        this._onPostconditionWarn(postResult.result, [...postResult.findings])
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
    envelope: Readonly<ToolEnvelope>,
    decision: PreDecision,
    auditAction?: AuditAction,
  ): Promise<void> {
    const action =
      auditAction ??
      (decision.action === 'deny' ? AuditAction.CALL_DENIED : AuditAction.CALL_ALLOWED)

    await this._guard.auditSink.emit(
      createAuditEvent({
        action,
        runId: envelope.runId,
        callId: envelope.callId,
        callIndex: envelope.callIndex,
        toolName: envelope.toolName,
        toolArgs: this._guard.redaction.redactArgs(envelope.args) as Record<string, unknown>,
        sideEffect: envelope.sideEffect,
        environment: envelope.environment,
        principal: envelope.principal
          ? ({ ...envelope.principal } as Record<string, unknown>)
          : null,
        decisionSource: decision.decisionSource,
        decisionName: decision.decisionName,
        reason: decision.reason,
        hooksEvaluated: decision.hooksEvaluated,
        contractsEvaluated: decision.contractsEvaluated,
        sessionAttemptCount: await this._session.attemptCount(),
        sessionExecutionCount: await this._session.executionCount(),
        mode: this._guard.mode,
        policyVersion: this._guard.policyVersion,
        policyError: decision.policyError,
      }),
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
