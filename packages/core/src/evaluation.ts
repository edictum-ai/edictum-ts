/** Evaluation result types for dry-run contract evaluation. */

// ---------------------------------------------------------------------------
// ContractResult
// ---------------------------------------------------------------------------

/** Result of evaluating a single contract. */
export interface ContractResult {
  readonly contractId: string
  readonly contractType: string // "precondition" | "postcondition" | "sandbox"
  readonly passed: boolean
  readonly message: string | null
  readonly tags: readonly string[]
  readonly observed: boolean
  readonly effect: string
  readonly policyError: boolean
}

/** Create a frozen ContractResult with defaults matching the Python dataclass. */
export function createContractResult(
  fields: Pick<ContractResult, 'contractId' | 'contractType' | 'passed'> &
    Partial<Omit<ContractResult, 'contractId' | 'contractType' | 'passed'>>,
): ContractResult {
  return Object.freeze({
    contractId: fields.contractId,
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

/** Result of dry-run evaluation of a tool call against contracts. */
export interface EvaluationResult {
  readonly verdict: string // "allow" | "deny" | "warn"
  readonly toolName: string
  readonly contracts: readonly ContractResult[]
  readonly denyReasons: readonly string[]
  readonly warnReasons: readonly string[]
  readonly contractsEvaluated: number
  readonly policyError: boolean
}

/** Create a frozen EvaluationResult with defaults matching the Python dataclass. */
export function createEvaluationResult(
  fields: Pick<EvaluationResult, 'verdict' | 'toolName'> &
    Partial<Omit<EvaluationResult, 'verdict' | 'toolName'>>,
): EvaluationResult {
  return Object.freeze({
    verdict: fields.verdict,
    toolName: fields.toolName,
    contracts: Object.freeze([...(fields.contracts ?? [])]),
    denyReasons: Object.freeze([...(fields.denyReasons ?? [])]),
    warnReasons: Object.freeze([...(fields.warnReasons ?? [])]),
    contractsEvaluated: fields.contractsEvaluated ?? 0,
    policyError: fields.policyError ?? false,
  })
}
