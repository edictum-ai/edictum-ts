/** Operation Limits — tool call and attempt caps. */

/**
 * Operation limits for an agent session.
 *
 * Two counter types:
 * - maxAttempts: caps ALL PreToolUse events (including denied)
 * - maxToolCalls: caps EXECUTIONS only (PostToolUse)
 *
 * Both are checked. Whichever fires first wins.
 */
export interface OperationLimits {
  readonly maxAttempts: number;
  readonly maxToolCalls: number;
  readonly maxCallsPerTool: Readonly<Record<string, number>>;
}

export const DEFAULT_LIMITS: OperationLimits = Object.freeze({
  maxAttempts: 500,
  maxToolCalls: 200,
  maxCallsPerTool: Object.freeze({}),
});
