/**
 * @edictum/claude-sdk -- Claude Agent SDK adapter for edictum.
 *
 * Translates Edictum pipeline decisions into Claude Agent SDK hook format.
 * The adapter does NOT contain governance logic -- that lives in CheckPipeline.
 *
 * Integration point: PreToolUse / PostToolUse / PostToolUseFailure hooks.
 *
 * Note: toSdkHooks() fully enforces preconditions. Postconditions run after
 * the tool, so they cannot undo side effects. Native hook output replacement
 * is not enforced: updatedToolOutput requires a schema-preserving replacement,
 * which Edictum cannot safely synthesize from its generic postcondition result.
 */

import { randomUUID } from 'node:crypto'

import type {
  CanUseTool,
  HookCallback as SDKHookCallback,
  HookCallbackMatcher,
  PostToolUseFailureHookInput as SDKPostToolUseFailureHookInput,
  PostToolUseFailureHookSpecificOutput,
  PostToolUseHookInput as SDKPostToolUseHookInput,
  PostToolUseHookSpecificOutput,
  PreToolUseHookInput as SDKPreToolUseHookInput,
  PreToolUseHookSpecificOutput,
} from '@anthropic-ai/claude-agent-sdk'

import {
  type AuditAction,
  AuditAction as AA,
  ApprovalStatus,
  createAuditEvent,
  createEnvelope,
  type Edictum,
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

export const VERSION = '0.3.0' as const
const MAX_WORKFLOW_APPROVAL_ROUNDS = 32

function permissionBoundaryDenial(): {
  behavior: 'deny'
  message: string
} {
  return {
    behavior: 'deny',
    message:
      'BLOCKED: Edictum rejected an unsafe or invalid SDK permission result; input and permission mutations are not supported after PreToolUse governance',
  }
}

const MAX_GOVERNED_INPUT_DEPTH = 64

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Deep-compare the tool args that will execute against the governed snapshot.
 * Throws on exotic or overly deep values so callers can fail closed.
 */
function governedInputEquals(left: unknown, right: unknown, depth = 0): boolean {
  if (depth > MAX_GOVERNED_INPUT_DEPTH) {
    throw new TypeError('BLOCKED: tool input exceeded compare depth')
  }
  if (Object.is(left, right)) {
    return true
  }
  if (left == null || right == null) {
    return false
  }

  const leftType = typeof left
  if (leftType !== typeof right) {
    return false
  }
  if (leftType !== 'object') {
    return false
  }

  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime()
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!governedInputEquals(left[i], right[i], depth + 1)) {
        return false
      }
    }
    return true
  }

  if (!isPlainObject(left) || !isPlainObject(right)) {
    throw new TypeError('BLOCKED: governed input compare requires plain JSON-like values')
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) {
    return false
  }
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) {
      return false
    }
    if (!governedInputEquals(leftRecord[key], rightRecord[key], depth + 1)) {
      return false
    }
  }
  return true
}

function pendingMatchesGovernedCall(
  pending: PendingCall,
  toolName: string,
  toolInput: unknown,
): boolean {
  return (
    pending.toolCall.toolName === toolName && governedInputEquals(pending.toolCall.args, toolInput)
  )
}

// ---------------------------------------------------------------------------
// Claude Agent SDK hook types
// ---------------------------------------------------------------------------

export type HookCallback = SDKHookCallback
export type HookMatcher = HookCallbackMatcher
export type PreToolUseInput = SDKPreToolUseHookInput
export type PostToolUseInput = SDKPostToolUseHookInput
export type PostToolUseFailureInput = SDKPostToolUseFailureHookInput
export type PreToolUseHookOutput = { hookSpecificOutput: PreToolUseHookSpecificOutput }
export type PostToolUseHookOutput = { hookSpecificOutput?: PostToolUseHookSpecificOutput }
export type PostToolUseFailureHookOutput = {
  hookSpecificOutput?: PostToolUseFailureHookSpecificOutput
}

// ---------------------------------------------------------------------------
// ClaudeAgentSDKAdapterOptions
// ---------------------------------------------------------------------------

export interface ClaudeAgentSDKAdapterOptions {
  readonly sessionId?: string
  readonly parentSessionId?: string
  readonly principal?: Principal
  readonly principalResolver?: (toolName: string, toolInput: Record<string, unknown>) => Principal
}

// ---------------------------------------------------------------------------
// ToSdkHooksOptions
// ---------------------------------------------------------------------------

export interface ToSdkHooksOptions {
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
// ClaudeAgentSDKAdapter
// ---------------------------------------------------------------------------

/**
 * Translate Edictum pipeline decisions into Claude Agent SDK hook format.
 *
 * The adapter does NOT contain governance logic -- that lives in
 * CheckPipeline. The adapter only:
 * 1. Creates envelopes from SDK hook data
 * 2. Manages pending state between PreToolUse and either post-tool exit event
 * 3. Translates PreDecision/PostDecision into hook behavior
 * 4. Handles observe mode (deny -> allow conversion)
 */
export class ClaudeAgentSDKAdapter {
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
  private _onPostconditionWarn: ((result: unknown, violations: Violation[]) => void) | null = null

  constructor(guard: Edictum, options?: ClaudeAgentSDKAdapterOptions) {
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
  // toSdkHooks
  // -----------------------------------------------------------------------

  /**
   * Returns hooks for Claude Agent SDK integration.
   *
   * Usage:
   * ```ts
   * const adapter = new ClaudeAgentSDKAdapter(guard);
   * const hooks = adapter.toSdkHooks();
   * // Pass hooks as options.hooks to the Claude Agent SDK.
   * ```
   *
   * Calling this method again replaces the postcondition warning callback for
   * every hook set returned by this adapter instance.
   */
  toSdkHooks(options?: ToSdkHooksOptions): {
    PreToolUse: HookCallbackMatcher[]
    PostToolUse: HookCallbackMatcher[]
    PostToolUseFailure: HookCallbackMatcher[]
  } {
    this._onPostconditionWarn = options?.onPostconditionWarn ?? null

    const preToolUse: SDKHookCallback = async (input, toolUseID) => {
      if (input.hook_event_name !== 'PreToolUse') {
        return {}
      }

      if (
        typeof input.tool_input !== 'object' ||
        input.tool_input == null ||
        Array.isArray(input.tool_input)
      ) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'BLOCKED: Claude Agent SDK supplied invalid tool input',
          },
        }
      }

      const callId = toolUseID ?? input.tool_use_id ?? randomUUID()
      const pending = this._pending.get(callId)
      if (pending !== undefined) {
        let inputMatches = false
        try {
          inputMatches = pendingMatchesGovernedCall(pending, input.tool_name, input.tool_input)
        } catch {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                'BLOCKED: Edictum could not compare tool input against the governed snapshot',
            },
          }
        }
        if (!inputMatches) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                'BLOCKED: Edictum rejected a tool input replacement after PreToolUse governance',
            },
          }
        }
        // Same governed input: do not re-run _pre or emit a permission decision.
        return {}
      }

      const result = await this._pre(
        input.tool_name,
        input.tool_input as Record<string, unknown>,
        callId,
      )

      if (result != null) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: result,
          },
        }
      }

      // _pre stored a deep copy. The SDK-owned tool_input can still change
      // while that await is in flight. Recheck the live object before {}.
      const stored = this._pending.get(callId)
      let inputStillMatches = false
      try {
        inputStillMatches =
          stored !== undefined &&
          pendingMatchesGovernedCall(stored, input.tool_name, input.tool_input)
      } catch {
        this._pending.delete(callId)
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'BLOCKED: Edictum could not compare tool input against the governed snapshot',
          },
        }
      }
      if (!inputStillMatches) {
        this._pending.delete(callId)
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'BLOCKED: Edictum rejected a tool input replacement after PreToolUse governance',
          },
        }
      }

      // Passing Edictum is not permission approval. Return no decision so the
      // SDK still applies allowedTools, canUseTool, and its normal prompt path.
      return {}
    }

    const finalizePending = async (
      toolUseID: string | undefined,
      inputToolUseID: string,
      toolResponse: unknown,
      forcedToolSuccess?: boolean,
    ): Promise<PostCallResult | null> => {
      const callId = toolUseID ?? inputToolUseID
      if (!callId || !this._pending.has(callId)) {
        return null
      }
      return this._post(callId, toolResponse, forcedToolSuccess)
    }

    const postContext = (postResult: PostCallResult, toolResponse: unknown): string | null => {
      const outputChanged = postResult.outputSuppressed || postResult.result !== toolResponse
      if (postResult.violations.length > 0 || outputChanged) {
        const violations = postResult.violations.map((violation) => violation.message)
        if (outputChanged) {
          violations.push(
            'Edictum did not replace tool output: Claude Agent SDK updatedToolOutput requires a schema-preserving replacement that the generic adapter cannot synthesize',
          )
        }
        return violations.join('\n')
      }
      return null
    }

    const postToolUse: SDKHookCallback = async (input, toolUseID) => {
      if (input.hook_event_name !== 'PostToolUse') {
        return {}
      }

      const postResult = await finalizePending(toolUseID, input.tool_use_id, input.tool_response)
      if (!postResult) {
        return {}
      }

      const additionalContext = postContext(postResult, input.tool_response)
      if (additionalContext) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext,
          },
        }
      }

      return {}
    }

    const postToolUseFailure: SDKHookCallback = async (input, toolUseID) => {
      if (input.hook_event_name !== 'PostToolUseFailure') {
        return {}
      }

      const failureResponse = {
        is_error: true,
        error: input.error,
        is_interrupt: input.is_interrupt === true,
      }
      const postResult = await finalizePending(toolUseID, input.tool_use_id, failureResponse, false)
      if (!postResult) {
        return {}
      }

      const additionalContext = postContext(postResult, failureResponse)
      return additionalContext
        ? { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext } }
        : {}
    }

    return {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ hooks: [postToolUse] }],
      PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
    }
  }

  /**
   * Wrap an SDK permission callback so it cannot mutate arguments or permissions
   * after PreToolUse governance. If the tool input reaching this wrapper differs
   * from the pending governed args for that toolUseID, the call is blocked.
   * The same check runs again after the permission callback returns, so a
   * mutation of the SDK-owned input during the await cannot sneak through.
   * Accepted decisions are copied into fresh plain objects. Null is preserved
   * for documented out-of-band responses. Throws and malformed results fail
   * closed with a fixed block.
   */
  wrapCanUseTool(callback: CanUseTool): CanUseTool {
    return async (toolName, input, options) => {
      try {
        const pending = this._pending.get(options.toolUseID)
        if (pending !== undefined) {
          const inputMatches = pendingMatchesGovernedCall(pending, toolName, input)
          if (!inputMatches) {
            return permissionBoundaryDenial()
          }
        }

        // The SDK-owned input may execute after this callback returns. Give the
        // callback a detached copy so in-place mutation cannot change the
        // already-governed arguments without using updatedInput (rejected below).
        const isolatedInput = structuredClone(input)
        const result: unknown = await callback(toolName, isolatedInput, options)
        // Neighbor hooks can mutate the SDK-owned input while the callback
        // is awaited. Re-check the object that will execute.
        if (pending !== undefined) {
          const inputStillMatches = pendingMatchesGovernedCall(pending, toolName, input)
          if (!inputStillMatches) {
            return permissionBoundaryDenial()
          }
        }
        if (result === null) {
          return null
        }
        if (typeof result !== 'object') {
          return permissionBoundaryDenial()
        }

        const permissionResult = result as Record<string, unknown>
        const decisionClassification = permissionResult['decisionClassification']
        if (
          decisionClassification !== undefined &&
          decisionClassification !== 'user_temporary' &&
          decisionClassification !== 'user_permanent' &&
          decisionClassification !== 'user_reject'
        ) {
          return permissionBoundaryDenial()
        }

        const behavior = permissionResult['behavior']
        if (behavior === 'allow') {
          if (
            'updatedInput' in permissionResult ||
            'updatedPermissions' in permissionResult ||
            decisionClassification === 'user_reject'
          ) {
            return permissionBoundaryDenial()
          }
          return decisionClassification === undefined
            ? { behavior: 'allow' }
            : { behavior: 'allow', decisionClassification }
        }
        if (behavior === 'deny') {
          const message = permissionResult['message']
          if (typeof message !== 'string') {
            return permissionBoundaryDenial()
          }
          const interrupt = permissionResult['interrupt']
          if (interrupt !== undefined && typeof interrupt !== 'boolean') {
            return permissionBoundaryDenial()
          }
          // Construct from an explicit allowlist. In particular, do not
          // forward updatedPermissions or any callback-owned prototype/Proxy.
          return {
            behavior: 'deny',
            message,
            ...(interrupt === undefined ? {} : { interrupt }),
            ...(decisionClassification === undefined ? {} : { decisionClassification }),
          }
        }
        return permissionBoundaryDenial()
      } catch {
        return permissionBoundaryDenial()
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
      await this._emitAuditPre(toolCall, decision, AA.CALL_WOULD_DENY)
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
              action: AA.CALL_WOULD_DENY,
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
        const observeAction = sr['passed'] ? AA.CALL_ALLOWED : AA.CALL_WOULD_DENY
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
   * Finalization is at-most-once: pending state is consumed before calling
   * postconditions, workflow storage, session storage, or the audit sink. Those
   * ports do not share a transaction or idempotency key, so retrying after a
   * partial failure could duplicate durable state. A thrown finalization error
   * is propagated and is not retried by this adapter.
   *
   * Exposed for direct testing without framework imports.
   */
  async _post(
    callId: string,
    toolResponse: unknown = undefined,
    forcedToolSuccess?: boolean,
  ): Promise<PostCallResult> {
    const pending = this._pending.get(callId)
    this._pending.delete(callId)

    if (!pending) {
      return createPostCallResult({ result: toolResponse })
    }

    const { toolCall, workflowStageId, workflowInvolved } = pending

    // An SDK failure event is authoritative; otherwise derive success from the configured check.
    const toolSuccess = forcedToolSuccess ?? this._checkToolSuccess(toolCall.toolName, toolResponse)

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
        // on_postcondition_warn callback raised -- swallow
      }
    }

    return postResult
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
