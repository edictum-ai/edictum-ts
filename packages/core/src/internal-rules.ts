/**
 * Internal rule representations used by GuardLike and CheckPipeline.
 *
 * User-facing types (Precondition, Postcondition, SessionRule) are plain
 * objects optimized for DX. These internal types carry the metadata the
 * pipeline needs (name, mode, source, effect, timeout) that Python stores
 * as _edictum_* function attributes.
 *
 * The Guard class converts user rules → internal rules at construction.
 * The YAML compiler produces internal rules directly.
 */

import type { ToolCall } from './tool-call.js'
import type { OperationLimits } from './limits.js'
import type { Session } from './session.js'
import type { Decision } from './rules.js'
import type { HookRegistration } from './types.js'

// ---------------------------------------------------------------------------
// Internal rule types
// ---------------------------------------------------------------------------

interface InternalContractBase {
  readonly name: string
  readonly mode?: 'enforce' | 'observe'
  readonly source?: string
}

/** Internal precondition — enriched with pipeline metadata. */
export interface InternalPrecondition extends InternalContractBase {
  readonly type: 'precondition'
  readonly tool: string
  readonly check: (toolCall: ToolCall) => Decision | Promise<Decision>
  readonly when?: ((toolCall: ToolCall) => boolean) | null
  readonly effect?: 'deny' | 'approve'
  readonly timeout?: number
  readonly timeoutEffect?: 'deny' | 'allow'
}

/** Internal postcondition — enriched with effect and redaction info. */
export interface InternalPostcondition extends InternalContractBase {
  readonly type: 'postcondition'
  readonly tool: string
  readonly check: (toolCall: ToolCall, response: unknown) => Decision | Promise<Decision>
  readonly when?: ((toolCall: ToolCall) => boolean) | null
  readonly effect?: 'warn' | 'redact' | 'deny'
  readonly redactPatterns?: readonly RegExp[]
}

/** Internal session rule. */
export interface InternalSessionRule extends InternalContractBase {
  readonly type: 'session_contract'
  readonly check: (session: Session) => Decision | Promise<Decision>
}

/** Internal sandbox rule — tool matching uses tools[] not tool. */
export interface InternalSandboxRule extends InternalContractBase {
  readonly type: 'sandbox'
  readonly tools: readonly string[]
  readonly check: (toolCall: ToolCall) => Decision | Promise<Decision>
  readonly effect?: 'deny' | 'approve'
  readonly timeout?: number
  readonly timeoutEffect?: 'deny' | 'allow'
}

/** Union of all internal rule types. */
export type InternalRule =
  | InternalPrecondition
  | InternalPostcondition
  | InternalSessionRule
  | InternalSandboxRule

// ---------------------------------------------------------------------------
// GuardLike — interface the pipeline depends on
// ---------------------------------------------------------------------------

/**
 * Interface representing what the CheckPipeline needs from the Guard.
 *
 * Decouples pipeline from concrete Guard class for testability.
 * The real Edictum class implements this.
 */
export interface GuardLike {
  readonly limits: OperationLimits

  // Enforce-mode rule accessors
  getHooks(phase: 'before' | 'after', toolCall: ToolCall): HookRegistration[]
  getPreconditions(toolCall: ToolCall): InternalPrecondition[]
  getPostconditions(toolCall: ToolCall): InternalPostcondition[]
  getSessionContracts(): InternalSessionRule[]
  getSandboxContracts(toolCall: ToolCall): InternalSandboxRule[]

  // Observe-mode rule accessors
  getObservePreconditions(toolCall: ToolCall): InternalPrecondition[]
  getObservePostconditions(toolCall: ToolCall): InternalPostcondition[]
  getObserveSandboxContracts(toolCall: ToolCall): InternalSandboxRule[]
  getObserveSessionContracts(): InternalSessionRule[]
}
