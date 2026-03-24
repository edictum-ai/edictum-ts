/**
 * Dry-run evaluation logic for Edictum.evaluate() and evaluateBatch().
 *
 * Ports Python's _dry_run.py. Exhaustive contract evaluation without
 * tool execution. Session contracts are skipped (no session state).
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's
 * _dry_run.py (205 LOC). evaluate() + evaluateBatch() are a cohesive unit.
 */

import type { Edictum } from './guard.js'
import type { Principal } from './envelope.js'

import { createEnvelope, createPrincipal } from './envelope.js'

/** Safely extract tags array from verdict metadata. */
function safeTags(metadata: Readonly<Record<string, unknown>> | null | undefined): string[] {
  if (!metadata) return []
  const raw = metadata['tags']
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is string => typeof t === 'string')
}
import { createContractResult, createEvaluationResult } from './evaluation.js'
import type { ContractResult, EvaluationResult } from './evaluation.js'

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
 * Dry-run evaluation of a tool call against all matching contracts.
 *
 * Unlike run(), this never executes the tool and evaluates all
 * matching contracts exhaustively (no short-circuit on first deny).
 * Session contracts are skipped (no session state in dry-run).
 */
export async function evaluate(
  guard: Edictum,
  toolName: string,
  args: Record<string, unknown>,
  options?: EvaluateOptions,
): Promise<EvaluationResult> {
  const env = options?.environment ?? guard.environment
  const envelope = createEnvelope(toolName, args, {
    environment: env,
    principal: options?.principal ?? null,
    registry: guard.toolRegistry,
  })

  const contracts: ContractResult[] = []
  const denyReasons: string[] = []
  const warnReasons: string[] = []

  // Evaluate all matching preconditions (exhaustive, no short-circuit)
  for (const contract of guard.getPreconditions(envelope)) {
    const contractId = contract.name ?? 'unknown'
    let verdict
    try {
      verdict = await contract.check(envelope)
    } catch (exc: unknown) {
      const contractResult = createContractResult({
        contractId,
        contractType: 'precondition',
        passed: false,
        message: `Precondition error: ${exc}`,
        policyError: true,
      })
      contracts.push(contractResult)
      denyReasons.push(contractResult.message ?? '')
      continue
    }

    const tags = safeTags(verdict.metadata)
    const isObserved = contract.mode === 'observe' && !verdict.passed
    const pe = verdict.metadata ? ((verdict.metadata['policy_error'] as boolean) ?? false) : false

    const contractResult = createContractResult({
      contractId,
      contractType: 'precondition',
      passed: verdict.passed,
      message: verdict.message,
      tags,
      observed: isObserved,
      policyError: pe,
    })
    contracts.push(contractResult)

    if (!verdict.passed && !isObserved) {
      denyReasons.push(verdict.message ?? '')
    }
  }

  // Evaluate sandbox contracts (exhaustive, no short-circuit)
  for (const contract of guard.getSandboxContracts(envelope)) {
    const contractId = contract.name ?? 'unknown'
    let verdict
    try {
      verdict = await contract.check(envelope)
    } catch (exc: unknown) {
      const contractResult = createContractResult({
        contractId,
        contractType: 'sandbox',
        passed: false,
        message: `Sandbox error: ${exc}`,
        policyError: true,
      })
      contracts.push(contractResult)
      denyReasons.push(contractResult.message ?? '')
      continue
    }

    const tags = safeTags(verdict.metadata)
    const isObserved = contract.mode === 'observe' && !verdict.passed
    const pe = verdict.metadata ? ((verdict.metadata['policy_error'] as boolean) ?? false) : false

    const contractResult = createContractResult({
      contractId,
      contractType: 'sandbox',
      passed: verdict.passed,
      message: verdict.message,
      tags,
      observed: isObserved,
      policyError: pe,
    })
    contracts.push(contractResult)

    if (!verdict.passed && !isObserved) {
      denyReasons.push(verdict.message ?? '')
    }
  }

  // Evaluate postconditions only when output is provided
  if (options?.output != null) {
    for (const contract of guard.getPostconditions(envelope)) {
      const contractId = contract.name ?? 'unknown'
      let verdict
      try {
        verdict = await contract.check(envelope, options.output)
      } catch (exc: unknown) {
        const contractResult = createContractResult({
          contractId,
          contractType: 'postcondition',
          passed: false,
          message: `Postcondition error: ${exc}`,
          policyError: true,
        })
        contracts.push(contractResult)
        // Route to correct bucket based on effect — deny-effect errors
        // must produce deny verdict, not warn
        const excEffect = contract.effect ?? 'warn'
        if (excEffect === 'deny') {
          denyReasons.push(contractResult.message ?? '')
        } else {
          warnReasons.push(contractResult.message ?? '')
        }
        continue
      }

      const tags = safeTags(verdict.metadata)
      const isObserved = contract.mode === 'observe' && !verdict.passed
      const pe = verdict.metadata ? ((verdict.metadata['policy_error'] as boolean) ?? false) : false
      const effect = contract.effect ?? 'warn'

      const contractResult = createContractResult({
        contractId,
        contractType: 'postcondition',
        passed: verdict.passed,
        message: verdict.message,
        tags,
        observed: isObserved,
        effect,
        policyError: pe,
      })
      contracts.push(contractResult)

      if (!verdict.passed && !isObserved) {
        if (effect === 'deny') {
          denyReasons.push(verdict.message ?? '')
        } else {
          warnReasons.push(verdict.message ?? '')
        }
      }
    }
  }

  // Compute verdict: deny > warn > allow
  let verdictStr: string
  if (denyReasons.length > 0) {
    verdictStr = 'deny'
  } else if (warnReasons.length > 0) {
    verdictStr = 'warn'
  } else {
    verdictStr = 'allow'
  }

  return createEvaluationResult({
    verdict: verdictStr,
    toolName,
    contracts,
    denyReasons,
    warnReasons,
    contractsEvaluated: contracts.length,
    policyError: contracts.some((r) => r.policyError),
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
