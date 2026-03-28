/** Structured postcondition violations. */

// ---------------------------------------------------------------------------
// Violation
// ---------------------------------------------------------------------------

/**
 * A structured finding from a postcondition evaluation.
 *
 * Produced when a postcondition warns or detects an issue.
 * Returned to the caller via PostCallResult so they can
 * decide how to remediate.
 */
export interface Violation {
  readonly type: string
  readonly ruleId: string
  readonly field: string
  readonly message: string
  readonly metadata: Readonly<Record<string, unknown>>
}

/** Create a frozen Violation with defaults for metadata. */
export function createViolation(
  fields: Pick<Violation, 'type' | 'ruleId' | 'field' | 'message'> &
    Partial<Pick<Violation, 'metadata'>>,
): Violation {
  return Object.freeze({
    type: fields.type,
    ruleId: fields.ruleId,
    field: fields.field,
    message: fields.message,
    metadata: Object.freeze({ ...(fields.metadata ?? {}) }),
  })
}

// ---------------------------------------------------------------------------
// PostCallResult
// ---------------------------------------------------------------------------

/**
 * Result from a governed tool call, including postcondition violations.
 *
 * Returned by adapter's postToolCall and available via asToolWrapper.
 *
 * When postconditionsPassed is false, the violations list contains
 * structured Violation objects describing what was detected. The caller
 * can then decide how to remediate (redact, replace, log, etc.).
 */
export interface PostCallResult {
  readonly result: unknown
  readonly postconditionsPassed: boolean
  readonly violations: readonly Violation[]
  readonly outputSuppressed: boolean
}

/** Create a PostCallResult with defaults. */
export function createPostCallResult(
  fields: Pick<PostCallResult, 'result'> & Partial<Omit<PostCallResult, 'result'>>,
): PostCallResult {
  return Object.freeze({
    result: fields.result,
    postconditionsPassed: fields.postconditionsPassed ?? true,
    violations: Object.freeze([...(fields.violations ?? [])]),
    outputSuppressed: fields.outputSuppressed ?? false,
  })
}

// ---------------------------------------------------------------------------
// classifyViolation
// ---------------------------------------------------------------------------

/**
 * Classify a postcondition finding type from rule ID and message.
 *
 * Returns a standard finding type string.
 */
export function classifyViolation(ruleId: string, verdictMessage: string): string {
  const contractLower = ruleId.toLowerCase()
  const messageLower = (verdictMessage || '').toLowerCase()

  const piiTerms = ['pii', 'ssn', 'patient', 'name', 'dob']
  if (piiTerms.some((term) => contractLower.includes(term) || messageLower.includes(term))) {
    return 'pii_detected'
  }

  const secretTerms = ['secret', 'token', 'key', 'credential', 'password']
  if (secretTerms.some((term) => contractLower.includes(term) || messageLower.includes(term))) {
    return 'secret_detected'
  }

  const limitTerms = ['session', 'limit', 'max_calls', 'budget']
  if (limitTerms.some((term) => contractLower.includes(term) || messageLower.includes(term))) {
    return 'limit_exceeded'
  }

  return 'policy_violation'
}

// ---------------------------------------------------------------------------
// PostDecision — structural type (pipeline.ts doesn't exist yet)
// ---------------------------------------------------------------------------

/**
 * Structural type for the PostDecision fields consumed by buildViolations.
 *
 * The full PostDecision lives in pipeline.ts. This captures only the
 * subset needed here to avoid a circular import.
 */
export interface PostDecisionLike {
  readonly contractsEvaluated: ReadonlyArray<{
    readonly passed?: boolean
    readonly name: string
    readonly message?: string
    readonly metadata?: Record<string, unknown>
  }>
}

// ---------------------------------------------------------------------------
// buildViolations
// ---------------------------------------------------------------------------

/**
 * Build Violation objects from a PostDecision's failed postconditions.
 *
 * The `field` value is extracted from `metadata.field` if the
 * rule provides it (e.g. `Decision.fail("msg", { field: "output.text" })`),
 * otherwise defaults to `"output"` for postconditions.
 */
export function buildViolations(postDecision: PostDecisionLike): Violation[] {
  const violations: Violation[] = []
  for (const cr of postDecision.contractsEvaluated) {
    if (!cr.passed) {
      const meta = cr.metadata ?? {}
      violations.push(
        createViolation({
          type: classifyViolation(cr.name, cr.message ?? ''),
          ruleId: cr.name,
          field: (meta.field as string) ?? 'output',
          message: cr.message ?? '',
          metadata: meta,
        }),
      )
    }
  }
  return violations
}
