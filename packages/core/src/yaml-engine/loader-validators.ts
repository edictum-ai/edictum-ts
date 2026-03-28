/** Loader validation helpers — schema, uniqueness, regex, selector, and sandbox checks. */

import { EdictumConfigError } from '../errors.js'

// ---------------------------------------------------------------------------
// Schema validation (structural — no JSON Schema dependency)
// ---------------------------------------------------------------------------

/**
 * Basic structural validation of a parsed YAML bundle.
 *
 * Checks apiVersion, kind, metadata, and rules array.
 * Full JSON Schema validation requires the edictum-schemas package (future).
 */
export function validateSchema(data: Record<string, unknown>): void {
  if (data.apiVersion !== 'edictum/v1') {
    throw new EdictumConfigError(
      `Schema validation failed: apiVersion must be 'edictum/v1', got '${String(data.apiVersion)}'`,
    )
  }
  if (data.kind !== 'Ruleset') {
    throw new EdictumConfigError(
      `Schema validation failed: kind must be 'Ruleset', got '${String(data.kind)}'`,
    )
  }
  if (data.metadata != null && typeof data.metadata !== 'object') {
    throw new EdictumConfigError('Schema validation failed: metadata must be an object')
  }
  if (!Array.isArray(data.rules)) {
    throw new EdictumConfigError('Schema validation failed: rules must be an array')
  }
}

// ---------------------------------------------------------------------------
// Unique IDs
// ---------------------------------------------------------------------------

// Reject control characters in rule IDs — null bytes, newlines, carriage
// returns, and other C0/C1 control chars could corrupt storage keys or logs.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/

// JSON Schema: "pattern": "^[a-z0-9][a-z0-9_-]*$"
const CONTRACT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/

/** Validate a single rule ID for dangerous characters and format. */
function validateContractId(ruleId: string): void {
  if (ruleId.length > 10_000) {
    throw new EdictumConfigError('Rule id exceeds maximum length')
  }
  // Control chars checked first — more specific error than pattern mismatch.
  if (CONTROL_CHAR_RE.test(ruleId)) {
    throw new EdictumConfigError(
      `Rule id contains control characters: '${ruleId.replace(CONTROL_CHAR_RE, '\\x??')}'`,
    )
  }
  if (!CONTRACT_ID_RE.test(ruleId)) {
    throw new EdictumConfigError(`Rule id '${ruleId}' must match pattern ^[a-z0-9][a-z0-9_-]*$`)
  }
}

/** Ensure all rule IDs are unique within the bundle and free of control characters. */
export function validateUniqueIds(data: Record<string, unknown>): void {
  const ids = new Set<string>()
  const rules = (data.rules ?? []) as Record<string, unknown>[]
  for (const rule of rules) {
    const ruleId = rule.id as string | undefined
    if (ruleId != null) {
      validateContractId(ruleId)
      if (ids.has(ruleId)) {
        throw new EdictumConfigError(`Duplicate rule id: '${ruleId}'`)
      }
      ids.add(ruleId)
    }
  }
}

// ---------------------------------------------------------------------------
// Regex validation
// ---------------------------------------------------------------------------

/** Compile all regex patterns at load time to catch invalid patterns early. */
export function validateRegexes(data: Record<string, unknown>): void {
  const rules = (data.rules ?? []) as Record<string, unknown>[]
  for (const rule of rules) {
    const when = rule.when
    if (when != null) {
      validateExpressionRegexes(when as Record<string, unknown>)
    }
  }
}

/** Recursively validate regex patterns in expressions. */
function validateExpressionRegexes(expr: unknown): void {
  if (expr == null || typeof expr !== 'object') return
  const e = expr as Record<string, unknown>

  if ('all' in e) {
    for (const sub of e.all as unknown[]) validateExpressionRegexes(sub)
    return
  }
  if ('any' in e) {
    for (const sub of e.any as unknown[]) validateExpressionRegexes(sub)
    return
  }
  if ('not' in e) {
    validateExpressionRegexes(e.not)
    return
  }

  // Leaf node: selector -> operator
  for (const operator of Object.values(e)) {
    if (operator == null || typeof operator !== 'object') continue
    const op = operator as Record<string, unknown>
    if ('matches' in op) tryCompileRegex(op.matches as string)
    if ('matches_any' in op) {
      for (const pattern of op.matches_any as string[]) tryCompileRegex(pattern)
    }
  }
}

/** Attempt to compile a regex, raising EdictumConfigError on failure. */
function tryCompileRegex(pattern: string): void {
  try {
    new RegExp(pattern)
  } catch (e) {
    throw new EdictumConfigError(`Invalid regex pattern '${pattern}': ${String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// Pre-selector validation
// ---------------------------------------------------------------------------

/** Reject output.text selectors in type: pre rules (spec violation). */
export function validatePreSelectors(data: Record<string, unknown>): void {
  const rules = (data.rules ?? []) as Record<string, unknown>[]
  for (const rule of rules) {
    if (rule.type !== 'pre') continue
    const when = rule.when
    if (when != null && expressionHasSelector(when as Record<string, unknown>, 'output.text')) {
      throw new EdictumConfigError(
        `Rule '${(rule.id as string) ?? '?'}': output.text selector is not available in type: pre rules`,
      )
    }
  }
}

/** Check if an expression tree contains a specific selector. */
function expressionHasSelector(expr: unknown, target: string): boolean {
  if (expr == null || typeof expr !== 'object') return false
  const e = expr as Record<string, unknown>
  if ('all' in e) return (e.all as unknown[]).some((sub) => expressionHasSelector(sub, target))
  if ('any' in e) return (e.any as unknown[]).some((sub) => expressionHasSelector(sub, target))
  if ('not' in e) return expressionHasSelector(e.not, target)
  return target in e
}

// ---------------------------------------------------------------------------
// Sandbox rule validation
// ---------------------------------------------------------------------------

/** Validate sandbox rule field dependencies. */
export function validateSandboxContracts(data: Record<string, unknown>): void {
  const rules = (data.rules ?? []) as Record<string, unknown>[]
  for (const rule of rules) {
    if (rule.type !== 'sandbox') continue
    const cid = (rule.id as string) ?? '?'

    if ('not_within' in rule && !('within' in rule)) {
      throw new EdictumConfigError(`Rule '${cid}': not_within requires within to also be set`)
    }
    if ('not_allows' in rule && !('allows' in rule)) {
      throw new EdictumConfigError(`Rule '${cid}': not_allows requires allows to also be set`)
    }
    if ('not_allows' in rule) {
      const notAllows = (rule.not_allows ?? {}) as Record<string, unknown>
      if ('domains' in notAllows) {
        const allows = (rule.allows ?? {}) as Record<string, unknown>
        if (!('domains' in allows)) {
          throw new EdictumConfigError(
            `Rule '${cid}': not_allows.domains requires allows.domains to also be set`,
          )
        }
      }
    }
  }
}
