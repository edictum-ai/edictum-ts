/** Condition Evaluator — resolve selectors and apply operators against ToolEnvelope. */

import type { ToolEnvelope } from '../envelope.js'
import { OPERATORS, BUILTIN_OPERATOR_NAMES } from './operators.js'
import { _MISSING, resolveSelector } from './selectors.js'

// Re-export for external consumers
export { BUILTIN_OPERATOR_NAMES }
export { MAX_REGEX_INPUT } from './operators.js'
export { _MISSING, BUILTIN_SELECTOR_PREFIXES, resolveSelector } from './selectors.js'
export type { Missing } from './selectors.js'
// Aliased re-exports for backward-compatible names
export { resolveNested as _resolveNested, coerceEnvValue as _coerceEnvValue } from './selectors.js'

// ---------------------------------------------------------------------------
// PolicyError — sentinel for type mismatches (fail-closed)
// ---------------------------------------------------------------------------

/**
 * Sentinel indicating a type mismatch or evaluation error.
 *
 * Converts to `true` conceptually — errors trigger the contract (fail-closed).
 * Callers should treat PolicyError as "condition matched" and apply
 * deny/warn + policyError flag.
 */
export class PolicyError {
  readonly message: string
  constructor(message: string) {
    this.message = message
  }
}

// ---------------------------------------------------------------------------
// Custom extension types
// ---------------------------------------------------------------------------

export type CustomOperator = (fieldValue: unknown, opValue: unknown) => boolean
export type CustomSelector = (envelope: ToolEnvelope) => Record<string, unknown>

export interface EvaluateOptions {
  readonly customOperators?: Readonly<Record<string, CustomOperator>> | null
  readonly customSelectors?: Readonly<Record<string, CustomSelector>> | null
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate a boolean expression tree against an envelope.
 *
 * Returns `true` if the expression matches, `false` if not.
 * Returns a `PolicyError` if a type mismatch or evaluation error occurs
 * (caller should treat as deny/warn + policyError).
 *
 * Missing fields always evaluate to `false` (contract doesn't fire).
 */
export function evaluateExpression(
  expr: Record<string, unknown>,
  envelope: ToolEnvelope,
  outputText?: string | null,
  options?: EvaluateOptions,
): boolean | PolicyError {
  const customOps = options?.customOperators ?? null
  const customSels = options?.customSelectors ?? null

  if ('all' in expr) {
    return _evalAll(
      expr.all as Record<string, unknown>[],
      envelope,
      outputText,
      customOps,
      customSels,
    )
  }
  if ('any' in expr) {
    return _evalAny(
      expr.any as Record<string, unknown>[],
      envelope,
      outputText,
      customOps,
      customSels,
    )
  }
  if ('not' in expr) {
    return _evalNot(
      expr.not as Record<string, unknown>,
      envelope,
      outputText,
      customOps,
      customSels,
    )
  }

  // Leaf node: exactly one selector key (schema enforces single-key leaves).
  // Guard: if a malformed leaf has multiple keys, fail-closed with PolicyError
  // rather than silently dropping extra keys. Python takes next(iter(leaf))
  // which also ignores extras — this is a strictness improvement.
  const leafKeys = Object.keys(expr)
  if (leafKeys.length !== 1) {
    return new PolicyError(
      `Leaf expression must have exactly one selector key, got ${leafKeys.length}: [${leafKeys.join(', ')}]`,
    )
  }
  return _evalLeaf(expr, envelope, outputText, customOps, customSels)
}

// ---------------------------------------------------------------------------
// Boolean AST nodes
// ---------------------------------------------------------------------------

function _evalAll(
  exprs: Record<string, unknown>[],
  envelope: ToolEnvelope,
  outputText: string | null | undefined,
  customOps: Readonly<Record<string, CustomOperator>> | null,
  customSels: Readonly<Record<string, CustomSelector>> | null,
): boolean | PolicyError {
  for (const expr of exprs) {
    const result = evaluateExpression(expr, envelope, outputText, {
      customOperators: customOps,
      customSelectors: customSels,
    })
    if (result instanceof PolicyError) return result
    if (!result) return false
  }
  return true
}

function _evalAny(
  exprs: Record<string, unknown>[],
  envelope: ToolEnvelope,
  outputText: string | null | undefined,
  customOps: Readonly<Record<string, CustomOperator>> | null,
  customSels: Readonly<Record<string, CustomSelector>> | null,
): boolean | PolicyError {
  for (const expr of exprs) {
    const result = evaluateExpression(expr, envelope, outputText, {
      customOperators: customOps,
      customSelectors: customSels,
    })
    if (result instanceof PolicyError) return result
    if (result) return true
  }
  return false
}

function _evalNot(
  expr: Record<string, unknown>,
  envelope: ToolEnvelope,
  outputText: string | null | undefined,
  customOps: Readonly<Record<string, CustomOperator>> | null,
  customSels: Readonly<Record<string, CustomSelector>> | null,
): boolean | PolicyError {
  const result = evaluateExpression(expr, envelope, outputText, {
    customOperators: customOps,
    customSelectors: customSels,
  })
  if (result instanceof PolicyError) return result
  return !result
}

function _evalLeaf(
  leaf: Record<string, unknown>,
  envelope: ToolEnvelope,
  outputText: string | null | undefined,
  customOps: Readonly<Record<string, CustomOperator>> | null,
  customSels: Readonly<Record<string, CustomSelector>> | null,
): boolean | PolicyError {
  const selector = Object.keys(leaf)[0] as string
  const operatorBlock = leaf[selector] as Record<string, unknown>
  const value = resolveSelector(selector, envelope, outputText, customSels)
  const opName = Object.keys(operatorBlock)[0] as string
  const opValue = operatorBlock[opName]
  return _applyOperator(opName, value, opValue, selector, customOps)
}

// ---------------------------------------------------------------------------
// Operator application
// ---------------------------------------------------------------------------

/** Apply a single operator to a resolved field value. */
function _applyOperator(
  op: string,
  fieldValue: unknown,
  opValue: unknown,
  selector: string,
  customOperators: Readonly<Record<string, CustomOperator>> | null,
): boolean | PolicyError {
  // exists is special — works on _MISSING
  if (op === 'exists') {
    const isPresent = fieldValue !== _MISSING && fieldValue != null
    return isPresent === opValue
  }

  // All other operators: missing field -> false
  if (fieldValue === _MISSING || fieldValue == null) return false

  try {
    if (Object.hasOwn(OPERATORS, op))
      return (OPERATORS[op] as (fv: unknown, ov: unknown) => boolean)(fieldValue, opValue)
    if (customOperators && Object.hasOwn(customOperators, op)) {
      return Boolean((customOperators[op] as CustomOperator)(fieldValue, opValue))
    }
    return new PolicyError(`Unknown operator: '${op}'`)
  } catch {
    return new PolicyError(
      `Type mismatch: operator '${op}' cannot be applied to ` +
        `selector '${selector}' value ${typeof fieldValue}`,
    )
  }
}
