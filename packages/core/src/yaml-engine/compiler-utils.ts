/** Compiler utilities — validation, regex precompilation, message expansion. */

import { EdictumConfigError } from '../errors.js'
import { RedactionPolicy } from '../redaction.js'
import type { ToolEnvelope } from '../envelope.js'
import {
  BUILTIN_OPERATOR_NAMES,
  _MISSING,
  resolveSelector,
  type CustomSelector,
} from './evaluator.js'

// ---------------------------------------------------------------------------
// Placeholder expansion
// ---------------------------------------------------------------------------

const _PLACEHOLDER_RE = /\{([^}]+)\}/g
const _PLACEHOLDER_CAP = 200

/**
 * Expand {placeholder} tokens in a message template.
 *
 * Missing placeholders are kept as-is. Each expansion is capped at 200 chars.
 * Values that look like secrets are redacted.
 */
export function expandMessage(
  template: string,
  envelope: ToolEnvelope,
  outputText?: string | null,
  customSelectors?: Readonly<Record<string, CustomSelector>> | null,
): string {
  const redaction = new RedactionPolicy()

  return template.replace(_PLACEHOLDER_RE, (match, selectorRaw: string) => {
    const value = resolveSelector(selectorRaw, envelope, outputText, customSelectors)
    if (value === _MISSING || value == null) return match
    let text = String(value)
    if (redaction._looksLikeSecret(text)) text = '[REDACTED]'
    if (text.length > _PLACEHOLDER_CAP) text = text.slice(0, _PLACEHOLDER_CAP - 3) + '...'
    return text
  })
}

// ---------------------------------------------------------------------------
// Operator validation
// ---------------------------------------------------------------------------

/** Validate that all operators used in the bundle are known (built-in or custom). */
export function validateOperators(
  bundle: Record<string, unknown>,
  customOperators: Readonly<Record<string, unknown>> | null,
): void {
  const known = new Set([...BUILTIN_OPERATOR_NAMES, ...Object.keys(customOperators ?? {})])
  const contracts = (bundle.contracts ?? []) as Record<string, unknown>[]
  for (const contract of contracts) {
    const when = contract.when as Record<string, unknown> | undefined
    if (when) {
      _validateExpressionOperators(when, known, contract.id as string)
    }
  }
}

function _validateExpressionOperators(
  expr: unknown,
  known: ReadonlySet<string>,
  contractId: string,
): void {
  if (expr == null || typeof expr !== 'object') return
  const e = expr as Record<string, unknown>

  if ('all' in e) {
    for (const sub of e.all as Record<string, unknown>[]) {
      _validateExpressionOperators(sub, known, contractId)
    }
    return
  }
  if ('any' in e) {
    for (const sub of e.any as Record<string, unknown>[]) {
      _validateExpressionOperators(sub, known, contractId)
    }
    return
  }
  if ('not' in e) {
    _validateExpressionOperators(e.not, known, contractId)
    return
  }

  // Leaf node: selector -> operator
  for (const [, operator] of Object.entries(e)) {
    if (operator != null && typeof operator === 'object') {
      for (const opName of Object.keys(operator as Record<string, unknown>)) {
        if (!known.has(opName)) {
          throw new EdictumConfigError(`Contract '${contractId}': unknown operator '${opName}'`)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Regex precompilation
// ---------------------------------------------------------------------------

/**
 * Recursively walk an expression tree and compile regex patterns.
 *
 * Replaces string values under `matches` and `matches_any` with
 * pre-compiled RegExp objects so the evaluator never recompiles on every call.
 */
export function precompileRegexes(expr: unknown): unknown {
  if (expr == null || typeof expr !== 'object') return expr
  const e = expr as Record<string, unknown>

  if ('all' in e) {
    return { all: (e.all as unknown[]).map(precompileRegexes) }
  }
  if ('any' in e) {
    return { any: (e.any as unknown[]).map(precompileRegexes) }
  }
  if ('not' in e) {
    return { not: precompileRegexes(e.not) }
  }

  // Leaf node: selector -> operator
  const compiled: Record<string, unknown> = {}
  for (const [selector, operator] of Object.entries(e)) {
    if (operator == null || typeof operator !== 'object') {
      compiled[selector] = operator
      continue
    }
    const newOp = { ...(operator as Record<string, unknown>) }
    if ('matches' in newOp && typeof newOp.matches === 'string') {
      newOp.matches = new RegExp(newOp.matches)
    }
    if ('matches_any' in newOp && Array.isArray(newOp.matches_any)) {
      newOp.matches_any = (newOp.matches_any as string[]).map((p) =>
        typeof p === 'string' ? new RegExp(p) : p,
      )
    }
    compiled[selector] = newOp
  }
  return compiled
}

// ---------------------------------------------------------------------------
// Output pattern extraction
// ---------------------------------------------------------------------------

/**
 * Walk an expression tree and collect regex patterns from output.text leaves.
 *
 * Returns a flat list of compiled RegExp objects found under `matches` or
 * `matches_any` operators where the selector is `output.text`.
 * By the time this runs, `precompileRegexes` has already converted strings.
 */
export function extractOutputPatterns(expr: unknown): RegExp[] {
  if (expr == null || typeof expr !== 'object') return []
  const e = expr as Record<string, unknown>

  if ('all' in e) {
    const patterns: RegExp[] = []
    for (const sub of e.all as unknown[]) {
      patterns.push(...extractOutputPatterns(sub))
    }
    return patterns
  }
  if ('any' in e) {
    const patterns: RegExp[] = []
    for (const sub of e.any as unknown[]) {
      patterns.push(...extractOutputPatterns(sub))
    }
    return patterns
  }
  if ('not' in e) {
    return extractOutputPatterns(e.not)
  }

  // Leaf node
  const collected: RegExp[] = []
  for (const [selector, operator] of Object.entries(e)) {
    if (selector !== 'output.text' || operator == null || typeof operator !== 'object') continue
    const op = operator as Record<string, unknown>
    if ('matches' in op && op.matches instanceof RegExp) {
      collected.push(op.matches)
    }
    if ('matches_any' in op && Array.isArray(op.matches_any)) {
      for (const p of op.matches_any) {
        if (p instanceof RegExp) collected.push(p)
      }
    }
  }
  return collected
}
