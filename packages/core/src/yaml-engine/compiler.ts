/** Compiler — convert parsed YAML contracts into contract objects and OperationLimits. */

import type { OperationLimits } from '../limits.js'
import { DEFAULT_LIMITS } from '../limits.js'
import type { CustomOperator, CustomSelector } from './evaluator.js'
import { EdictumConfigError } from '../errors.js'
import { validateOperators } from './compiler-utils.js'
import { compilePre, compilePost, compileSession, mergeSessionLimits } from './compile-contracts.js'
import { compileSandbox } from './sandbox-compile-fn.js'

// ---------------------------------------------------------------------------
// CompiledBundle
// ---------------------------------------------------------------------------

/** Result of compiling a YAML contract bundle. */
export interface CompiledBundle {
  readonly preconditions: readonly unknown[]
  readonly postconditions: readonly unknown[]
  readonly sessionContracts: readonly unknown[]
  readonly sandboxContracts: readonly unknown[]
  readonly limits: OperationLimits
  readonly defaultMode: string
  readonly tools: Readonly<Record<string, Record<string, unknown>>>
}

// ---------------------------------------------------------------------------
// Compile options
// ---------------------------------------------------------------------------

export interface CompileOptions {
  readonly customOperators?: Readonly<Record<string, CustomOperator>> | null
  readonly customSelectors?: Readonly<Record<string, CustomSelector>> | null
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Compile a validated YAML bundle into contract objects.
 *
 * @param bundle - A validated bundle dict (output of loadBundle).
 * @param options - Optional custom operators and selectors.
 * @returns CompiledBundle with preconditions, postconditions, sessionContracts,
 *          and merged OperationLimits.
 */
export function compileContracts(
  bundle: Record<string, unknown>,
  options: CompileOptions = {},
): CompiledBundle {
  const customOps = options?.customOperators ?? null
  const customSels = options?.customSelectors ?? null

  validateOperators(bundle, customOps)

  if (bundle.defaults == null || typeof bundle.defaults !== 'object') {
    throw new EdictumConfigError("Bundle missing required 'defaults' section with 'mode' field")
  }
  const defaults = bundle.defaults as Record<string, unknown>
  const defaultMode = defaults.mode as string
  const preconditions: unknown[] = []
  const postconditions: unknown[] = []
  const sessionContracts: unknown[] = []
  const sandboxContracts: unknown[] = []
  let limits: OperationLimits = { ...DEFAULT_LIMITS }

  const contracts = (bundle.contracts ?? []) as Record<string, unknown>[]
  for (const contract of contracts) {
    // Skip disabled contracts
    if (contract.enabled === false) continue

    const contractType = contract.type as string
    const contractMode = (contract.mode as string) ?? defaultMode

    if (contractType === 'pre') {
      preconditions.push(compilePre(contract, contractMode, customOps, customSels))
    } else if (contractType === 'post') {
      postconditions.push(compilePost(contract, contractMode, customOps, customSels))
    } else if (contractType === 'session') {
      // Use _observe (TS) not _shadow (Python)
      const isObserve = (contract._observe as boolean) ?? (contract._shadow as boolean) ?? false
      if (!isObserve) {
        limits = mergeSessionLimits(contract, limits)
      }
      sessionContracts.push(compileSession(contract, contractMode, limits))
    } else if (contractType === 'sandbox') {
      sandboxContracts.push(compileSandbox(contract, contractMode))
    } else {
      throw new EdictumConfigError(
        `Unknown contract type "${contractType}" in contract "${contract.id ?? 'unknown'}". ` +
          `Expected "pre", "post", "session", or "sandbox".`,
      )
    }
  }

  const tools = (bundle.tools ?? {}) as Record<string, Record<string, unknown>>

  return {
    preconditions,
    postconditions,
    sessionContracts,
    sandboxContracts,
    limits,
    defaultMode,
    tools,
  }
}
