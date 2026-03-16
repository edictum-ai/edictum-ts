/** Contract compilation — compile individual YAML contracts into callable objects. */

import { Verdict } from "../contracts.js";
import type { ToolEnvelope } from "../envelope.js";
import { EdictumConfigError } from "../errors.js";
import type { OperationLimits } from "../limits.js";
import type { Session } from "../session.js";
import { evaluateExpression, PolicyError, type CustomOperator, type CustomSelector } from "./evaluator.js";
import { expandMessage, extractOutputPatterns, precompileRegexes } from "./compiler-utils.js";

/** Shared evaluation logic for pre/post check functions. */
function _evalAndVerdict(
  whenExpr: Record<string, unknown>,
  envelope: ToolEnvelope,
  outputText: string | null | undefined,
  messageTemplate: string,
  tags: string[],
  thenMetadata: Record<string, unknown>,
  customOps: Readonly<Record<string, CustomOperator>> | null,
  customSels: Readonly<Record<string, CustomSelector>> | null,
): Verdict {
  try {
    const result = evaluateExpression(whenExpr, envelope, outputText, {
      customOperators: customOps, customSelectors: customSels,
    });
    if (result instanceof PolicyError) {
      const msg = expandMessage(messageTemplate, envelope, outputText, customSels);
      return Verdict.fail(msg, { tags, policyError: true, ...thenMetadata });
    }
    if (result) {
      const msg = expandMessage(messageTemplate, envelope, outputText, customSels);
      return Verdict.fail(msg, { tags, ...thenMetadata });
    }
    return Verdict.pass_();
  } catch (exc) {
    const msg = expandMessage(messageTemplate, envelope, outputText, customSels);
    return Verdict.fail(msg, { tags, policyError: true, errorDetail: String(exc), ...thenMetadata });
  }
}

/** Stamp _edictum_observe on the result if the contract is in observe mode. */
function _maybeObserve(result: Record<string, unknown>, contract: Record<string, unknown>): void {
  if (contract._observe === true || contract._shadow === true) result._edictum_observe = true;
}

// ---------------------------------------------------------------------------
// Pre-contract compilation
// ---------------------------------------------------------------------------

export function compilePre(
  contract: Record<string, unknown>, mode: string,
  customOps: Readonly<Record<string, CustomOperator>> | null,
  customSels: Readonly<Record<string, CustomSelector>> | null,
): Record<string, unknown> {
  const contractId = contract.id as string;
  const tool = contract.tool as string;
  const whenExpr = precompileRegexes(contract.when) as Record<string, unknown>;
  const then = contract.then as Record<string, unknown>;
  const msgTpl = then.message as string;
  const tags = (then.tags ?? []) as string[];
  const meta = (then.metadata ?? {}) as Record<string, unknown>;

  const check = (envelope: ToolEnvelope): Verdict =>
    _evalAndVerdict(whenExpr, envelope, undefined, msgTpl, tags, meta, customOps, customSels);

  const result: Record<string, unknown> = {
    check, name: contractId, tool, type: "precondition",
    mode: mode as "enforce" | "observe",
    _edictum_type: "precondition", _edictum_tool: tool, _edictum_when: null,
    _edictum_mode: mode, _edictum_id: contractId, _edictum_source: "yaml_precondition",
    _edictum_effect: (then.effect as string) ?? "deny",
    _edictum_timeout: (then.timeout as number) ?? 300,
    _edictum_timeout_effect: (then.timeout_effect as string) ?? "deny",
  };
  _maybeObserve(result, contract);
  return result;
}

// ---------------------------------------------------------------------------
// Post-contract compilation
// ---------------------------------------------------------------------------

export function compilePost(
  contract: Record<string, unknown>, mode: string,
  customOps: Readonly<Record<string, CustomOperator>> | null,
  customSels: Readonly<Record<string, CustomSelector>> | null,
): Record<string, unknown> {
  const contractId = contract.id as string;
  const tool = contract.tool as string;
  const whenExpr = precompileRegexes(contract.when) as Record<string, unknown>;
  const then = contract.then as Record<string, unknown>;
  const msgTpl = then.message as string;
  const tags = (then.tags ?? []) as string[];
  const meta = (then.metadata ?? {}) as Record<string, unknown>;

  const check = (envelope: ToolEnvelope, response: unknown): Verdict => {
    const outputText = response != null ? String(response) : undefined;
    return _evalAndVerdict(whenExpr, envelope, outputText, msgTpl, tags, meta, customOps, customSels);
  };

  const effectValue = (then.effect as string) ?? "warn";
  const result: Record<string, unknown> = {
    check, name: contractId, tool, type: "postcondition",
    mode: mode as "enforce" | "observe",
    effect: effectValue,
    _edictum_type: "postcondition", _edictum_tool: tool, _edictum_when: null,
    _edictum_mode: mode, _edictum_id: contractId, _edictum_source: "yaml_postcondition",
    _edictum_effect: effectValue,
    _edictum_redact_patterns: extractOutputPatterns(whenExpr),
  };
  _maybeObserve(result, contract);
  return result;
}

// ---------------------------------------------------------------------------
// Session contract compilation
// ---------------------------------------------------------------------------

export function compileSession(
  contract: Record<string, unknown>,
  mode: string,
  limits: OperationLimits,
): Record<string, unknown> {
  const contractId = contract.id as string;
  const then = contract.then as Record<string, unknown>;
  const messageTemplate = then.message as string;
  const tags = (then.tags ?? []) as string[];
  const thenMetadata = (then.metadata ?? {}) as Record<string, unknown>;
  const capturedLimits = { ...limits };

  const check = async (session: Session): Promise<Verdict> => {
    const execCount = await session.executionCount();
    if (execCount >= capturedLimits.maxToolCalls) {
      return Verdict.fail(messageTemplate, { tags, ...thenMetadata });
    }
    const attemptCount = await session.attemptCount();
    if (attemptCount >= capturedLimits.maxAttempts) {
      return Verdict.fail(messageTemplate, { tags, ...thenMetadata });
    }
    return Verdict.pass_();
  };

  const result: Record<string, unknown> = {
    check, name: contractId, type: "session_contract",
    _edictum_type: "session_contract",
    _edictum_mode: mode,
    _edictum_id: contractId,
    _edictum_message: messageTemplate,
    _edictum_tags: tags,
    _edictum_then_metadata: thenMetadata,
    _edictum_source: "yaml_session",
  };
  if (contract._observe === true || contract._shadow === true) {
    result._edictum_observe = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Session limits merging
// ---------------------------------------------------------------------------

/**
 * Merge session contract limits into existing OperationLimits.
 * Picks the more restrictive value (lower) for each limit.
 */
export function mergeSessionLimits(
  contract: Record<string, unknown>,
  existing: OperationLimits,
): OperationLimits {
  const sessionLimits = contract.limits as Record<string, unknown>;
  let maxToolCalls = existing.maxToolCalls;
  let maxAttempts = existing.maxAttempts;
  const maxCallsPerTool: Record<string, number> = { ...existing.maxCallsPerTool };

  if ("max_tool_calls" in sessionLimits) {
    const raw = sessionLimits.max_tool_calls;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new EdictumConfigError(`Session limit max_tool_calls must be a finite number, got: ${String(raw)}`);
    }
    maxToolCalls = Math.min(maxToolCalls, raw);
  }
  if ("max_attempts" in sessionLimits) {
    const raw = sessionLimits.max_attempts;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new EdictumConfigError(`Session limit max_attempts must be a finite number, got: ${String(raw)}`);
    }
    maxAttempts = Math.min(maxAttempts, raw);
  }
  if ("max_calls_per_tool" in sessionLimits) {
    const perTool = sessionLimits.max_calls_per_tool as Record<string, unknown>;
    for (const [tool, limit] of Object.entries(perTool)) {
      if (typeof limit !== "number" || !Number.isFinite(limit)) {
        throw new EdictumConfigError(
          `Session limit max_calls_per_tool['${tool}'] must be a finite number, got: ${String(limit)}`,
        );
      }
      if (Object.hasOwn(maxCallsPerTool, tool)) {
        maxCallsPerTool[tool] = Math.min(maxCallsPerTool[tool] as number, limit);
      } else {
        maxCallsPerTool[tool] = limit;
      }
    }
  }
  return { maxAttempts, maxToolCalls, maxCallsPerTool };
}
