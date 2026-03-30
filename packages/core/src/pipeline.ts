/**
 * CheckPipeline -- single source of governance logic.
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's pipeline.py
 * (485 LOC). PreDecision + PostDecision types + the 5-stage pre/post engine
 * form a single cohesive evaluation flow that would be harder to follow if split.
 */

import { Decision } from './rules.js'
import { SideEffect } from './tool-call.js'
import type { ToolCall } from './tool-call.js'
import { HookDecision, HookResult } from './hooks.js'
import { RedactionPolicy } from './redaction.js'
import type { Session } from './session.js'
import type { GuardLike } from './internal-rules.js'
import { WorkflowAction } from './workflow/index.js'

// ---------------------------------------------------------------------------
// PreDecision
// ---------------------------------------------------------------------------

/** Result of pre-execution governance evaluation. */
export interface PreDecision {
  readonly action: 'allow' | 'deny' | 'pending_approval'
  readonly reason: string | null
  readonly decisionSource: string | null
  readonly decisionName: string | null
  readonly hooksEvaluated: Record<string, unknown>[]
  readonly contractsEvaluated: Record<string, unknown>[]
  readonly observed: boolean
  readonly policyError: boolean
  readonly observeResults: Record<string, unknown>[]
  readonly approvalTimeout: number
  readonly approvalTimeoutEffect: string
  readonly approvalMessage: string | null
  readonly workflowStageId: string | null
  readonly workflowInvolved: boolean
}

/** Create a PreDecision with defaults for omitted fields. */
export function createPreDecision(
  partial: Partial<PreDecision> & Pick<PreDecision, 'action'>,
): PreDecision {
  return {
    action: partial.action,
    reason: partial.reason ?? null,
    decisionSource: partial.decisionSource ?? null,
    decisionName: partial.decisionName ?? null,
    hooksEvaluated: partial.hooksEvaluated ?? [],
    contractsEvaluated: partial.contractsEvaluated ?? [],
    observed: partial.observed ?? false,
    policyError: partial.policyError ?? false,
    observeResults: partial.observeResults ?? [],
    approvalTimeout: partial.approvalTimeout ?? 300,
    approvalTimeoutEffect: partial.approvalTimeoutEffect ?? 'deny',
    approvalMessage: partial.approvalMessage ?? null,
    workflowStageId: partial.workflowStageId ?? null,
    workflowInvolved: partial.workflowInvolved ?? false,
  }
}

// ---------------------------------------------------------------------------
// PostDecision
// ---------------------------------------------------------------------------

/** Result of post-execution governance evaluation. */
export interface PostDecision {
  readonly toolSuccess: boolean
  readonly postconditionsPassed: boolean
  readonly warnings: string[]
  readonly contractsEvaluated: Record<string, unknown>[]
  readonly policyError: boolean
  readonly redactedResponse: unknown
  readonly outputSuppressed: boolean
}

/** Create a PostDecision with defaults for omitted fields. */
export function createPostDecision(
  partial: Partial<PostDecision> & Pick<PostDecision, 'toolSuccess'>,
): PostDecision {
  return {
    toolSuccess: partial.toolSuccess,
    postconditionsPassed: partial.postconditionsPassed ?? true,
    warnings: partial.warnings ?? [],
    contractsEvaluated: partial.contractsEvaluated ?? [],
    policyError: partial.policyError ?? false,
    redactedResponse: partial.redactedResponse ?? null,
    outputSuppressed: partial.outputSuppressed ?? false,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if any evaluated rule record has a policy_error in metadata. */
function hasPolicyError(contractsEvaluated: Record<string, unknown>[]): boolean {
  return contractsEvaluated.some((c) => {
    const meta = c['metadata'] as Record<string, unknown> | undefined
    return meta?.['policy_error'] === true
  })
}

// ---------------------------------------------------------------------------
// CheckPipeline
// ---------------------------------------------------------------------------

/**
 * Orchestrates all governance checks.
 *
 * This is the single source of truth for governance logic.
 * Adapters call preExecute() and postExecute(), then translate
 * the structured results into framework-specific formats.
 */
export class CheckPipeline {
  private readonly _guard: GuardLike

  constructor(guard: GuardLike) {
    this._guard = guard
  }

  async preExecute(toolCall: ToolCall, session: Session): Promise<PreDecision> {
    const hooksEvaluated: Record<string, unknown>[] = []
    const contractsEvaluated: Record<string, unknown>[] = []
    let hasObservedDeny = false

    // Pre-fetch session counters in a single batch to reduce HTTP
    // round trips when using ServerBackend.  The tool-specific key
    // is included only when a per-tool limit is configured.
    let toolNameForBatch: string | undefined
    if (toolCall.toolName in this._guard.limits.maxCallsPerTool) {
      toolNameForBatch = toolCall.toolName
    }
    const counters = await session.batchGetCounters({
      includeTool: toolNameForBatch,
    })

    // 1. Attempt limit
    const attemptCount = counters['attempts'] ?? 0
    if (attemptCount >= this._guard.limits.maxAttempts) {
      return createPreDecision({
        action: 'deny',
        reason:
          `Attempt limit reached (${this._guard.limits.maxAttempts}). ` +
          'Agent may be stuck in a retry loop. Stop and reassess.',
        decisionSource: 'attempt_limit',
        decisionName: 'max_attempts',
        hooksEvaluated,
        contractsEvaluated,
      })
    }

    // 2. Before hooks (catch exceptions)
    for (const hookReg of this._guard.getHooks('before', toolCall)) {
      if (hookReg.when && !hookReg.when(toolCall)) {
        continue
      }
      let decision: HookDecision
      try {
        decision = await hookReg.callback(toolCall)
      } catch (exc) {
        decision = HookDecision.deny(`Hook error: ${exc}`)
      }

      const hookRecord: Record<string, unknown> = {
        name: hookReg.callback.name || 'anonymous',
        result: decision.result,
        reason: decision.reason,
      }
      hooksEvaluated.push(hookRecord)

      if (decision.result === HookResult.DENY) {
        return createPreDecision({
          action: 'deny',
          reason: decision.reason,
          decisionSource: 'hook',
          decisionName: hookRecord['name'] as string,
          hooksEvaluated,
          contractsEvaluated,
          policyError: (decision.reason ?? '').includes('Hook error:'),
        })
      }
    }

    // 3. Preconditions (catch exceptions)
    for (const rule of this._guard.getPreconditions(toolCall)) {
      let decision: Decision
      try {
        decision = await rule.check(toolCall)
      } catch (exc) {
        decision = Decision.fail(`Precondition error: ${exc}`, {
          policy_error: true,
        })
      }

      const contractRecord: Record<string, unknown> = {
        name: rule.name,
        type: 'precondition',
        passed: decision.passed,
        message: decision.message,
      }
      if (decision.metadata && Object.keys(decision.metadata).length > 0) {
        contractRecord['metadata'] = decision.metadata
      }
      contractsEvaluated.push(contractRecord)

      if (!decision.passed) {
        // Per-rule observe mode: record but don't deny
        if (rule.mode === 'observe') {
          contractRecord['observed'] = true
          hasObservedDeny = true
          continue
        }

        const source = rule.source ?? 'precondition'
        const pe = hasPolicyError(contractsEvaluated)

        const effect = rule.effect ?? 'deny'
        if (effect === 'approve') {
          return createPreDecision({
            action: 'pending_approval',
            reason: decision.message,
            decisionSource: source,
            decisionName: rule.name,
            hooksEvaluated,
            contractsEvaluated,
            policyError: pe,
            approvalTimeout: rule.timeout ?? 300,
            approvalTimeoutEffect: rule.timeoutEffect ?? 'deny',
            approvalMessage: decision.message,
          })
        }

        return createPreDecision({
          action: 'deny',
          reason: decision.message,
          decisionSource: source,
          decisionName: rule.name,
          hooksEvaluated,
          contractsEvaluated,
          policyError: pe,
        })
      }
    }

    // 3.5. Sandbox rules
    for (const rule of this._guard.getSandboxContracts(toolCall)) {
      let decision: Decision
      try {
        decision = await rule.check(toolCall)
      } catch (exc) {
        decision = Decision.fail(`Sandbox rule error: ${exc}`, {
          policy_error: true,
        })
      }

      const contractRecord: Record<string, unknown> = {
        name: rule.name,
        type: 'sandbox',
        passed: decision.passed,
        message: decision.message,
      }
      if (decision.metadata && Object.keys(decision.metadata).length > 0) {
        contractRecord['metadata'] = decision.metadata
      }
      contractsEvaluated.push(contractRecord)

      if (!decision.passed) {
        if (rule.mode === 'observe') {
          contractRecord['observed'] = true
          hasObservedDeny = true
          continue
        }

        const source = rule.source ?? 'yaml_sandbox'
        const pe = hasPolicyError(contractsEvaluated)

        const effect = rule.effect ?? 'deny'
        if (effect === 'approve') {
          return createPreDecision({
            action: 'pending_approval',
            reason: decision.message,
            decisionSource: source,
            decisionName: rule.name,
            hooksEvaluated,
            contractsEvaluated,
            policyError: pe,
            approvalTimeout: rule.timeout ?? 300,
            approvalTimeoutEffect: rule.timeoutEffect ?? 'deny',
            approvalMessage: decision.message,
          })
        }

        return createPreDecision({
          action: 'deny',
          reason: decision.message,
          decisionSource: source,
          decisionName: rule.name,
          hooksEvaluated,
          contractsEvaluated,
          policyError: pe,
        })
      }
    }

    // 4. Session rules (catch exceptions)
    for (const rule of this._guard.getSessionContracts()) {
      let decision: Decision
      try {
        decision = await rule.check(session)
      } catch (exc) {
        decision = Decision.fail(`Session rule error: ${exc}`, {
          policy_error: true,
        })
      }

      const contractRecord: Record<string, unknown> = {
        name: rule.name,
        type: 'session_contract',
        passed: decision.passed,
        message: decision.message,
      }
      if (decision.metadata && Object.keys(decision.metadata).length > 0) {
        contractRecord['metadata'] = decision.metadata
      }
      contractsEvaluated.push(contractRecord)

      if (!decision.passed) {
        const source = rule.source ?? 'session_contract'
        const pe = hasPolicyError(contractsEvaluated)
        return createPreDecision({
          action: 'deny',
          reason: decision.message,
          decisionSource: source,
          decisionName: rule.name,
          hooksEvaluated,
          contractsEvaluated,
          policyError: pe,
        })
      }
    }

    // 5. Workflow gates
    let workflowStageId: string | null = null
    let workflowInvolved = false
    const workflowRuntime = this._guard.getWorkflowRuntime()
    if (workflowRuntime != null) {
      try {
        const wf = await workflowRuntime.evaluate(session, toolCall)
        if (wf.records.length > 0) {
          contractsEvaluated.push(...wf.records)
        }
        workflowStageId = wf.stageId || null
        workflowInvolved = wf.records.length > 0 || wf.stageId !== ''

        if (wf.action === WorkflowAction.BLOCK) {
          return createPreDecision({
            action: 'deny',
            reason: wf.reason,
            decisionSource: 'workflow',
            decisionName: wf.stageId || 'workflow',
            hooksEvaluated,
            contractsEvaluated,
            policyError: hasPolicyError(contractsEvaluated),
            workflowStageId,
            workflowInvolved,
          })
        }

        if (wf.action === WorkflowAction.PENDING_APPROVAL) {
          return createPreDecision({
            action: 'pending_approval',
            reason: wf.reason,
            decisionSource: 'workflow',
            decisionName: wf.stageId || 'workflow',
            hooksEvaluated,
            contractsEvaluated,
            policyError: hasPolicyError(contractsEvaluated),
            approvalMessage: wf.reason,
            workflowStageId,
            workflowInvolved,
          })
        }
      } catch (exc) {
        contractsEvaluated.push({
          name: 'workflow:error',
          type: 'workflow_gate',
          passed: false,
          message: `Workflow evaluation error: ${exc}`,
          metadata: { policy_error: true },
        })
        return createPreDecision({
          action: 'deny',
          reason: `Workflow evaluation error: ${exc}`,
          decisionSource: 'workflow',
          decisionName: 'workflow_error',
          hooksEvaluated,
          contractsEvaluated,
          policyError: true,
          workflowStageId,
          workflowInvolved: true,
        })
      }
    }

    // 6. Execution limits (use pre-fetched counters)
    const execCount = counters['execs'] ?? 0
    if (execCount >= this._guard.limits.maxToolCalls) {
      return createPreDecision({
        action: 'deny',
        reason:
          `Execution limit reached (${this._guard.limits.maxToolCalls} calls). ` +
          'Summarize progress and stop.',
        decisionSource: 'operation_limit',
        decisionName: 'max_tool_calls',
        hooksEvaluated,
        contractsEvaluated,
        workflowStageId,
        workflowInvolved,
      })
    }

    // Per-tool limits (use pre-fetched counter when available)
    if (toolCall.toolName in this._guard.limits.maxCallsPerTool) {
      const toolKey = `tool:${toolCall.toolName}`
      const toolCount = counters[toolKey] ?? 0
      const toolLimit = this._guard.limits.maxCallsPerTool[toolCall.toolName] ?? 0
      if (toolCount >= toolLimit) {
        return createPreDecision({
          action: 'deny',
          reason: `Per-tool limit: ${toolCall.toolName} called ${toolCount} times (limit: ${toolLimit}).`,
          decisionSource: 'operation_limit',
          decisionName: `max_calls_per_tool:${toolCall.toolName}`,
          hooksEvaluated,
          contractsEvaluated,
          workflowStageId,
          workflowInvolved,
        })
      }
    }

    // 7. All checks passed
    const pe = hasPolicyError(contractsEvaluated)

    // 8. Observe-mode rule evaluation (never affects the decision)
    const observeResults = await this._evaluateObserveContracts(toolCall, session)

    return createPreDecision({
      action: 'allow',
      hooksEvaluated,
      contractsEvaluated,
      observed: hasObservedDeny,
      policyError: pe,
      observeResults,
      workflowStageId,
      workflowInvolved,
    })
  }

  async postExecute(
    toolCall: ToolCall,
    toolResponse: unknown,
    toolSuccess: boolean,
  ): Promise<PostDecision> {
    const warnings: string[] = []
    const contractsEvaluated: Record<string, unknown>[] = []
    let redactedResponse: unknown = null
    let outputSuppressed = false

    // 1. Postconditions (catch exceptions)
    for (const rule of this._guard.getPostconditions(toolCall)) {
      let decision: Decision
      try {
        decision = await rule.check(toolCall, toolResponse)
      } catch (exc) {
        decision = Decision.fail(`Postcondition error: ${exc}`, {
          policy_error: true,
        })
      }

      const contractRecord: Record<string, unknown> = {
        name: rule.name,
        type: 'postcondition',
        passed: decision.passed,
        message: decision.message,
      }
      if (decision.metadata && Object.keys(decision.metadata).length > 0) {
        contractRecord['metadata'] = decision.metadata
      }
      contractsEvaluated.push(contractRecord)

      if (!decision.passed) {
        const effect = rule.effect ?? 'warn'
        const contractMode = rule.mode
        const isSafe =
          toolCall.sideEffect === SideEffect.PURE || toolCall.sideEffect === SideEffect.READ

        // Observe mode takes precedence
        if (contractMode === 'observe') {
          contractRecord['observed'] = true
          warnings.push(`\u26a0\ufe0f [observe] ${decision.message}`)
        } else if (effect === 'redact' && isSafe) {
          const patterns = rule.redactPatterns ?? []
          const source = redactedResponse !== null ? redactedResponse : toolResponse
          let text = source != null ? String(source) : ''
          if (patterns.length > 0) {
            for (const pat of patterns) {
              // Python re.sub() replaces ALL occurrences; ensure global flag
              const globalPat = pat.global ? pat : new RegExp(pat.source, pat.flags + 'g')
              text = text.replace(globalPat, '[REDACTED]')
            }
          } else {
            const policy = new RedactionPolicy()
            text = policy.redactResult(text, text.length + 100)
          }
          redactedResponse = text
          warnings.push(`\u26a0\ufe0f Content redacted by ${rule.name}.`)
        } else if (effect === 'deny' && isSafe) {
          redactedResponse = `[OUTPUT SUPPRESSED] ${decision.message}`
          outputSuppressed = true
          warnings.push(`\u26a0\ufe0f Output suppressed by ${rule.name}.`)
        } else if ((effect === 'redact' || effect === 'deny') && !isSafe) {
          warnings.push(
            `\u26a0\ufe0f ${decision.message} Tool already executed \u2014 assess before proceeding.`,
          )
        } else if (isSafe) {
          warnings.push(`\u26a0\ufe0f ${decision.message} Consider retrying.`)
        } else {
          warnings.push(
            `\u26a0\ufe0f ${decision.message} Tool already executed \u2014 assess before proceeding.`,
          )
        }
      }
    }

    // 2. After hooks (catch exceptions)
    for (const hookReg of this._guard.getHooks('after', toolCall)) {
      if (hookReg.when && !hookReg.when(toolCall)) {
        continue
      }
      try {
        await hookReg.callback(toolCall, toolResponse)
      } catch {
        // After hook errors are silently swallowed — they must not affect governance decisions.
      }
    }

    // 3. Observe-mode postconditions (from observe_alongside bundles)
    // These never affect the decision — only produce audit violations.
    for (const rule of this._guard.getObservePostconditions(toolCall)) {
      let decision: Decision
      try {
        decision = await rule.check(toolCall, toolResponse)
      } catch (exc) {
        decision = Decision.fail(`Observe-mode postcondition error: ${exc}`, { policy_error: true })
      }
      const record: Record<string, unknown> = {
        name: rule.name,
        type: 'postcondition',
        passed: decision.passed,
        message: decision.message,
        observed: true,
        source: rule.source ?? 'yaml_postcondition',
      }
      if (decision.metadata && Object.keys(decision.metadata).length > 0) {
        record['metadata'] = decision.metadata
      }
      contractsEvaluated.push(record)
      if (!decision.passed) {
        warnings.push(`\u26a0\ufe0f [observe] ${decision.message}`)
      }
    }

    // Exclude observe-mode records from the "real failure" check —
    // observe-mode failures are logged but should not signal a real failure
    const postconditionsPassed =
      contractsEvaluated.length > 0
        ? contractsEvaluated.every((c) => c['passed'] === true || c['observed'] === true)
        : true
    const pe = hasPolicyError(contractsEvaluated)

    return createPostDecision({
      toolSuccess,
      postconditionsPassed,
      warnings,
      contractsEvaluated,
      policyError: pe,
      redactedResponse,
      outputSuppressed,
    })
  }

  /**
   * Evaluate observe-mode rules without affecting the real decision.
   *
   * Observe-mode rules are identified by mode === "observe" on the
   * internal rule. Results are returned as dicts for audit emission
   * but never block calls.
   */
  private async _evaluateObserveContracts(
    toolCall: ToolCall,
    session: Session,
  ): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = []

    // Observe-mode preconditions
    for (const rule of this._guard.getObservePreconditions(toolCall)) {
      let decision: Decision
      try {
        decision = await rule.check(toolCall)
      } catch (exc) {
        decision = Decision.fail(`Observe-mode precondition error: ${exc}`, { policy_error: true })
      }

      results.push({
        name: rule.name,
        type: 'precondition',
        passed: decision.passed,
        message: decision.message,
        source: rule.source ?? 'yaml_precondition',
      })
    }

    // Observe-mode sandbox rules
    for (const rule of this._guard.getObserveSandboxContracts(toolCall)) {
      let decision: Decision
      try {
        decision = await rule.check(toolCall)
      } catch (exc) {
        decision = Decision.fail(`Observe-mode sandbox error: ${exc}`, { policy_error: true })
      }

      results.push({
        name: rule.name,
        type: 'sandbox',
        passed: decision.passed,
        message: decision.message,
        source: rule.source ?? 'yaml_sandbox',
      })
    }

    // Observe-mode session rules -- evaluate against the real session
    for (const rule of this._guard.getObserveSessionContracts()) {
      let decision: Decision
      try {
        decision = await rule.check(session)
      } catch (exc) {
        decision = Decision.fail(`Observe-mode session rule error: ${exc}`, {
          policy_error: true,
        })
      }

      results.push({
        name: rule.name,
        type: 'session_contract',
        passed: decision.passed,
        message: decision.message,
        source: rule.source ?? 'yaml_session',
      })
    }

    return results
  }
}
