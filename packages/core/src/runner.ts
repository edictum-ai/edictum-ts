/**
 * Execution logic for Edictum.run() -- governance pipeline with tool execution.
 *
 * Ports Python's _runner.py. Governance pipeline + tool callable execution.
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's _runner.py
 * (350 LOC). The full run() flow (pre-execute → approval → execute → post-execute
 * → audit) is a single cohesive transaction that would be harder to follow if split.
 */

import type { Edictum } from './guard.js'
import type { AuditAction } from './audit.js'
import type { Principal, ToolCall } from './tool-call.js'
import type { PreDecision } from './pipeline.js'
import type { Session } from './session.js'

import { ApprovalStatus } from './approval.js'
import { AuditAction as AA, createAuditEvent } from './audit.js'
import { createEnvelope } from './tool-call.js'
import { EdictumDenied, EdictumToolError } from './errors.js'
import { CheckPipeline } from './pipeline.js'
import { Session as SessionClass } from './session.js'

const MAX_WORKFLOW_APPROVAL_ROUNDS = 32

// ---------------------------------------------------------------------------
// _emitWorkflowEvents
// ---------------------------------------------------------------------------

/**
 * Emit audit events for workflow progress (stage advance, completion).
 *
 * Mirrors Python's _emit_workflow_events: iterates over event records
 * produced by workflow evaluation or recordResult, and emits a proper
 * AuditEvent for each with the correct action type.
 */
async function _emitWorkflowEvents(
  guard: Edictum,
  toolCall: Readonly<ToolCall>,
  events: Record<string, unknown>[],
): Promise<void> {
  for (const record of events) {
    const workflow = record['workflow']
    const actionName = record['action']
    if (typeof workflow !== 'object' || workflow == null || typeof actionName !== 'string') {
      continue
    }
    let action: AuditAction = AA.WORKFLOW_STAGE_ADVANCED
    if (actionName === AA.WORKFLOW_COMPLETED) {
      action = AA.WORKFLOW_COMPLETED
    } else if (actionName === AA.WORKFLOW_STATE_UPDATED) {
      action = AA.WORKFLOW_STATE_UPDATED
    }
    const event = createAuditEvent({
      action,
      runId: toolCall.runId,
      callId: toolCall.callId,
      toolName: toolCall.toolName,
      toolArgs: guard.redaction.redactArgs(toolCall.args) as Record<string, unknown>,
      sideEffect: toolCall.sideEffect,
      environment: toolCall.environment,
      principal: toolCall.principal ? ({ ...toolCall.principal } as Record<string, unknown>) : null,
      mode: guard.mode,
      policyVersion: guard.policyVersion,
      workflow: { ...(workflow as Record<string, unknown>) },
    })
    await guard.auditSink.emit(event)
    // TODO: Phase 3 — _emitOtelGovernanceSpan(guard, event)
  }
}

// ---------------------------------------------------------------------------
// defaultSuccessCheck
// ---------------------------------------------------------------------------

/**
 * Default heuristic for tool success detection.
 *
 * Matches the heuristic used by all framework adapters:
 * - null/undefined is success
 * - object with is_error truthy is failure
 * - string starting with "error:" or "fatal:" (case-insensitive) is failure
 * - everything else is success
 */
export function defaultSuccessCheck(_toolName: string, result: unknown): boolean {
  if (result == null) {
    return true
  }
  if (typeof result === 'object' && !Array.isArray(result)) {
    const dict = result as Record<string, unknown>
    if (dict['is_error']) {
      return false
    }
  }
  if (typeof result === 'string') {
    const lower = result.slice(0, 7).toLowerCase()
    if (lower.startsWith('error:') || lower.startsWith('fatal:')) {
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// RunOptions
// ---------------------------------------------------------------------------

/** Options for the run() function beyond the required positional args. */
export interface RunOptions {
  readonly sessionId?: string
  readonly environment?: string
  readonly principal?: Principal
}

// ---------------------------------------------------------------------------
// _emitRunPreAudit
// ---------------------------------------------------------------------------

async function _emitRunPreAudit(
  guard: Edictum,
  toolCall: Readonly<ToolCall>,
  session: Session,
  action: AuditAction,
  pre: PreDecision,
): Promise<void> {
  const event = createAuditEvent({
    action,
    runId: toolCall.runId,
    callId: toolCall.callId,
    toolName: toolCall.toolName,
    toolArgs: guard.redaction.redactArgs(toolCall.args) as Record<string, unknown>,
    sideEffect: toolCall.sideEffect,
    environment: toolCall.environment,
    principal: toolCall.principal ? ({ ...toolCall.principal } as Record<string, unknown>) : null,
    decisionSource: pre.decisionSource,
    decisionName: pre.decisionName,
    reason: pre.reason,
    hooksEvaluated: pre.hooksEvaluated,
    contractsEvaluated: pre.contractsEvaluated,
    sessionAttemptCount: await session.attemptCount(),
    sessionExecutionCount: await session.executionCount(),
    mode: guard.mode,
    policyVersion: guard.policyVersion,
    policyError: pre.policyError,
  })
  await guard.auditSink.emit(event)
  // TODO: Phase 3 — _emitOtelGovernanceSpan(guard, event)
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic entrypoint for governed tool execution.
 *
 * Creates session, pipeline, toolCall. Runs pre-execute governance,
 * handles approval flow, executes the tool, runs post-execute governance,
 * emits audit events, and returns the (potentially redacted) result.
 */
export async function run(
  guard: Edictum,
  toolName: string,
  args: Record<string, unknown>,
  toolCallable: (args: Record<string, unknown>) => unknown | Promise<unknown>,
  options?: RunOptions,
): Promise<unknown> {
  const sessionId = options?.sessionId ?? guard.sessionId
  const session = new SessionClass(sessionId, guard.backend)
  const pipeline = new CheckPipeline(guard)

  // Allow per-call environment override; fall back to guard-level default
  const env = options?.environment ?? guard.environment

  // Resolve principal: per-call resolver > static > options
  let principal = options?.principal ?? undefined
  if (principal === undefined) {
    const resolved = guard._resolvePrincipal(toolName, args)
    if (resolved != null) {
      principal = resolved
    }
  }

  const toolCall = createEnvelope(toolName, args, {
    runId: sessionId,
    environment: env,
    registry: guard.toolRegistry,
    principal: principal ?? null,
  })

  // Increment attempts
  await session.incrementAttempts()

  // TODO: Phase 3 — start OTel span
  // const span = guard.telemetry.startToolSpan(toolCall);

  try {
    // TODO: Phase 3 — set policy version on span
    // if (guard.policyVersion) {
    //   span.setAttribute("edictum.policy_version", guard.policyVersion);
    // }

    // Pre-execute
    let pre = await pipeline.preExecute(toolCall, session)
    await _emitWorkflowEvents(guard, toolCall, pre.workflowEvents)
    let skipStandardPreAudit = false

    // Handle pending_approval: request approval from backend
    for (let approvalRound = 0; pre.action === 'pending_approval'; approvalRound += 1) {
      if (guard._approvalBackend == null) {
        // TODO: Phase 3 — span.setError(...)
        throw new EdictumDenied(
          `Approval required but no approval backend configured: ${pre.reason}`,
          pre.decisionSource,
          pre.decisionName,
        )
      }

      const principalDict = toolCall.principal
        ? ({ ...toolCall.principal } as Record<string, unknown>)
        : null

      const approvalRequest = await guard._approvalBackend.requestApproval(
        toolCall.toolName,
        toolCall.args as Record<string, unknown>,
        pre.approvalMessage ?? pre.reason ?? '',
        {
          timeout: pre.approvalTimeout,
          timeoutEffect: pre.approvalTimeoutEffect,
          principal: principalDict,
        },
      )

      await _emitRunPreAudit(guard, toolCall, session, AA.CALL_APPROVAL_REQUESTED, pre)

      const decision = await guard._approvalBackend.waitForDecision(
        approvalRequest.approvalId,
        pre.approvalTimeout,
      )

      // Resolve approval: approved, denied, or timeout (with timeout_effect)
      let approved = false
      if (decision.status === ApprovalStatus.TIMEOUT) {
        await _emitRunPreAudit(guard, toolCall, session, AA.CALL_APPROVAL_TIMEOUT, pre)
        if (pre.approvalTimeoutEffect === 'allow') {
          approved = true
        }
      } else if (!decision.approved) {
        await _emitRunPreAudit(guard, toolCall, session, AA.CALL_APPROVAL_DENIED, pre)
      } else {
        approved = true
        await _emitRunPreAudit(guard, toolCall, session, AA.CALL_APPROVAL_GRANTED, pre)
      }

      if (!approved) {
        const denyReason = decision.reason ?? pre.reason ?? ''
        // TODO: Phase 3 — guard.telemetry.recordDenial(toolCall, denyReason)
        if (guard._onDeny) {
          try {
            guard._onDeny(toolCall, denyReason, pre.decisionName)
          } catch {
            // on_deny callback raised — swallow
          }
        }
        // TODO: Phase 3 — span error attributes
        throw new EdictumDenied(
          decision.reason ?? pre.reason ?? 'denied',
          pre.decisionSource,
          pre.decisionName,
        )
      }

      if (
        pre.decisionSource === 'workflow' &&
        pre.workflowStageId != null &&
        pre.workflowStageId !== ''
      ) {
        const workflowRuntime = guard.getWorkflowRuntime()
        if (workflowRuntime == null) {
          throw new Error(
            `workflow approval requested for ${JSON.stringify(pre.workflowStageId)} but no workflow runtime configured`,
          )
        }
        if (approvalRound >= MAX_WORKFLOW_APPROVAL_ROUNDS) {
          throw new Error(
            `workflow: exceeded maximum approval rounds (${MAX_WORKFLOW_APPROVAL_ROUNDS})`,
          )
        }
        await workflowRuntime.recordApproval(session, pre.workflowStageId)
        pre = await pipeline.preExecute(toolCall, session)
        await _emitWorkflowEvents(guard, toolCall, pre.workflowEvents)
        continue
      }

      // TODO: Phase 3 — guard.telemetry.recordAllowed(toolCall)
      if (guard._onAllow) {
        try {
          guard._onAllow(toolCall)
        } catch {
          // on_allow callback raised — swallow
        }
      }
      // TODO: Phase 3 — span.setAttribute("governance.action", "approved")
      skipStandardPreAudit = true
      break
    }

    // Determine if this is a real deny or just per-rule observed denials
    const realDeny = pre.action === 'deny' && !pre.observed

    // Skip pre-execution audit for approval-granted path (already handled above)
    if (skipStandardPreAudit) {
      // Fall through directly to tool execution
    } else if (realDeny) {
      const auditAction = guard.mode === 'observe' ? AA.CALL_WOULD_DENY : AA.CALL_DENIED
      await _emitRunPreAudit(guard, toolCall, session, auditAction, pre)
      // TODO: Phase 3 — guard.telemetry.recordDenial(toolCall, pre.reason)

      if (guard.mode === 'enforce') {
        if (guard._onDeny) {
          try {
            guard._onDeny(toolCall, pre.reason ?? '', pre.decisionName)
          } catch {
            // on_deny callback raised — swallow
          }
        }
        // TODO: Phase 3 — span error attributes
        throw new EdictumDenied(pre.reason ?? 'denied', pre.decisionSource, pre.decisionName)
      }
      // observe mode: fall through to execute
      // TODO: Phase 3 — span.setAttribute("governance.action", "would_deny")
    } else {
      // Emit CALL_WOULD_DENY for any per-rule observed denials
      for (const cr of pre.contractsEvaluated) {
        if (cr['observed'] && !cr['passed']) {
          const observedEvent = createAuditEvent({
            action: AA.CALL_WOULD_DENY,
            runId: toolCall.runId,
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            toolArgs: guard.redaction.redactArgs(toolCall.args) as Record<string, unknown>,
            sideEffect: toolCall.sideEffect,
            environment: toolCall.environment,
            principal: toolCall.principal
              ? ({ ...toolCall.principal } as Record<string, unknown>)
              : null,
            decisionSource: 'precondition',
            decisionName: cr['name'] as string,
            reason: cr['message'] as string | null,
            mode: 'observe',
            policyVersion: guard.policyVersion,
            policyError: pre.policyError,
          })
          await guard.auditSink.emit(observedEvent)
          // TODO: Phase 3 — _emitOtelGovernanceSpan(guard, observedEvent)
        }
      }

      await _emitRunPreAudit(guard, toolCall, session, AA.CALL_ALLOWED, pre)
      // TODO: Phase 3 — guard.telemetry.recordAllowed(toolCall)
      if (guard._onAllow) {
        try {
          guard._onAllow(toolCall)
        } catch {
          // on_allow callback raised — swallow
        }
      }
      // TODO: Phase 3 — span.setAttribute("governance.action", "allowed")
    }

    // Emit observe-mode audit events (never affect the real decision)
    for (const sr of pre.observeResults) {
      const observeAction = sr['passed'] ? AA.CALL_ALLOWED : AA.CALL_WOULD_DENY
      const observeEvent = createAuditEvent({
        action: observeAction,
        runId: toolCall.runId,
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        toolArgs: guard.redaction.redactArgs(toolCall.args) as Record<string, unknown>,
        sideEffect: toolCall.sideEffect,
        environment: toolCall.environment,
        principal: toolCall.principal
          ? ({ ...toolCall.principal } as Record<string, unknown>)
          : null,
        decisionSource: sr['source'] as string | null,
        decisionName: sr['name'] as string | null,
        reason: sr['message'] as string | null,
        mode: 'observe',
        policyVersion: guard.policyVersion,
      })
      await guard.auditSink.emit(observeEvent)
      // TODO: Phase 3 — _emitOtelGovernanceSpan(guard, observeEvent)
    }

    // Execute tool
    let result: unknown
    let toolSuccess: boolean
    try {
      // Use the frozen toolCall.args snapshot — prevents TOCTOU between
      // governance evaluation and tool execution
      result = toolCallable(toolCall.args as Record<string, unknown>)
      // Await if the callable returns a promise
      if (
        result != null &&
        typeof result === 'object' &&
        typeof (result as Promise<unknown>).then === 'function'
      ) {
        result = await (result as Promise<unknown>)
      }
      if (guard._successCheck) {
        toolSuccess = guard._successCheck(toolName, result)
      } else {
        toolSuccess = defaultSuccessCheck(toolName, result)
      }
    } catch (e: unknown) {
      result = String(e)
      toolSuccess = false
    }

    // Post-execute
    const post = await pipeline.postExecute(toolCall, result, toolSuccess)
    let postWorkflowEvents: Record<string, unknown>[] = []
    if (toolSuccess && pre.workflowInvolved && pre.workflowStageId != null) {
      const workflowRuntime = guard.getWorkflowRuntime()
      if (workflowRuntime != null) {
        postWorkflowEvents = await workflowRuntime.recordResult(
          session,
          pre.workflowStageId,
          toolCall,
        )
      }
    }
    await session.recordExecution(toolName, toolSuccess)

    // Emit post-execute audit
    const postAction = toolSuccess ? AA.CALL_EXECUTED : AA.CALL_FAILED
    const postEvent = createAuditEvent({
      action: postAction,
      runId: toolCall.runId,
      callId: toolCall.callId,
      toolName: toolCall.toolName,
      toolArgs: guard.redaction.redactArgs(toolCall.args) as Record<string, unknown>,
      sideEffect: toolCall.sideEffect,
      environment: toolCall.environment,
      principal: toolCall.principal ? ({ ...toolCall.principal } as Record<string, unknown>) : null,
      toolSuccess,
      postconditionsPassed: post.postconditionsPassed,
      contractsEvaluated: post.contractsEvaluated,
      sessionAttemptCount: await session.attemptCount(),
      sessionExecutionCount: await session.executionCount(),
      mode: guard.mode,
      policyVersion: guard.policyVersion,
      policyError: post.policyError,
      workflow: pre.workflow,
    })
    await guard.auditSink.emit(postEvent)
    // TODO: Phase 3 — _emitOtelGovernanceSpan(guard, postEvent)
    await _emitWorkflowEvents(guard, toolCall, postWorkflowEvents)

    // TODO: Phase 3 — span tool_success / postconditions_passed attributes
    // TODO: Phase 3 — span OK/error status

    if (!toolSuccess) {
      throw new EdictumToolError(String(result))
    }

    return post.redactedResponse != null ? post.redactedResponse : result
  } finally {
    // TODO: Phase 3 — span.end()
  }
}
