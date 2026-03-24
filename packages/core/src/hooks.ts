/** Hook interception — before/after tool execution. */

export const HookResult = {
  ALLOW: 'allow',
  DENY: 'deny',
} as const

export type HookResult = (typeof HookResult)[keyof typeof HookResult]

export interface HookDecision {
  readonly result: HookResult
  readonly reason: string | null
}

export const HookDecision = {
  allow(): HookDecision {
    return Object.freeze({ result: HookResult.ALLOW, reason: null })
  },

  deny(reason: string): HookDecision {
    const truncated = reason.length > 500 ? reason.slice(0, 497) + '...' : reason
    return Object.freeze({ result: HookResult.DENY, reason: truncated })
  },
}
