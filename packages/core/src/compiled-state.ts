/**
 * _CompiledState -- frozen snapshot of compiled contracts.
 *
 * All contract lists are readonly arrays (frozen). The entire state is
 * replaced atomically via a single reference assignment in reload(),
 * ensuring concurrent evaluations never see a mix of old and new
 * contracts.
 */

import { deepFreeze } from './envelope.js'
import type {
  InternalPrecondition,
  InternalPostcondition,
  InternalSessionContract,
  InternalSandboxContract,
} from './internal-contracts.js'
import { DEFAULT_LIMITS } from './limits.js'
import type { OperationLimits } from './limits.js'

export interface CompiledState {
  readonly preconditions: readonly InternalPrecondition[]
  readonly postconditions: readonly InternalPostcondition[]
  readonly sessionContracts: readonly InternalSessionContract[]
  readonly sandboxContracts: readonly InternalSandboxContract[]
  readonly observePreconditions: readonly InternalPrecondition[]
  readonly observePostconditions: readonly InternalPostcondition[]
  readonly observeSessionContracts: readonly InternalSessionContract[]
  readonly observeSandboxContracts: readonly InternalSandboxContract[]
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
