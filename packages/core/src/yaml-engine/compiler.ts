/** Compiler — convert parsed YAML rules into rule objects and OperationLimits. */

import type { OperationLimits } from '../limits.js'
import { DEFAULT_LIMITS } from '../limits.js'
import type { CustomOperator, CustomSelector } from './evaluator.js'
import { EdictumConfigError } from '../errors.js'
import { validateOperators } from './compiler-utils.js'
import { compilePre, compilePost, compileSession, mergeSessionLimits } from './compile-rules.js'
import { compileSandbox } from './sandbox-compile-fn.js'

// ---------------------------------------------------------------------------
// CompiledBundle
// ---------------------------------------------------------------------------

/** Result of compiling a YAML rule bundle. */
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
 * Compile a validated YAML bundle into rule objects.
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

  const rules = (bundle.rules ?? []) as Record<string, unknown>[]
  for (const rule of rules) {
    // Skip disabled rules
    if (rule.enabled === false) continue

    const contractType = rule.type as string
    const contractMode = (rule.mode as string) ?? defaultMode

    if (contractType === 'pre') {
      preconditions.push(compilePre(rule, contractMode, customOps, customSels))
    } else if (contractType === 'post') {
      postconditions.push(compilePost(rule, contractMode, customOps, customSels))
    } else if (contractType === 'session') {
      // Use _observe (TS) not _shadow (Python)
      const isObserve = (rule._observe as boolean) ?? (rule._shadow as boolean) ?? false
      if (!isObserve) {
        limits = mergeSessionLimits(rule, limits)
      }
      sessionContracts.push(compileSession(rule, contractMode, limits))
    } else if (contractType === 'sandbox') {
      sandboxContracts.push(compileSandbox(rule, contractMode))
    } else {
      throw new EdictumConfigError(
        `Unknown rule type "${contractType}" in rule "${rule.id ?? 'unknown'}". ` +
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
