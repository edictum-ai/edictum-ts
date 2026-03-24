/** Built-in operators for YAML condition evaluation. */

/** Cap regex input to prevent catastrophic backtracking DoS. */
export const MAX_REGEX_INPUT = 10_000

// ---------------------------------------------------------------------------
// Operator implementations
// ---------------------------------------------------------------------------

function opEquals(fieldValue: unknown, opValue: unknown): boolean {
  return fieldValue === opValue
}

function opNotEquals(fieldValue: unknown, opValue: unknown): boolean {
  return fieldValue !== opValue
}

function opIn(fieldValue: unknown, opValue: unknown[]): boolean {
  return opValue.includes(fieldValue)
}

function opNotIn(fieldValue: unknown, opValue: unknown[]): boolean {
  return !opValue.includes(fieldValue)
}

function opContains(fieldValue: unknown, opValue: string): boolean {
  if (typeof fieldValue !== 'string') throw new TypeError()
  return fieldValue.includes(opValue)
}

function opContainsAny(fieldValue: unknown, opValue: string[]): boolean {
  if (typeof fieldValue !== 'string') throw new TypeError()
  return opValue.some((v) => fieldValue.includes(v))
}

function opStartsWith(fieldValue: unknown, opValue: string): boolean {
  if (typeof fieldValue !== 'string') throw new TypeError()
  return fieldValue.startsWith(opValue)
}

function opEndsWith(fieldValue: unknown, opValue: string): boolean {
  if (typeof fieldValue !== 'string') throw new TypeError()
  return fieldValue.endsWith(opValue)
}

function opMatches(fieldValue: unknown, opValue: string | RegExp): boolean {
  if (typeof fieldValue !== 'string') throw new TypeError()
  const truncated = fieldValue.slice(0, MAX_REGEX_INPUT)
  if (opValue instanceof RegExp) {
    return opValue.test(truncated)
  }
  return new RegExp(opValue).test(truncated)
}

function opMatchesAny(fieldValue: unknown, opValue: Array<string | RegExp>): boolean {
  if (typeof fieldValue !== 'string') throw new TypeError()
  const truncated = fieldValue.slice(0, MAX_REGEX_INPUT)
  return opValue.some((p) =>
    p instanceof RegExp ? p.test(truncated) : new RegExp(p).test(truncated),
  )
}

function opGt(fieldValue: unknown, opValue: number): boolean {
  if (typeof fieldValue !== 'number') throw new TypeError()
  return fieldValue > opValue
}

function opGte(fieldValue: unknown, opValue: number): boolean {
  if (typeof fieldValue !== 'number') throw new TypeError()
  return fieldValue >= opValue
}

function opLt(fieldValue: unknown, opValue: number): boolean {
  if (typeof fieldValue !== 'number') throw new TypeError()
  return fieldValue < opValue
}

function opLte(fieldValue: unknown, opValue: number): boolean {
  if (typeof fieldValue !== 'number') throw new TypeError()
  return fieldValue <= opValue
}

// ---------------------------------------------------------------------------
// Operator dispatch table
// ---------------------------------------------------------------------------

export type OperatorFn = (fieldValue: unknown, opValue: unknown) => boolean

export const OPERATORS: Readonly<Record<string, OperatorFn>> = {
  equals: opEquals,
  not_equals: opNotEquals,
  in: opIn as OperatorFn,
  not_in: opNotIn as OperatorFn,
  contains: opContains as OperatorFn,
  contains_any: opContainsAny as OperatorFn,
  starts_with: opStartsWith as OperatorFn,
  ends_with: opEndsWith as OperatorFn,
  matches: opMatches as OperatorFn,
  matches_any: opMatchesAny as OperatorFn,
  gt: opGt as OperatorFn,
  gte: opGte as OperatorFn,
  lt: opLt as OperatorFn,
  lte: opLte as OperatorFn,
}

/** All built-in operator names (including "exists" which is special-cased). */
export const BUILTIN_OPERATOR_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(OPERATORS),
  'exists',
])
