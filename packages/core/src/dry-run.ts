/**
 * Dry-run evaluation logic for Edictum.evaluate() and evaluateBatch().
 *
 * Ports Python's _dry_run.py. Exhaustive rule evaluation without
 * tool execution. Session rules are skipped (no session state).
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's
 * _dry_run.py (205 LOC). evaluate() + evaluateBatch() are a cohesive unit.
 */

import type { Edictum } from './guard.js'
import type { Principal } from './tool-call.js'

import { createEnvelope, createPrincipal } from './tool-call.js'

/** Safely extract tags array from decision metadata. */
function safeTags(metadata: Readonly<Record<string, unknown>> | null | undefined): string[] {
  if (!metadata) return []
  const raw = metadata['tags']
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is string => typeof t === 'string')
}
import { createRuleResult, createEvaluationResult } from './evaluation.js'
import type { RuleResult, EvaluationResult } from './evaluation.js'

// ---------------------------------------------------------------------------
// EvaluateOptions
// ---------------------------------------------------------------------------

/** Options for the evaluate() function. */
export interface EvaluateOptions {
  readonly principal?: Principal
  readonly output?: string
  readonly environment?: string
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/**
 * Dry-run evaluation of a tool call against all matching rules.
 *
 * Unlike run(), this never executes the tool and evaluates all
 * matching rules exhaustively (no short-circuit on first deny).
 * Session rules are skipped (no session state in dry-run).
 */
export async function evaluate(
  guard: Edictum,
  toolName: string,
  args: Record<string, unknown>,
  options?: EvaluateOptions,
): Promise<EvaluationResult> {
  const env = options?.environment ?? guard.environment
  const toolCall = createEnvelope(toolName, args, {
    environment: env,
    principal: options?.principal ?? null,
    registry: guard.toolRegistry,
  })

  const rules: RuleResult[] = []
  const denyReasons: string[] = []
  const warnReasons: string[] = []

  // Evaluate all matching preconditions (exhaustive, no short-circuit)
  for (const rule of guard.getPreconditions(toolCall)) {
    const ruleId = rule.name ?? 'unknown'
    let decision
    try {
      decision = await rule.check(toolCall)
    } catch (exc: unknown) {
      const contractResult = createRuleResult({
        ruleId,
        contractType: 'precondition',
        passed: false,
        message: `Precondition error: ${exc}`,
        policyError: true,
      })
      rules.push(contractResult)
      denyReasons.push(contractResult.message ?? '')
      continue
    }

    const tags = safeTags(decision.metadata)
    const isObserved = rule.mode === 'observe' && !decision.passed
    const pe = decision.metadata ? ((decision.metadata['policy_error'] as boolean) ?? false) : false

    const contractResult = createRuleResult({
      ruleId,
      contractType: 'precondition',
      passed: decision.passed,
      message: decision.message,
      tags,
      observed: isObserved,
      policyError: pe,
    })
    rules.push(contractResult)

    if (!decision.passed && !isObserved) {
      denyReasons.push(decision.message ?? '')
    }
  }

  // Evaluate sandbox rules (exhaustive, no short-circuit)
  for (const rule of guard.getSandboxContracts(toolCall)) {
    const ruleId = rule.name ?? 'unknown'
    let decision
    try {
      decision = await rule.check(toolCall)
    } catch (exc: unknown) {
      const contractResult = createRuleResult({
        ruleId,
        contractType: 'sandbox',
        passed: false,
        message: `Sandbox error: ${exc}`,
        policyError: true,
      })
      rules.push(contractResult)
      denyReasons.push(contractResult.message ?? '')
      continue
    }

    const tags = safeTags(decision.metadata)
    const isObserved = rule.mode === 'observe' && !decision.passed
    const pe = decision.metadata ? ((decision.metadata['policy_error'] as boolean) ?? false) : false

    const contractResult = createRuleResult({
      ruleId,
      contractType: 'sandbox',
      passed: decision.passed,
      message: decision.message,
      tags,
      observed: isObserved,
      policyError: pe,
    })
    rules.push(contractResult)

    if (!decision.passed && !isObserved) {
      denyReasons.push(decision.message ?? '')
    }
  }

  // Evaluate postconditions only when output is provided
  if (options?.output != null) {
    for (const rule of guard.getPostconditions(toolCall)) {
      const ruleId = rule.name ?? 'unknown'
      let decision
      try {
        decision = await rule.check(toolCall, options.output)
      } catch (exc: unknown) {
        const contractResult = createRuleResult({
          ruleId,
          contractType: 'postcondition',
          passed: false,
          message: `Postcondition error: ${exc}`,
          policyError: true,
        })
        rules.push(contractResult)
        // Route to correct bucket based on effect — deny-effect errors
        // must produce deny decision, not warn
        const excEffect = rule.effect ?? 'warn'
        if (excEffect === 'deny') {
          denyReasons.push(contractResult.message ?? '')
        } else {
          warnReasons.push(contractResult.message ?? '')
        }
        continue
      }

      const tags = safeTags(decision.metadata)
      const isObserved = rule.mode === 'observe' && !decision.passed
      const pe = decision.metadata
        ? ((decision.metadata['policy_error'] as boolean) ?? false)
        : false
      const effect = rule.effect ?? 'warn'

      const contractResult = createRuleResult({
        ruleId,
        contractType: 'postcondition',
        passed: decision.passed,
        message: decision.message,
        tags,
        observed: isObserved,
        effect,
        policyError: pe,
      })
      rules.push(contractResult)

      if (!decision.passed && !isObserved) {
        if (effect === 'deny') {
          denyReasons.push(decision.message ?? '')
        } else {
          warnReasons.push(decision.message ?? '')
        }
      }
    }
  }

  // Compute decision: deny > warn > allow
  let verdictStr: string
  if (denyReasons.length > 0) {
    verdictStr = 'deny'
  } else if (warnReasons.length > 0) {
    verdictStr = 'warn'
  } else {
    verdictStr = 'allow'
  }

  return createEvaluationResult({
    decision: verdictStr,
    toolName,
    rules,
    denyReasons,
    warnReasons,
    contractsEvaluated: rules.length,
    policyError: rules.some((r) => r.policyError),
    workflowSkipped: guard.getWorkflowRuntime() != null,
    workflowReason:
      guard.getWorkflowRuntime() != null
        ? 'workflow evaluation requires runtime session state and is enforced only by run() in M1'
        : null,
  })
}

// ---------------------------------------------------------------------------
// BatchCall
// ---------------------------------------------------------------------------

/** A single call in an evaluateBatch() batch. */
export interface BatchCall {
  readonly tool: string
  readonly args?: Record<string, unknown>
  readonly principal?: Record<string, unknown>
  readonly output?: string | Record<string, unknown>
  readonly environment?: string
}

// ---------------------------------------------------------------------------
// evaluateBatch
// ---------------------------------------------------------------------------

/**
 * Evaluate a batch of tool calls. Thin wrapper over evaluate().
 */
export async function evaluateBatch(
  guard: Edictum,
  calls: BatchCall[],
): Promise<EvaluationResult[]> {
  const results: EvaluationResult[] = []
  for (const call of calls) {
    const callArgs = call.args ?? {}

    // Convert principal dict to Principal object
    let principal: Principal | undefined
    if (call.principal != null && typeof call.principal === 'object') {
      principal = createPrincipal({
        role: (call.principal['role'] as string | undefined) ?? undefined,
        userId: (call.principal['userId'] as string | undefined) ?? undefined,
        ticketRef: (call.principal['ticketRef'] as string | undefined) ?? undefined,
        claims:
          typeof call.principal['claims'] === 'object' &&
          call.principal['claims'] != null &&
          !Array.isArray(call.principal['claims'])
            ? (call.principal['claims'] as Record<string, unknown>)
            : {},
      })
    }

    // Normalize output: if object, JSON.stringify
    let output: string | undefined
    if (call.output != null) {
      if (typeof call.output === 'object') {
        try {
          output = JSON.stringify(call.output)
        } catch {
          output = '[unserializable output]'
        }
      } else {
        output = call.output
      }
    }

    results.push(
      await evaluate(guard, call.tool, callArgs, {
        principal,
        output,
        environment: call.environment,
      }),
    )
  }
  return results
}
