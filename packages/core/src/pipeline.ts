/** GovernancePipeline -- single source of governance logic. */

import { Verdict } from "./contracts.js";
import { SideEffect } from "./envelope.js";
import type { ToolEnvelope } from "./envelope.js";
import { HookDecision, HookResult } from "./hooks.js";
import { RedactionPolicy } from "./redaction.js";
import type { Session } from "./session.js";
import type { GuardLike } from "./internal-contracts.js";

// ---------------------------------------------------------------------------
// PreDecision
// ---------------------------------------------------------------------------

/** Result of pre-execution governance evaluation. */
export interface PreDecision {
  readonly action: "allow" | "deny" | "pending_approval";
  readonly reason: string | null;
  readonly decisionSource: string | null;
  readonly decisionName: string | null;
  readonly hooksEvaluated: Record<string, unknown>[];
  readonly contractsEvaluated: Record<string, unknown>[];
  readonly observed: boolean;
  readonly policyError: boolean;
  readonly observeResults: Record<string, unknown>[];
  readonly approvalTimeout: number;
  readonly approvalTimeoutEffect: string;
  readonly approvalMessage: string | null;
}

/** Create a PreDecision with defaults for omitted fields. */
export function createPreDecision(
  partial: Partial<PreDecision> & Pick<PreDecision, "action">,
): PreDecision {
  return {
    action: partial.action,
    reason: partial.reason ?? null,
    decisionSource: partial.decisionSource ?? null,
    decisionName: partial.decisionName ?? null,
    hooksEvaluated: partial.hooksEvaluated ?? [],
    contractsEvaluated: partial.contractsEvaluated ?? [],
    observed: partial.observed ?? false,
    policyError: partial.policyError ?? false,
    observeResults: partial.observeResults ?? [],
    approvalTimeout: partial.approvalTimeout ?? 300,
    approvalTimeoutEffect: partial.approvalTimeoutEffect ?? "deny",
    approvalMessage: partial.approvalMessage ?? null,
  };
}

// ---------------------------------------------------------------------------
// PostDecision
// ---------------------------------------------------------------------------

/** Result of post-execution governance evaluation. */
export interface PostDecision {
  readonly toolSuccess: boolean;
  readonly postconditionsPassed: boolean;
  readonly warnings: string[];
  readonly contractsEvaluated: Record<string, unknown>[];
  readonly policyError: boolean;
  readonly redactedResponse: unknown;
  readonly outputSuppressed: boolean;
}

/** Create a PostDecision with defaults for omitted fields. */
export function createPostDecision(
  partial: Partial<PostDecision> & Pick<PostDecision, "toolSuccess">,
): PostDecision {
  return {
    toolSuccess: partial.toolSuccess,
    postconditionsPassed: partial.postconditionsPassed ?? true,
    warnings: partial.warnings ?? [],
    contractsEvaluated: partial.contractsEvaluated ?? [],
    policyError: partial.policyError ?? false,
    redactedResponse: partial.redactedResponse ?? null,
    outputSuppressed: partial.outputSuppressed ?? false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if any evaluated contract record has a policy_error in metadata. */
function hasPolicyError(
  contractsEvaluated: Record<string, unknown>[],
): boolean {
  return contractsEvaluated.some((c) => {
    const meta = c["metadata"] as Record<string, unknown> | undefined;
    return meta?.["policy_error"] === true;
  });
}

// ---------------------------------------------------------------------------
// GovernancePipeline
// ---------------------------------------------------------------------------

/**
 * Orchestrates all governance checks.
 *
 * This is the single source of truth for governance logic.
 * Adapters call preExecute() and postExecute(), then translate
 * the structured results into framework-specific formats.
 */
export class GovernancePipeline {
  private readonly _guard: GuardLike;

  constructor(guard: GuardLike) {
    this._guard = guard;
  }

  async preExecute(
    envelope: ToolEnvelope,
    session: Session,
  ): Promise<PreDecision> {
    const hooksEvaluated: Record<string, unknown>[] = [];
    const contractsEvaluated: Record<string, unknown>[] = [];
    let hasObservedDeny = false;

    // Pre-fetch session counters in a single batch to reduce HTTP
    // round trips when using ServerBackend.  The tool-specific key
    // is included only when a per-tool limit is configured.
    let toolNameForBatch: string | undefined;
    if (envelope.toolName in this._guard.limits.maxCallsPerTool) {
      toolNameForBatch = envelope.toolName;
    }
    const counters = await session.batchGetCounters({
      includeTool: toolNameForBatch,
    });

    // 1. Attempt limit
    const attemptCount = counters["attempts"] ?? 0;
    if (attemptCount >= this._guard.limits.maxAttempts) {
      return createPreDecision({
        action: "deny",
        reason:
          `Attempt limit reached (${this._guard.limits.maxAttempts}). ` +
          "Agent may be stuck in a retry loop. Stop and reassess.",
        decisionSource: "attempt_limit",
        decisionName: "max_attempts",
        hooksEvaluated,
        contractsEvaluated,
      });
    }

    // 2. Before hooks (catch exceptions)
    for (const hookReg of this._guard.getHooks("before", envelope)) {
      if (hookReg.when && !hookReg.when(envelope)) {
        continue;
      }
      let decision: HookDecision;
      try {
        decision = await hookReg.callback(envelope);
      } catch (exc) {
        decision = HookDecision.deny(`Hook error: ${exc}`);
      }

      const hookRecord: Record<string, unknown> = {
        name:
          hookReg.callback.name || "anonymous",
        result: decision.result,
        reason: decision.reason,
      };
      hooksEvaluated.push(hookRecord);

      if (decision.result === HookResult.DENY) {
        return createPreDecision({
          action: "deny",
          reason: decision.reason,
          decisionSource: "hook",
          decisionName: hookRecord["name"] as string,
          hooksEvaluated,
          contractsEvaluated,
          policyError: (decision.reason ?? "").includes("Hook error:"),
        });
      }
    }

    // 3. Preconditions (catch exceptions)
    for (const contract of this._guard.getPreconditions(envelope)) {
      let verdict: Verdict;
      try {
        verdict = await contract.check(envelope);
      } catch (exc) {
        verdict = Verdict.fail(`Precondition error: ${exc}`, {
          policy_error: true,
        });
      }

      const contractRecord: Record<string, unknown> = {
        name: contract.name,
        type: "precondition",
        passed: verdict.passed,
        message: verdict.message,
      };
      if (
        verdict.metadata &&
        Object.keys(verdict.metadata).length > 0
      ) {
        contractRecord["metadata"] = verdict.metadata;
      }
      contractsEvaluated.push(contractRecord);

      if (!verdict.passed) {
        // Per-contract observe mode: record but don't deny
        if (contract.mode === "observe") {
          contractRecord["observed"] = true;
          hasObservedDeny = true;
          continue;
        }

        const source = contract.source ?? "precondition";
        const pe = hasPolicyError(contractsEvaluated);

        const effect = contract.effect ?? "deny";
        if (effect === "approve") {
          return createPreDecision({
            action: "pending_approval",
            reason: verdict.message,
            decisionSource: source,
            decisionName: contract.name,
            hooksEvaluated,
            contractsEvaluated,
            policyError: pe,
            approvalTimeout: contract.timeout ?? 300,
            approvalTimeoutEffect: contract.timeoutEffect ?? "deny",
            approvalMessage: verdict.message,
          });
        }

        return createPreDecision({
          action: "deny",
          reason: verdict.message,
          decisionSource: source,
          decisionName: contract.name,
          hooksEvaluated,
          contractsEvaluated,
          policyError: pe,
        });
      }
    }

    // 3.5. Sandbox contracts
    for (const contract of this._guard.getSandboxContracts(envelope)) {
      let verdict: Verdict;
      try {
        verdict = await contract.check(envelope);
      } catch (exc) {
        verdict = Verdict.fail(`Sandbox contract error: ${exc}`, {
          policy_error: true,
        });
      }

      const contractRecord: Record<string, unknown> = {
        name: contract.name,
        type: "sandbox",
        passed: verdict.passed,
        message: verdict.message,
      };
      if (
        verdict.metadata &&
        Object.keys(verdict.metadata).length > 0
      ) {
        contractRecord["metadata"] = verdict.metadata;
      }
      contractsEvaluated.push(contractRecord);

      if (!verdict.passed) {
        if (contract.mode === "observe") {
          contractRecord["observed"] = true;
          hasObservedDeny = true;
          continue;
        }

        const source = contract.source ?? "yaml_sandbox";
        const pe = hasPolicyError(contractsEvaluated);

        const effect = contract.effect ?? "deny";
        if (effect === "approve") {
          return createPreDecision({
            action: "pending_approval",
            reason: verdict.message,
            decisionSource: source,
            decisionName: contract.name,
            hooksEvaluated,
            contractsEvaluated,
            policyError: pe,
            approvalTimeout: contract.timeout ?? 300,
            approvalTimeoutEffect: contract.timeoutEffect ?? "deny",
            approvalMessage: verdict.message,
          });
        }

        return createPreDecision({
          action: "deny",
          reason: verdict.message,
          decisionSource: source,
          decisionName: contract.name,
          hooksEvaluated,
          contractsEvaluated,
          policyError: pe,
        });
      }
    }

    // 4. Session contracts (catch exceptions)
    for (const contract of this._guard.getSessionContracts()) {
      let verdict: Verdict;
      try {
        verdict = await contract.check(session);
      } catch (exc) {
        verdict = Verdict.fail(`Session contract error: ${exc}`, {
          policy_error: true,
        });
      }

      const contractRecord: Record<string, unknown> = {
        name: contract.name,
        type: "session_contract",
        passed: verdict.passed,
        message: verdict.message,
      };
      if (
        verdict.metadata &&
        Object.keys(verdict.metadata).length > 0
      ) {
        contractRecord["metadata"] = verdict.metadata;
      }
      contractsEvaluated.push(contractRecord);

      if (!verdict.passed) {
        const source = contract.source ?? "session_contract";
        const pe = hasPolicyError(contractsEvaluated);
        return createPreDecision({
          action: "deny",
          reason: verdict.message,
          decisionSource: source,
          decisionName: contract.name,
          hooksEvaluated,
          contractsEvaluated,
          policyError: pe,
        });
      }
    }

    // 5. Execution limits (use pre-fetched counters)
    const execCount = counters["execs"] ?? 0;
    if (execCount >= this._guard.limits.maxToolCalls) {
      return createPreDecision({
        action: "deny",
        reason:
          `Execution limit reached (${this._guard.limits.maxToolCalls} calls). ` +
          "Summarize progress and stop.",
        decisionSource: "operation_limit",
        decisionName: "max_tool_calls",
        hooksEvaluated,
        contractsEvaluated,
      });
    }

    // Per-tool limits (use pre-fetched counter when available)
    if (envelope.toolName in this._guard.limits.maxCallsPerTool) {
      const toolKey = `tool:${envelope.toolName}`;
      const toolCount = counters[toolKey] ?? 0;
      const toolLimit =
        this._guard.limits.maxCallsPerTool[envelope.toolName] ?? 0;
      if (toolCount >= toolLimit) {
        return createPreDecision({
          action: "deny",
          reason:
            `Per-tool limit: ${envelope.toolName} called ${toolCount} times (limit: ${toolLimit}).`,
          decisionSource: "operation_limit",
          decisionName: `max_calls_per_tool:${envelope.toolName}`,
          hooksEvaluated,
          contractsEvaluated,
        });
      }
    }

    // 6. All checks passed
    const pe = hasPolicyError(contractsEvaluated);

    // 7. Observe-mode contract evaluation (never affects the decision)
    const observeResults = await this._evaluateObserveContracts(
      envelope,
      session,
    );

    return createPreDecision({
      action: "allow",
      hooksEvaluated,
      contractsEvaluated,
      observed: hasObservedDeny,
      policyError: pe,
      observeResults,
    });
  }

  async postExecute(
    envelope: ToolEnvelope,
    toolResponse: unknown,
    toolSuccess: boolean,
  ): Promise<PostDecision> {
    const warnings: string[] = [];
    const contractsEvaluated: Record<string, unknown>[] = [];
    let redactedResponse: unknown = null;
    let outputSuppressed = false;

    // 1. Postconditions (catch exceptions)
    for (const contract of this._guard.getPostconditions(envelope)) {
      let verdict: Verdict;
      try {
        verdict = await contract.check(envelope, toolResponse);
      } catch (exc) {
        verdict = Verdict.fail(`Postcondition error: ${exc}`, {
          policy_error: true,
        });
      }

      const contractRecord: Record<string, unknown> = {
        name: contract.name,
        type: "postcondition",
        passed: verdict.passed,
        message: verdict.message,
      };
      if (
        verdict.metadata &&
        Object.keys(verdict.metadata).length > 0
      ) {
        contractRecord["metadata"] = verdict.metadata;
      }
      contractsEvaluated.push(contractRecord);

      if (!verdict.passed) {
        const effect = contract.effect ?? "warn";
        const contractMode = contract.mode;
        const isSafe =
          envelope.sideEffect === SideEffect.PURE ||
          envelope.sideEffect === SideEffect.READ;

        // Observe mode takes precedence
        if (contractMode === "observe") {
          warnings.push(`\u26a0\ufe0f [observe] ${verdict.message}`);
        } else if (effect === "redact" && isSafe) {
          const patterns = contract.redactPatterns ?? [];
          const source =
            redactedResponse !== null ? redactedResponse : toolResponse;
          let text = source != null ? String(source) : "";
          if (patterns.length > 0) {
            for (const pat of patterns) {
              // Python re.sub() replaces ALL occurrences; ensure global flag
              const globalPat = pat.global
                ? pat
                : new RegExp(pat.source, pat.flags + "g");
              text = text.replace(globalPat, "[REDACTED]");
            }
          } else {
            const policy = new RedactionPolicy();
            text = policy.redactResult(text, text.length + 100);
          }
          redactedResponse = text;
          warnings.push(
            `\u26a0\ufe0f Content redacted by ${contract.name}.`,
          );
        } else if (effect === "deny" && isSafe) {
          redactedResponse = `[OUTPUT SUPPRESSED] ${verdict.message}`;
          outputSuppressed = true;
          warnings.push(
            `\u26a0\ufe0f Output suppressed by ${contract.name}.`,
          );
        } else if (
          (effect === "redact" || effect === "deny") &&
          !isSafe
        ) {
          warnings.push(
            `\u26a0\ufe0f ${verdict.message} Tool already executed \u2014 assess before proceeding.`,
          );
        } else if (isSafe) {
          warnings.push(
            `\u26a0\ufe0f ${verdict.message} Consider retrying.`,
          );
        } else {
          warnings.push(
            `\u26a0\ufe0f ${verdict.message} Tool already executed \u2014 assess before proceeding.`,
          );
        }
      }
    }

    // 2. After hooks (catch exceptions)
    for (const hookReg of this._guard.getHooks("after", envelope)) {
      if (hookReg.when && !hookReg.when(envelope)) {
        continue;
      }
      try {
        await hookReg.callback(envelope, toolResponse);
      } catch {
        // After hook errors are logged but do not affect the decision
      }
    }

    // Exclude observe-mode records from the "real failure" check —
    // observe-mode failures are logged but should not signal a real failure
    const postconditionsPassed =
      contractsEvaluated.length > 0
        ? contractsEvaluated.every(
            (c) => c["passed"] === true || c["observed"] === true,
          )
        : true;
    const pe = hasPolicyError(contractsEvaluated);

    return createPostDecision({
      toolSuccess,
      postconditionsPassed,
      warnings,
      contractsEvaluated,
      policyError: pe,
      redactedResponse,
      outputSuppressed,
    });
  }

  /**
   * Evaluate observe-mode contracts without affecting the real decision.
   *
   * Observe-mode contracts are identified by mode === "observe" on the
   * internal contract. Results are returned as dicts for audit emission
   * but never block calls.
   */
  async _evaluateObserveContracts(
    envelope: ToolEnvelope,
    session: Session,
  ): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];

    // Observe-mode preconditions
    for (const contract of this._guard.getObservePreconditions(
      envelope,
    )) {
      let verdict: Verdict;
      try {
        verdict = await contract.check(envelope);
      } catch (exc) {
        verdict = Verdict.fail(
          `Observe-mode precondition error: ${exc}`,
          { policy_error: true },
        );
      }

      results.push({
        name: contract.name,
        type: "precondition",
        passed: verdict.passed,
        message: verdict.message,
        source: contract.source ?? "yaml_precondition",
      });
    }

    // Observe-mode sandbox contracts
    for (const contract of this._guard.getObserveSandboxContracts(
      envelope,
    )) {
      let verdict: Verdict;
      try {
        verdict = await contract.check(envelope);
      } catch (exc) {
        verdict = Verdict.fail(
          `Observe-mode sandbox error: ${exc}`,
          { policy_error: true },
        );
      }

      results.push({
        name: contract.name,
        type: "sandbox",
        passed: verdict.passed,
        message: verdict.message,
        source: contract.source ?? "yaml_sandbox",
      });
    }

    // Observe-mode session contracts -- evaluate against the real session
    for (const contract of this._guard.getObserveSessionContracts()) {
      let verdict: Verdict;
      try {
        verdict = await contract.check(session);
      } catch (exc) {
        verdict = Verdict.fail(
          `Observe-mode session contract error: ${exc}`,
          { policy_error: true },
        );
      }

      results.push({
        name: contract.name,
        type: "session_contract",
        passed: verdict.passed,
        message: verdict.message,
        source: contract.source ?? "yaml_session",
      });
    }

    return results;
  }
}
