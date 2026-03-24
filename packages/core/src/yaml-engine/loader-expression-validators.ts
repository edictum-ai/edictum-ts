/** Expression shape validation — empty all/any guards and operator type constraints. */

import { EdictumConfigError } from '../errors.js'

const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte'])
const STRING_OPS = new Set(['contains', 'starts_with', 'ends_with'])
const ARRAY_MIN1_OPS = new Set(['in', 'not_in', 'contains_any', 'matches_any'])

function fail(msg: string): never {
  throw new EdictumConfigError(`Schema validation failed: ${msg}`)
}

/** Validate expression tree shapes and operator value types. */
export function validateExpressionShapes(data: Record<string, unknown>): void {
  for (const c of (data.contracts ?? []) as unknown[]) {
    if (c == null || typeof c !== 'object') continue
    const contract = c as Record<string, unknown>
    if (contract.when != null) checkExprShape(contract.when, (contract.id as string) ?? '?')
  }
}

function checkExprShape(expr: unknown, cid: string): void {
  if (expr == null || typeof expr !== 'object') return
  const e = expr as Record<string, unknown>

  if ('all' in e) {
    const a = e.all
    if (!Array.isArray(a) || a.length === 0)
      fail(`contract '${cid}': 'all' requires a non-empty array`)
    for (const s of a) checkExprShape(s, cid)
    return
  }
  if ('any' in e) {
    const a = e.any
    if (!Array.isArray(a) || a.length === 0)
      fail(`contract '${cid}': 'any' requires a non-empty array`)
    for (const s of a) checkExprShape(s, cid)
    return
  }
  if ('not' in e) {
    checkExprShape(e.not, cid)
    return
  }

  // Leaf: validate operator value types
  for (const v of Object.values(e)) {
    if (v == null || typeof v !== 'object') continue
    const op = v as Record<string, unknown>
    for (const [name, val] of Object.entries(op)) {
      if (NUMERIC_OPS.has(name) && typeof val !== 'number') {
        fail(`contract '${cid}': operator '${name}' requires a number, got ${typeof val}`)
      }
      if (STRING_OPS.has(name) && typeof val !== 'string') {
        fail(`contract '${cid}': operator '${name}' requires a string, got ${typeof val}`)
      }
      if (ARRAY_MIN1_OPS.has(name) && (!Array.isArray(val) || val.length === 0)) {
        fail(`contract '${cid}': operator '${name}' requires a non-empty array`)
      }
    }
  }
}
