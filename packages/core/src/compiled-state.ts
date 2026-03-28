/**
 * _CompiledState -- frozen snapshot of compiled rules.
 *
 * All rule lists are readonly arrays (frozen). The entire state is
 * replaced atomically via a single reference assignment in reload(),
 * ensuring concurrent evaluations never see a mix of old and new
 * rules.
 */

import { deepFreeze } from './tool-call.js'
import type {
  InternalPrecondition,
  InternalPostcondition,
  InternalSessionRule,
  InternalSandboxRule,
} from './internal-rules.js'
import { DEFAULT_LIMITS } from './limits.js'
import type { OperationLimits } from './limits.js'

export interface CompiledState {
  readonly preconditions: readonly InternalPrecondition[]
  readonly postconditions: readonly InternalPostcondition[]
  readonly sessionContracts: readonly InternalSessionRule[]
  readonly sandboxContracts: readonly InternalSandboxRule[]
  readonly observePreconditions: readonly InternalPrecondition[]
  readonly observePostconditions: readonly InternalPostcondition[]
  readonly observeSessionContracts: readonly InternalSessionRule[]
  readonly observeSandboxContracts: readonly InternalSandboxRule[]
  readonly limits: OperationLimits
  readonly policyVersion: string | null
}

export function createCompiledState(partial: Partial<CompiledState> = {}): CompiledState {
  return deepFreeze({
    preconditions: partial.preconditions ?? [],
    postconditions: partial.postconditions ?? [],
    sessionContracts: partial.sessionContracts ?? [],
    sandboxContracts: partial.sandboxContracts ?? [],
    observePreconditions: partial.observePreconditions ?? [],
    observePostconditions: partial.observePostconditions ?? [],
    observeSessionContracts: partial.observeSessionContracts ?? [],
    observeSandboxContracts: partial.observeSandboxContracts ?? [],
    limits: partial.limits ?? DEFAULT_LIMITS,
    policyVersion: partial.policyVersion ?? null,
  })
}
