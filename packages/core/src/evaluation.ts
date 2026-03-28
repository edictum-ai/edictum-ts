/** Evaluation result types for dry-run rule evaluation. */

// ---------------------------------------------------------------------------
// RuleResult
// ---------------------------------------------------------------------------

/** Result of evaluating a single rule. */
export interface RuleResult {
  readonly ruleId: string
  readonly contractType: string // "precondition" | "postcondition" | "sandbox"
  readonly passed: boolean
  readonly message: string | null
  readonly tags: readonly string[]
  readonly observed: boolean
  readonly effect: string
  readonly policyError: boolean
}

/** Create a frozen RuleResult with defaults matching the Python dataclass. */
export function createRuleResult(
  fields: Pick<RuleResult, 'ruleId' | 'contractType' | 'passed'> &
    Partial<Omit<RuleResult, 'ruleId' | 'contractType' | 'passed'>>,
): RuleResult {
  return Object.freeze({
    ruleId: fields.ruleId,
    contractType: fields.contractType,
    passed: fields.passed,
    message: fields.message ?? null,
    tags: Object.freeze([...(fields.tags ?? [])]),
    observed: fields.observed ?? false,
    effect: fields.effect ?? 'warn',
    policyError: fields.policyError ?? false,
  })
}

// ---------------------------------------------------------------------------
// EvaluationResult
// ---------------------------------------------------------------------------

/** Result of dry-run evaluation of a tool call against rules. */
export interface EvaluationResult {
  readonly decision: string // "allow" | "deny" | "warn"
  readonly toolName: string
  readonly rules: readonly RuleResult[]
  readonly denyReasons: readonly string[]
  readonly warnReasons: readonly string[]
  readonly contractsEvaluated: number
  readonly policyError: boolean
}

/** Create a frozen EvaluationResult with defaults matching the Python dataclass. */
export function createEvaluationResult(
  fields: Pick<EvaluationResult, 'decision' | 'toolName'> &
    Partial<Omit<EvaluationResult, 'decision' | 'toolName'>>,
): EvaluationResult {
  return Object.freeze({
    decision: fields.decision,
    toolName: fields.toolName,
    rules: Object.freeze([...(fields.rules ?? [])]),
    denyReasons: Object.freeze([...(fields.denyReasons ?? [])]),
    warnReasons: Object.freeze([...(fields.warnReasons ?? [])]),
    contractsEvaluated: fields.contractsEvaluated ?? 0,
    policyError: fields.policyError ?? false,
  })
}
