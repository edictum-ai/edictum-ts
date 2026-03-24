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
import type { Principal, ToolEnvelope } from './envelope.js'
import type { PreDecision } from './pipeline.js'
import type { Session } from './session.js'

import { ApprovalStatus } from './approval.js'
import { AuditAction as AA, createAuditEvent } from './audit.js'
import { createEnvelope } from './envelope.js'
import { EdictumDenied, EdictumToolError } from './errors.js'
import { GovernancePipeline } from './pipeline.js'
import { Session as SessionClass } from './session.js'

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
  envelope: Readonly<ToolEnvelope>,
  session: Session,
  action: AuditAction,
  pre: PreDecision,
): Promise<void> {
  const event = createAuditEvent({
    action,
    runId: envelope.runId,
    callId: envelope.callId,
    toolName: envelope.toolName,
    toolArgs: guard.redaction.redactArgs(envelope.args) as Record<string, unknown>,
    sideEffect: envelope.sideEffect,
    environment: envelope.environment,
    principal: envelope.principal ? ({ ...envelope.principal } as Record<string, unknown>) : null,
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
 * Creates session, pipeline, envelope. Runs pre-execute governance,
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
  const pipeline = new GovernancePipeline(guard)

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

  const envelope = createEnvelope(toolName, args, {
    runId: sessionId,
    environment: env,
    registry: guard.toolRegistry,
    principal: principal ?? null,
  })

  // Increment attempts
  await session.incrementAttempts()

  // TODO: Phase 3 — start OTel span
  // const span = guard.telemetry.startToolSpan(envelope);

  try {
    // TODO: Phase 3 — set policy version on span
    // if (guard.policyVersion) {
    //   span.setAttribute("edictum.policy_version", guard.policyVersion);
    // }

    // Pre-execute
    const pre = await pipeline.preExecute(envelope, session)

    // Handle pending_approval: request approval from backend
    if (pre.action === 'pending_approval') {
      if (guard._approvalBackend == null) {
        // TODO: Phase 3 — span.setError(...)
        throw new EdictumDenied(
          `Approval required but no approval backend configured: ${pre.reason}`,
          pre.decisionSource,
          pre.decisionName,
        )
      }

      const principalDict = envelope.principal
        ? ({ ...envelope.principal } as Record<string, unknown>)
        : null

      const approvalRequest = await guard._approvalBackend.requestApproval(
        envelope.toolName,
        envelope.args as Record<string, unknown>,
        pre.approvalMessage ?? pre.reason ?? '',
        {
          timeout: pre.approvalTimeout,
          timeoutEffect: pre.approvalTimeoutEffect,
          principal: principalDict,
        },
      )

      await _emitRunPreAudit(guard, envelope, session, AA.CALL_APPROVAL_REQUESTED, pre)

      const decision = await guard._approvalBackend.waitForDecision(
        approvalRequest.approvalId,
        pre.approvalTimeout,
      )

      // Resolve approval: approved, denied, or timeout (with timeout_effect)
      let approved = false
      if (decision.status === ApprovalStatus.TIMEOUT) {
        await _emitRunPreAudit(guard, envelope, session, AA.CALL_APPROVAL_TIMEOUT, pre)
        if (pre.approvalTimeoutEffect === 'allow') {
          approved = true
        }
      } else if (!decision.approved) {
        await _emitRunPreAudit(guard, envelope, session, AA.CALL_APPROVAL_DENIED, pre)
      } else {
        approved = true
        await _emitRunPreAudit(guard, envelope, session, AA.CALL_APPROVAL_GRANTED, pre)
      }

      if (approved) {
        // TODO: Phase 3 — guard.telemetry.recordAllowed(envelope)
        if (guard._onAllow) {
          try {
            guard._onAllow(envelope)
          } catch {
            // on_allow callback raised — swallow
          }
        }
        // TODO: Phase 3 — span.setAttribute("governance.action", "approved")
        // Skip the normal pre-execution audit/callback logic below —
        // approval-granted path handles its own audit and callbacks.
      } else {
        const denyReason = decision.reason ?? pre.reason ?? ''
        // TODO: Phase 3 — guard.telemetry.recordDenial(envelope, denyReason)
        if (guard._onDeny) {
          try {
            guard._onDeny(envelope, denyReason, pre.decisionName)
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
    }

    // Determine if this is a real deny or just per-contract observed denials
    const realDeny = pre.action === 'deny' && !pre.observed

    // Skip pre-execution audit for approval-granted path (already handled above)
    if (pre.action === 'pending_approval') {
      // Fall through directly to tool execution
    } else if (realDeny) {
      const auditAction = guard.mode === 'observe' ? AA.CALL_WOULD_DENY : AA.CALL_DENIED
      await _emitRunPreAudit(guard, envelope, session, auditAction, pre)
      // TODO: Phase 3 — guard.telemetry.recordDenial(envelope, pre.reason)

      if (guard.mode === 'enforce') {
        if (guard._onDeny) {
          try {
            guard._onDeny(envelope, pre.reason ?? '', pre.decisionName)
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
      // Emit CALL_WOULD_DENY for any per-contract observed denials
      for (const cr of pre.contractsEvaluated) {
        if (cr['observed'] && !cr['passed']) {
          const observedEvent = createAuditEvent({
            action: AA.CALL_WOULD_DENY,
            runId: envelope.runId,
            callId: envelope.callId,
            toolName: envelope.toolName,
            toolArgs: guard.redaction.redactArgs(envelope.args) as Record<string, unknown>,
            sideEffect: envelope.sideEffect,
            environment: envelope.environment,
            principal: envelope.principal
              ? ({ ...envelope.principal } as Record<string, unknown>)
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

      await _emitRunPreAudit(guard, envelope, session, AA.CALL_ALLOWED, pre)
      // TODO: Phase 3 — guard.telemetry.recordAllowed(envelope)
      if (guard._onAllow) {
        try {
          guard._onAllow(envelope)
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
        runId: envelope.runId,
        callId: envelope.callId,
        toolName: envelope.toolName,
        toolArgs: guard.redaction.redactArgs(envelope.args) as Record<string, unknown>,
        sideEffect: envelope.sideEffect,
        environment: envelope.environment,
        principal: envelope.principal
          ? ({ ...envelope.principal } as Record<string, unknown>)
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
      // Use the frozen envelope.args snapshot — prevents TOCTOU between
      // governance evaluation and tool execution
      result = toolCallable(envelope.args as Record<string, unknown>)
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
    const post = await pipeline.postExecute(envelope, result, toolSuccess)
    await session.recordExecution(toolName, toolSuccess)

    // Emit post-execute audit
    const postAction = toolSuccess ? AA.CALL_EXECUTED : AA.CALL_FAILED
    const postEvent = createAuditEvent({
      action: postAction,
      runId: envelope.runId,
      callId: envelope.callId,
      toolName: envelope.toolName,
      toolArgs: guard.redaction.redactArgs(envelope.args) as Record<string, unknown>,
      sideEffect: envelope.sideEffect,
      environment: envelope.environment,
      principal: envelope.principal ? ({ ...envelope.principal } as Record<string, unknown>) : null,
      toolSuccess,
      postconditionsPassed: post.postconditionsPassed,
      contractsEvaluated: post.contractsEvaluated,
      sessionAttemptCount: await session.attemptCount(),
      sessionExecutionCount: await session.executionCount(),
      mode: guard.mode,
      policyVersion: guard.policyVersion,
      policyError: post.policyError,
    })
    await guard.auditSink.emit(postEvent)
    // TODO: Phase 3 — _emitOtelGovernanceSpan(guard, postEvent)

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
