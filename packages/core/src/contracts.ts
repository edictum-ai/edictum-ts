/** Pre/Post Conditions — contract types for tool governance. */

import type { ToolEnvelope } from './envelope.js'
import type { Session } from './session.js'

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** Outcome of a single contract check. */
export interface Verdict {
  readonly passed: boolean
  readonly message: string | null
  readonly metadata: Readonly<Record<string, unknown>>
}

/** Factory methods for Verdict. */
export const Verdict = {
  /**
   * Contract passed — tool call is acceptable.
   */
  pass_(): Verdict {
    return Object.freeze({ passed: true, message: null, metadata: Object.freeze({}) })
  },

  /**
   * Contract failed with an actionable message (truncated to 500 chars).
   *
   * Make it SPECIFIC and INSTRUCTIVE — the agent uses it to self-correct.
   */
  fail(message: string, metadata: Record<string, unknown> = {}): Verdict {
    const truncated = message.length > 500 ? message.slice(0, 497) + '...' : message
    return Object.freeze({
      passed: false,
      message: truncated,
      metadata: Object.freeze({ ...metadata }),
    })
  },
}

// ---------------------------------------------------------------------------
// Contract interfaces — plain objects, not decorators
// ---------------------------------------------------------------------------

/** Before execution. Safe to deny — tool hasn't run yet. */
export interface Precondition {
  readonly contractType?: 'pre'
  readonly tool: string
  readonly check: (envelope: ToolEnvelope) => Verdict | Promise<Verdict>
  readonly when?: ((envelope: ToolEnvelope) => boolean) | null
}

/**
 * After execution. Observe-and-log.
 *
 * On failure for pure/read: inject context suggesting retry.
 * On failure for write/irreversible: warn only, NO retry coaching.
 */
export interface Postcondition {
  readonly contractType: 'post'
  readonly tool: string
  readonly check: (envelope: ToolEnvelope, response: unknown) => Verdict | Promise<Verdict>
  readonly when?: ((envelope: ToolEnvelope) => boolean) | null
}

/**
 * Cross-turn governance using persisted atomic counters.
 *
 * Session methods are ASYNC. Session contract checks must be async.
 *
 * Example:
 * ```typescript
 * const maxOperations: SessionContract = {
 *   check: async (session) => {
 *     const count = await session.executionCount();
 *     if (count >= 200) {
 *       return Verdict.fail("Session limit reached.");
 *     }
 *     return Verdict.pass_();
 *   },
 * };
 * ```
 */
export interface SessionContract {
  readonly check: (session: Session) => Verdict | Promise<Verdict>
}
