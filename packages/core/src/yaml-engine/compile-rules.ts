/** Rule compilation — compile individual YAML rules into callable objects. */

import { Decision } from '../rules.js'
import type { ToolCall } from '../tool-call.js'
import { EdictumConfigError } from '../errors.js'
import type { OperationLimits } from '../limits.js'
import type { Session } from '../session.js'
import {
  evaluateExpression,
  PolicyError,
  type CustomOperator,
  type CustomSelector,
} from './evaluator.js'
import { expandMessage, extractOutputPatterns, precompileRegexes } from './compiler-utils.js'

/**
 * Map YAML action values to internal effect values.
 * YAML uses: block, ask, warn, redact
 * Internal pipeline uses: deny, approve, warn, redact
 */
function mapAction(action: string): string {
  if (action === 'block') return 'deny'
  if (action === 'ask') return 'approve'
  return action // warn, redact pass through
}

/** Shared evaluation logic for pre/post check functions. */
function _evalAndVerdict(
  whenExpr: Record<string, unknown>,
  toolCall: ToolCall,
  outputText: string | null | undefined,
  messageTemplate: string,
  tags: string[],
  thenMetadata: Record<string, unknown>,
  customOps: Readonly<Record<string, CustomOperator>> | null,
  customSels: Readonly<Record<string, CustomSelector>> | null,
): Decision {
  try {
    const result = evaluateExpression(whenExpr, toolCall, outputText, {
      customOperators: customOps,
      customSelectors: customSels,
    })
    if (result instanceof PolicyError) {
      const msg = expandMessage(messageTemplate, toolCall, outputText, customSels)
      return Decision.fail(msg, { tags, policyError: true, ...thenMetadata })
    }
    if (result) {
      const msg = expandMessage(messageTemplate, toolCall, outputText, customSels)
      return Decision.fail(msg, { tags, ...thenMetadata })
    }
    return Decision.pass_()
  } catch (exc) {
    const msg = expandMessage(messageTemplate, toolCall, outputText, customSels)
    return Decision.fail(msg, {
      tags,
      policyError: true,
      errorDetail: String(exc),
      ...thenMetadata,
    })
  }
}

/** Stamp _edictum_observe on the result if the rule is in observe mode. */
function _maybeObserve(result: Record<string, unknown>, rule: Record<string, unknown>): void {
  if (rule._observe === true || rule._shadow === true) result._edictum_observe = true
}

// ---------------------------------------------------------------------------
// Pre-rule compilation
// ---------------------------------------------------------------------------

export function compilePre(
  rule: Record<string, unknown>,
  mode: string,
  customOps: Readonly<Record<string, CustomOperator>> | null,
  customSels: Readonly<Record<string, CustomSelector>> | null,
): Record<string, unknown> {
  const ruleId = rule.id as string
  const tool = rule.tool as string
  const whenExpr = precompileRegexes(rule.when) as Record<string, unknown>
  const then = rule.then as Record<string, unknown>
  const msgTpl = then.message as string
  const tags = (then.tags ?? []) as string[]
  const meta = (then.metadata ?? {}) as Record<string, unknown>

  const check = (toolCall: ToolCall): Decision =>
    _evalAndVerdict(whenExpr, toolCall, undefined, msgTpl, tags, meta, customOps, customSels)

  const internalEffect = mapAction((then.action as string) ?? 'block')
  const internalTimeoutEffect = mapAction((then.timeout_action as string) ?? 'block')
  const result: Record<string, unknown> = {
    check,
    name: ruleId,
    tool,
    type: 'precondition',
    mode: mode as 'enforce' | 'observe',
    effect: internalEffect,
    timeout: (then.timeout as number) ?? 300,
    timeoutEffect: internalTimeoutEffect,
    _edictum_type: 'precondition',
    _edictum_tool: tool,
    _edictum_when: null,
    _edictum_mode: mode,
    _edictum_id: ruleId,
    _edictum_source: 'yaml_precondition',
    _edictum_effect: internalEffect,
    _edictum_timeout: (then.timeout as number) ?? 300,
    _edictum_timeout_action: internalTimeoutEffect,
  }
  _maybeObserve(result, rule)
  return result
}

// ---------------------------------------------------------------------------
// Post-rule compilation
// ---------------------------------------------------------------------------

export function compilePost(
  rule: Record<string, unknown>,
  mode: string,
  customOps: Readonly<Record<string, CustomOperator>> | null,
  customSels: Readonly<Record<string, CustomSelector>> | null,
): Record<string, unknown> {
  const ruleId = rule.id as string
  const tool = rule.tool as string
  const whenExpr = precompileRegexes(rule.when) as Record<string, unknown>
  const then = rule.then as Record<string, unknown>
  const msgTpl = then.message as string
  const tags = (then.tags ?? []) as string[]
  const meta = (then.metadata ?? {}) as Record<string, unknown>

  const check = (toolCall: ToolCall, response: unknown): Decision => {
    const outputText = response != null ? String(response) : undefined
    return _evalAndVerdict(
      whenExpr,
      toolCall,
      outputText,
      msgTpl,
      tags,
      meta,
      customOps,
      customSels,
    )
  }

  const effectValue = mapAction((then.action as string) ?? 'warn')
  const result: Record<string, unknown> = {
    check,
    name: ruleId,
    tool,
    type: 'postcondition',
    mode: mode as 'enforce' | 'observe',
    effect: effectValue,
    _edictum_type: 'postcondition',
    _edictum_tool: tool,
    _edictum_when: null,
    _edictum_mode: mode,
    _edictum_id: ruleId,
    _edictum_source: 'yaml_postcondition',
    _edictum_effect: effectValue,
    _edictum_redact_patterns: extractOutputPatterns(whenExpr),
  }
  _maybeObserve(result, rule)
  return result
}

// ---------------------------------------------------------------------------
// Session rule compilation
// ---------------------------------------------------------------------------

export function compileSession(
  rule: Record<string, unknown>,
  mode: string,
  limits: OperationLimits,
): Record<string, unknown> {
  const ruleId = rule.id as string
  const then = rule.then as Record<string, unknown>
  const messageTemplate = then.message as string
  const tags = (then.tags ?? []) as string[]
  const thenMetadata = (then.metadata ?? {}) as Record<string, unknown>
  const capturedLimits = { ...limits }

  const check = async (session: Session): Promise<Decision> => {
    const execCount = await session.executionCount()
    if (execCount >= capturedLimits.maxToolCalls) {
      return Decision.fail(messageTemplate, { tags, ...thenMetadata })
    }
    const attemptCount = await session.attemptCount()
    if (attemptCount >= capturedLimits.maxAttempts) {
      return Decision.fail(messageTemplate, { tags, ...thenMetadata })
    }
    return Decision.pass_()
  }

  const result: Record<string, unknown> = {
    check,
    name: ruleId,
    type: 'session_contract',
    _edictum_type: 'session_contract',
    _edictum_mode: mode,
    _edictum_id: ruleId,
    _edictum_message: messageTemplate,
    _edictum_tags: tags,
    _edictum_then_metadata: thenMetadata,
    _edictum_source: 'yaml_session',
  }
  if (rule._observe === true || rule._shadow === true) {
    result._edictum_observe = true
  }
  return result
}

// ---------------------------------------------------------------------------
// Session limits merging
// ---------------------------------------------------------------------------

/**
 * Merge session rule limits into existing OperationLimits.
 * Picks the more restrictive value (lower) for each limit.
 */
export function mergeSessionLimits(
  rule: Record<string, unknown>,
  existing: OperationLimits,
): OperationLimits {
  const sessionLimits = rule.limits as Record<string, unknown>
  let maxToolCalls = existing.maxToolCalls
  let maxAttempts = existing.maxAttempts
  const maxCallsPerTool: Record<string, number> = { ...existing.maxCallsPerTool }

  if ('max_tool_calls' in sessionLimits) {
    const raw = sessionLimits.max_tool_calls
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new EdictumConfigError(
        `Session limit max_tool_calls must be a finite number, got: ${String(raw)}`,
      )
    }
    maxToolCalls = Math.min(maxToolCalls, raw)
  }
  if ('max_attempts' in sessionLimits) {
    const raw = sessionLimits.max_attempts
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new EdictumConfigError(
        `Session limit max_attempts must be a finite number, got: ${String(raw)}`,
      )
    }
    maxAttempts = Math.min(maxAttempts, raw)
  }
  if ('max_calls_per_tool' in sessionLimits) {
    const perTool = sessionLimits.max_calls_per_tool as Record<string, unknown>
    for (const [tool, limit] of Object.entries(perTool)) {
      if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        throw new EdictumConfigError(
          `Session limit max_calls_per_tool['${tool}'] must be a finite number, got: ${String(limit)}`,
        )
      }
      if (Object.hasOwn(maxCallsPerTool, tool)) {
        maxCallsPerTool[tool] = Math.min(maxCallsPerTool[tool] as number, limit)
      } else {
        maxCallsPerTool[tool] = limit
      }
    }
  }
  return { maxAttempts, maxToolCalls, maxCallsPerTool }
}
