/** Pre/Post Conditions — rule types for tool governance. */

import type { ToolCall } from './tool-call.js'
import type { Session } from './session.js'

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Outcome of a single rule check. */
export interface Decision {
  readonly passed: boolean
  readonly message: string | null
  readonly metadata: Readonly<Record<string, unknown>>
}

/** Factory methods for Decision. */
export const Decision = {
  /**
   * Rule passed — tool call is acceptable.
   */
  pass_(): Decision {
    return Object.freeze({ passed: true, message: null, metadata: Object.freeze({}) })
  },

  /**
   * Rule failed with an actionable message (truncated to 500 chars).
   *
   * Make it SPECIFIC and INSTRUCTIVE — the agent uses it to self-correct.
   */
  fail(message: string, metadata: Record<string, unknown> = {}): Decision {
    const truncated = message.length > 500 ? message.slice(0, 497) + '...' : message
    return Object.freeze({
      passed: false,
      message: truncated,
      metadata: Object.freeze({ ...metadata }),
    })
  },
}

// ---------------------------------------------------------------------------
// Rule interfaces — plain objects, not decorators
// ---------------------------------------------------------------------------

/** Before execution. Safe to deny — tool hasn't run yet. */
export interface Precondition {
  readonly contractType?: 'pre'
  readonly tool: string
  readonly check: (toolCall: ToolCall) => Decision | Promise<Decision>
  readonly when?: ((toolCall: ToolCall) => boolean) | null
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
  readonly check: (toolCall: ToolCall, response: unknown) => Decision | Promise<Decision>
  readonly when?: ((toolCall: ToolCall) => boolean) | null
}

/**
 * Cross-turn governance using persisted atomic counters.
 *
 * Session methods are ASYNC. Session rule checks must be async.
 *
 * Example:
 * ```typescript
 * const maxOperations: SessionRule = {
 *   check: async (session) => {
 *     const count = await session.executionCount();
 *     if (count >= 200) {
 *       return Decision.fail("Session limit reached.");
 *     }
 *     return Decision.pass_();
 *   },
 * };
 * ```
 */
export interface SessionRule {
  readonly check: (session: Session) => Decision | Promise<Decision>
}
