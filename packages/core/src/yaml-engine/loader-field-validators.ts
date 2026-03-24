/**
 * Contract-level structural validation — enforces required fields, type
 * constraints, effect enums, and expression shapes that the JSON Schema
 * spec mandates. Hand-rolled to match Go's validation approach and keep
 * cross-SDK implementation strategy aligned.
 */

import { EdictumConfigError } from '../errors.js'

// ---------------------------------------------------------------------------
// Allowed values (mirrors edictum-v1.schema.json enums)
// ---------------------------------------------------------------------------

const VALID_CONTRACT_TYPES = new Set(['pre', 'post', 'session', 'sandbox'])
const PRE_EFFECTS = new Set(['deny', 'approve'])
const POST_EFFECTS = new Set(['warn', 'redact', 'deny'])
const VALID_MODES = new Set(['enforce', 'observe'])
const VALID_SIDE_EFFECTS = new Set(['pure', 'read', 'write', 'irreversible'])
const KNOWN_TOP_LEVEL = new Set([
  'apiVersion',
  'kind',
  'metadata',
  'defaults',
  'contracts',
  'tools',
  'observability',
  'observe_alongside',
])
const METADATA_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const MAX_MESSAGE_LENGTH = 500
const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte'])
const STRING_OPS = new Set(['contains', 'starts_with', 'ends_with'])
const ARRAY_MIN1_OPS = new Set(['in', 'not_in', 'contains_any', 'matches_any'])

/** Throw EdictumConfigError with a "Schema validation failed:" prefix. */
function fail(msg: string): never {
  throw new EdictumConfigError(`Schema validation failed: ${msg}`)
}

// ---------------------------------------------------------------------------
// Top-level + per-contract structural validation
// ---------------------------------------------------------------------------

/**
 * Validate contract-level structural requirements that Python enforces via
 * JSON Schema. Must run **after** `validateSchema()` (which guarantees
 * apiVersion, kind, and contracts-is-array) and **before** `validateUniqueIds()`.
 */
export function validateContractFields(data: Record<string, unknown>): void {
  // --- Unknown top-level fields (additionalProperties: false) ---
  for (const key of Object.keys(data)) {
    if (!KNOWN_TOP_LEVEL.has(key)) fail(`unknown top-level field '${key}'`)
  }

  // --- metadata required with name ---
  if (data.metadata == null || typeof data.metadata !== 'object' || Array.isArray(data.metadata)) {
    fail("'metadata' is required and must be an object")
  }
  const meta = data.metadata as Record<string, unknown>
  if (meta.name == null || typeof meta.name !== 'string') fail('metadata.name is required')
  if (!METADATA_NAME_RE.test(meta.name as string)) {
    fail(
      `metadata.name must be a lowercase slug (^[a-z0-9][a-z0-9._-]*$), got '${String(meta.name)}'`,
    )
  }

  // --- defaults required with valid mode ---
  if (data.defaults == null || typeof data.defaults !== 'object' || Array.isArray(data.defaults)) {
    fail("'defaults' is required and must be an object")
  }
  const mode = (data.defaults as Record<string, unknown>).mode
  if (!VALID_MODES.has(mode as string)) {
    fail(`defaults.mode must be 'enforce' or 'observe', got '${String(mode)}'`)
  }

  // --- contracts minItems: 1 ---
  const contracts = data.contracts as Record<string, unknown>[]
  if (contracts.length === 0) fail('contracts must contain at least 1 item')

  // --- tools side_effect enum ---
  if (data.tools != null && typeof data.tools === 'object') {
    for (const [tn, td] of Object.entries(data.tools as Record<string, unknown>)) {
      if (td != null && typeof td === 'object') {
        const se = (td as Record<string, unknown>).side_effect
        if (!VALID_SIDE_EFFECTS.has(se as string)) {
          fail(
            `tools.${tn}.side_effect must be 'pure', 'read', 'write', or 'irreversible', got '${String(se)}'`,
          )
        }
      }
    }
  }

  // --- Per-contract validation ---
  for (const c of contracts) {
    if (c.id == null || typeof c.id !== 'string' || c.id.length === 0) {
      fail("every contract requires a non-empty 'id' string")
    }
    const cid = c.id as string
    if (!VALID_CONTRACT_TYPES.has(c.type as string)) {
      fail(`contract '${cid}': invalid type '${String(c.type)}'`)
    }
    const t = c.type as string

    if (t === 'pre' || t === 'post') validatePrePost(c, t, cid)
    else if (t === 'session') validateSession(c, cid)
    else if (t === 'sandbox') validateSandboxStructure(c, cid)
  }
}

// ---------------------------------------------------------------------------
// Pre/Post contract validation
// ---------------------------------------------------------------------------

function validatePrePost(c: Record<string, unknown>, t: string, cid: string): void {
  if (c.tool == null) fail(`${t} contract '${cid}' requires 'tool'`)
  if (c.when == null) fail(`${t} contract '${cid}' requires 'when'`)
  if (c.then == null || typeof c.then !== 'object') fail(`${t} contract '${cid}' requires 'then'`)

  const then = c.then as Record<string, unknown>
  if (then.effect == null) fail(`${t} contract '${cid}' requires 'then.effect'`)
  if (then.message == null) fail(`${t} contract '${cid}' requires 'then.message'`)
  validateMessageLength(then.message, `${t} contract '${cid}'`)

  const effect = then.effect as string
  if (t === 'pre' && !PRE_EFFECTS.has(effect)) {
    fail(`pre contract '${cid}': effect must be 'deny' or 'approve', got '${effect}'`)
  }
  if (t === 'post' && !POST_EFFECTS.has(effect)) {
    fail(`post contract '${cid}': effect must be 'warn', 'redact', or 'deny', got '${effect}'`)
  }
}

// ---------------------------------------------------------------------------
// Session contract validation
// ---------------------------------------------------------------------------

function validateSession(c: Record<string, unknown>, cid: string): void {
  if (c.limits == null || typeof c.limits !== 'object') {
    fail(`session contract '${cid}' requires 'limits'`)
  }
  const lim = c.limits as Record<string, unknown>
  if (!('max_tool_calls' in lim) && !('max_attempts' in lim) && !('max_calls_per_tool' in lim)) {
    fail(
      `session contract '${cid}': limits must have max_tool_calls, max_attempts, or max_calls_per_tool`,
    )
  }

  if (c.then == null || typeof c.then !== 'object')
    fail(`session contract '${cid}' requires 'then'`)
  const then = c.then as Record<string, unknown>
  if (then.effect !== 'deny') {
    fail(`session contract '${cid}': effect must be 'deny', got '${String(then.effect)}'`)
  }
  if (then.message == null) fail(`session contract '${cid}' requires 'then.message'`)
  validateMessageLength(then.message, `session contract '${cid}'`)
}

// ---------------------------------------------------------------------------
// Sandbox contract structure (complements validateSandboxContracts)
// ---------------------------------------------------------------------------

function validateSandboxStructure(c: Record<string, unknown>, cid: string): void {
  if (c.tool == null && c.tools == null) {
    fail(`sandbox contract '${cid}' requires either 'tool' or 'tools'`)
  }
  if (c.within == null && c.allows == null) {
    fail(`sandbox contract '${cid}' requires either 'within' or 'allows'`)
  }
  if (c.message == null) fail(`sandbox contract '${cid}' requires 'message'`)
  validateMessageLength(c.message, `sandbox contract '${cid}'`)
}

// ---------------------------------------------------------------------------
// Message length constraint (maxLength: 500)
// ---------------------------------------------------------------------------

function validateMessageLength(msg: unknown, context: string): void {
  if (typeof msg === 'string' && msg.length > MAX_MESSAGE_LENGTH) {
    fail(`${context}: message exceeds ${MAX_MESSAGE_LENGTH} characters`)
  }
}

// ---------------------------------------------------------------------------
// Expression shape validation (empty all/any, operator type constraints)
// ---------------------------------------------------------------------------

/** Validate expression tree shapes and operator value types. */
export function validateExpressionShapes(data: Record<string, unknown>): void {
  for (const c of (data.contracts ?? []) as Record<string, unknown>[]) {
    if (c.when != null) checkExprShape(c.when, (c.id as string) ?? '?')
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
