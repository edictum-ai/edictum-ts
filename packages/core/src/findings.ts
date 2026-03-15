/** Structured postcondition findings. */

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

/**
 * A structured finding from a postcondition evaluation.
 *
 * Produced when a postcondition warns or detects an issue.
 * Returned to the caller via PostCallResult so they can
 * decide how to remediate.
 */
export interface Finding {
  readonly type: string;
  readonly contractId: string;
  readonly field: string;
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Create a frozen Finding with defaults for metadata. */
export function createFinding(
  fields: Pick<Finding, "type" | "contractId" | "field" | "message"> &
    Partial<Pick<Finding, "metadata">>,
): Finding {
  return Object.freeze({
    type: fields.type,
    contractId: fields.contractId,
    field: fields.field,
    message: fields.message,
    metadata: Object.freeze({ ...(fields.metadata ?? {}) }),
  });
}

// ---------------------------------------------------------------------------
// PostCallResult
// ---------------------------------------------------------------------------

/**
 * Result from a governed tool call, including postcondition findings.
 *
 * Returned by adapter's postToolCall and available via asToolWrapper.
 *
 * When postconditionsPassed is false, the findings list contains
 * structured Finding objects describing what was detected. The caller
 * can then decide how to remediate (redact, replace, log, etc.).
 */
export interface PostCallResult {
  readonly result: unknown;
  readonly postconditionsPassed: boolean;
  readonly findings: readonly Finding[];
  readonly outputSuppressed: boolean;
}

/** Create a PostCallResult with defaults. */
export function createPostCallResult(
  fields: Pick<PostCallResult, "result"> &
    Partial<Omit<PostCallResult, "result">>,
): PostCallResult {
  return Object.freeze({
    result: fields.result,
    postconditionsPassed: fields.postconditionsPassed ?? true,
    findings: Object.freeze([...(fields.findings ?? [])]),
    outputSuppressed: fields.outputSuppressed ?? false,
  });
}

// ---------------------------------------------------------------------------
// classifyFinding
// ---------------------------------------------------------------------------

/**
 * Classify a postcondition finding type from contract ID and message.
 *
 * Returns a standard finding type string.
 */
export function classifyFinding(
  contractId: string,
  verdictMessage: string,
): string {
  const contractLower = contractId.toLowerCase();
  const messageLower = (verdictMessage || "").toLowerCase();

  const piiTerms = ["pii", "ssn", "patient", "name", "dob"];
  if (
    piiTerms.some(
      (term) => contractLower.includes(term) || messageLower.includes(term),
    )
  ) {
    return "pii_detected";
  }

  const secretTerms = ["secret", "token", "key", "credential", "password"];
  if (
    secretTerms.some(
      (term) => contractLower.includes(term) || messageLower.includes(term),
    )
  ) {
    return "secret_detected";
  }

  const limitTerms = ["session", "limit", "max_calls", "budget"];
  if (
    limitTerms.some(
      (term) => contractLower.includes(term) || messageLower.includes(term),
    )
  ) {
    return "limit_exceeded";
  }

  return "policy_violation";
}

// ---------------------------------------------------------------------------
// PostDecision — structural type (pipeline.ts doesn't exist yet)
// ---------------------------------------------------------------------------

/**
 * Structural type for the PostDecision fields consumed by buildFindings.
 *
 * The full PostDecision lives in pipeline.ts. This captures only the
 * subset needed here to avoid a circular import.
 */
export interface PostDecisionLike {
  readonly contractsEvaluated: ReadonlyArray<{
    readonly passed?: boolean;
    readonly name: string;
    readonly message?: string;
    readonly metadata?: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// buildFindings
// ---------------------------------------------------------------------------

/**
 * Build Finding objects from a PostDecision's failed postconditions.
 *
 * The `field` value is extracted from `metadata.field` if the
 * contract provides it (e.g. `Verdict.fail("msg", { field: "output.text" })`),
 * otherwise defaults to `"output"` for postconditions.
 */
export function buildFindings(postDecision: PostDecisionLike): Finding[] {
  const findings: Finding[] = [];
  for (const cr of postDecision.contractsEvaluated) {
    if (!cr.passed) {
      const meta = cr.metadata ?? {};
      findings.push(
        createFinding({
          type: classifyFinding(cr.name, cr.message ?? ""),
          contractId: cr.name,
          field: (meta.field as string) ?? "output",
          message: cr.message ?? "",
          metadata: meta,
        }),
      );
    }
  }
  return findings;
}
