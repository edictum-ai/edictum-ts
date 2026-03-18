/**
 * @edictum/claude-sdk -- Claude Agent SDK adapter for edictum.
 *
 * Translates Edictum pipeline decisions into Claude Agent SDK hook format.
 * The adapter does NOT contain governance logic -- that lives in GovernancePipeline.
 *
 * Integration point: PreToolUse / PostToolUse hooks.
 *
 * Note: Hook output (toSdkHooks) cannot substitute tool results.
 * Postcondition effects (redact/deny) require the wrapper integration path
 * for full enforcement. Native hooks can only warn via additionalContext.
 */

import { randomUUID } from "node:crypto";

import {
  type AuditAction,
  AuditAction as AA,
  createAuditEvent,
  createEnvelope,
  type Edictum,
  type Finding,
  GovernancePipeline,
  type PostCallResult,
  type PostDecisionLike,
  createPostCallResult,
  type PreDecision,
  type Principal,
  Session,
  buildFindings,
  defaultSuccessCheck,
} from "@edictum/core";

export const VERSION = "0.1.0" as const;

// ---------------------------------------------------------------------------
// Claude Agent SDK hook types (structural -- no framework import needed)
// ---------------------------------------------------------------------------

/** Shape of input passed to a PreToolUse hook callback. */
export interface PreToolUseInput {
  readonly hook_event_name: string;
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
}

/** Shape of input passed to a PostToolUse hook callback. */
export interface PostToolUseInput {
  readonly hook_event_name: string;
  readonly tool_name: string;
  readonly tool_result?: unknown;
}

/** PreToolUse hook output for deny. */
export interface PreToolUseHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "allow" | "deny";
    readonly permissionDecisionReason?: string;
  };
}

/** PostToolUse hook output (informational only). */
export interface PostToolUseHookOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: "PostToolUse";
    readonly additionalContext?: string;
  };
}

/** Hook callback type matching Claude Agent SDK convention. */
export type HookCallback = (input: {
  readonly input: PreToolUseInput | PostToolUseInput;
}) => Promise<PreToolUseHookOutput | PostToolUseHookOutput | Record<string, never>>;

// ---------------------------------------------------------------------------
// ClaudeAgentSDKAdapterOptions
// ---------------------------------------------------------------------------

export interface ClaudeAgentSDKAdapterOptions {
  readonly sessionId?: string;
  readonly principal?: Principal;
  readonly principalResolver?: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Principal;
}

// ---------------------------------------------------------------------------
// ToSdkHooksOptions
// ---------------------------------------------------------------------------

export interface ToSdkHooksOptions {
  readonly onPostconditionWarn?: (
    result: unknown,
    findings: Finding[],
  ) => void;
}

// ---------------------------------------------------------------------------
// Pending state
// ---------------------------------------------------------------------------

interface PendingCall {
  readonly envelope: ReturnType<typeof createEnvelope>;
}

// ---------------------------------------------------------------------------
// ClaudeAgentSDKAdapter
// ---------------------------------------------------------------------------

/**
 * Translate Edictum pipeline decisions into Claude Agent SDK hook format.
 *
 * The adapter does NOT contain governance logic -- that lives in
 * GovernancePipeline. The adapter only:
 * 1. Creates envelopes from SDK hook data
 * 2. Manages pending state (envelope) between PreToolUse/PostToolUse
 * 3. Translates PreDecision/PostDecision into hook behavior
 * 4. Handles observe mode (deny -> allow conversion)
 */
export class ClaudeAgentSDKAdapter {
  private readonly _guard: Edictum;
  private readonly _pipeline: GovernancePipeline;
  private readonly _sessionId: string;
  private readonly _session: Session;
  private _callIndex: number = 0;
  private readonly _pending: Map<string, PendingCall> = new Map();
  private _principal: Principal | null;
  private readonly _principalResolver:
    | ((toolName: string, toolInput: Record<string, unknown>) => Principal)
    | null;
  private _onPostconditionWarn:
    | ((result: unknown, findings: Finding[]) => void)
    | null = null;

  constructor(guard: Edictum, options?: ClaudeAgentSDKAdapterOptions) {
    this._guard = guard;
    this._pipeline = new GovernancePipeline(guard);
    this._sessionId = options?.sessionId ?? randomUUID();
    this._session = new Session(this._sessionId, guard.backend);
    this._principal = options?.principal ?? null;
    this._principalResolver = options?.principalResolver ?? null;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  setPrincipal(principal: Principal): void {
    this._principal = principal;
  }

  // -----------------------------------------------------------------------
  // Principal resolution
  // -----------------------------------------------------------------------

  private _resolvePrincipal(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Principal | null {
    if (this._principalResolver != null) {
      return this._principalResolver(toolName, toolInput);
    }
    return this._principal;
  }

  // -----------------------------------------------------------------------
  // toSdkHooks
  // -----------------------------------------------------------------------

  /**
   * Returns hooks for Claude Agent SDK integration.
   *
   * Usage:
   * ```ts
   * const adapter = new ClaudeAgentSDKAdapter(guard);
   * const hooks = adapter.toSdkHooks();
   * // Pass hooks.PreToolUse and hooks.PostToolUse to Claude Agent SDK
   * ```
   */
  toSdkHooks(options?: ToSdkHooksOptions): {
    PreToolUse: HookCallback[];
    PostToolUse: HookCallback[];
  } {
    this._onPostconditionWarn = options?.onPostconditionWarn ?? null;

    return {
      PreToolUse: [
        async ({ input }): Promise<PreToolUseHookOutput> => {
          const hookInput = input as PreToolUseInput;
          const toolName = hookInput.tool_name;
          const toolInput = hookInput.tool_input;
          const callId = randomUUID();

          const result = await this._pre(toolName, toolInput, callId);

          if (result != null) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: result,
              },
            };
          }

          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
            },
          };
        },
      ],
      PostToolUse: [
        async ({ input }): Promise<PostToolUseHookOutput | Record<string, never>> => {
          const hookInput = input as PostToolUseInput;
          const toolResult = hookInput.tool_result;

          // Correlate with pending call via FIFO (insertion-order)
          if (this._pending.size > 0) {
            const callId = this._pending.keys().next().value as string;
            const postResult = await this._post(callId, toolResult);

            if (postResult.findings.length > 0) {
              const context = postResult.findings
                .map((f) => f.message)
                .join("\n");
              return {
                hookSpecificOutput: {
                  hookEventName: "PostToolUse",
                  additionalContext: context,
                },
              };
            }
          }

          return {};
        },
      ],
    };
  }

  // -----------------------------------------------------------------------
  // _pre -- pre-execution governance
  // -----------------------------------------------------------------------

  /**
   * Run pre-execution governance. Returns denial reason string or null to allow.
   *
   * Exposed for direct testing without framework imports.
   */
  async _pre(
    toolName: string,
    toolInput: Record<string, unknown>,
    callId: string,
  ): Promise<string | null> {
    const envelope = createEnvelope(toolName, toolInput, {
      runId: this._sessionId,
      callIndex: this._callIndex,
      toolUseId: callId,
      environment: this._guard.environment,
      registry: this._guard.toolRegistry,
      principal: this._resolvePrincipal(toolName, toolInput),
    });
    this._callIndex += 1;

    // Increment attempts BEFORE governance
    await this._session.incrementAttempts();

    // Run pipeline
    const decision = await this._pipeline.preExecute(
      envelope,
      this._session,
    );

    // Handle observe mode: convert deny to allow with warning
    if (this._guard.mode === "observe" && decision.action === "deny") {
      await this._emitAuditPre(
        envelope,
        decision,
        AA.CALL_WOULD_DENY,
      );
      this._pending.set(callId, { envelope });
      return null; // allow through
    }

    // Handle deny
    if (decision.action === "deny") {
      await this._emitAuditPre(envelope, decision);
      if (this._guard._onDeny) {
        try {
          this._guard._onDeny(
            envelope,
            decision.reason ?? "",
            decision.decisionName,
          );
        } catch {
          // on_deny callback raised -- swallow
        }
      }
      this._pending.delete(callId);
      return `DENIED: ${decision.reason}`;
    }

    // Handle per-contract observed denials
    if (decision.observed) {
      for (const cr of decision.contractsEvaluated) {
        if (cr["observed"] && !cr["passed"]) {
          await this._guard.auditSink.emit(
            createAuditEvent({
              action: AA.CALL_WOULD_DENY,
              runId: envelope.runId,
              callId: envelope.callId,
              callIndex: envelope.callIndex,
              toolName: envelope.toolName,
              toolArgs: this._guard.redaction.redactArgs(
                envelope.args,
              ) as Record<string, unknown>,
              sideEffect: envelope.sideEffect,
              environment: envelope.environment,
              principal: envelope.principal
                ? ({ ...envelope.principal } as Record<string, unknown>)
                : null,
              decisionSource: "precondition",
              decisionName: cr["name"] as string,
              reason: cr["message"] as string | null,
              mode: "observe",
              policyVersion: this._guard.policyVersion,
              policyError: decision.policyError,
            }),
          );
        }
      }
    }

    // Handle allow
    await this._emitAuditPre(envelope, decision);
    if (this._guard._onAllow) {
      try {
        this._guard._onAllow(envelope);
      } catch {
        // on_allow callback raised -- swallow
      }
    }
    this._pending.set(callId, { envelope });
    return null;
  }

  // -----------------------------------------------------------------------
  // _post -- post-execution governance
  // -----------------------------------------------------------------------

  /**
   * Run post-execution governance. Returns PostCallResult with findings.
   *
   * Exposed for direct testing without framework imports.
   */
  async _post(
    callId: string,
    toolResponse: unknown = undefined,
  ): Promise<PostCallResult> {
    const pending = this._pending.get(callId);
    this._pending.delete(callId);

    if (!pending) {
      return createPostCallResult({ result: toolResponse });
    }

    const { envelope } = pending;

    // Derive tool_success from response
    const toolSuccess = this._checkToolSuccess(
      envelope.toolName,
      toolResponse,
    );

    // Run pipeline
    const postDecision = await this._pipeline.postExecute(
      envelope,
      toolResponse,
      toolSuccess,
    );

    const effectiveResponse =
      postDecision.redactedResponse != null
        ? postDecision.redactedResponse
        : toolResponse;

    // Record in session
    await this._session.recordExecution(envelope.toolName, toolSuccess);

    // Emit audit
    const action: AuditAction = toolSuccess
      ? AA.CALL_EXECUTED
      : AA.CALL_FAILED;
    await this._guard.auditSink.emit(
      createAuditEvent({
        action,
        runId: envelope.runId,
        callId: envelope.callId,
        callIndex: envelope.callIndex,
        toolName: envelope.toolName,
        toolArgs: this._guard.redaction.redactArgs(
          envelope.args,
        ) as Record<string, unknown>,
        sideEffect: envelope.sideEffect,
        environment: envelope.environment,
        principal: envelope.principal
          ? ({ ...envelope.principal } as Record<string, unknown>)
          : null,
        toolSuccess,
        postconditionsPassed: postDecision.postconditionsPassed,
        contractsEvaluated: postDecision.contractsEvaluated,
        sessionAttemptCount: await this._session.attemptCount(),
        sessionExecutionCount: await this._session.executionCount(),
        mode: this._guard.mode,
        policyVersion: this._guard.policyVersion,
        policyError: postDecision.policyError,
      }),
    );

    const findings = buildFindings(postDecision as unknown as PostDecisionLike);
    const postResult = createPostCallResult({
      result: effectiveResponse,
      postconditionsPassed: postDecision.postconditionsPassed,
      findings,
      outputSuppressed: postDecision.outputSuppressed,
    });

    // Call callback for side effects
    if (!postResult.postconditionsPassed && this._onPostconditionWarn) {
      try {
        this._onPostconditionWarn(
          postResult.result,
          [...postResult.findings],
        );
      } catch {
        // on_postcondition_warn callback raised -- swallow
      }
    }

    return postResult;
  }

  // -----------------------------------------------------------------------
  // Audit helpers
  // -----------------------------------------------------------------------

  private async _emitAuditPre(
    envelope: ReturnType<typeof createEnvelope>,
    decision: PreDecision,
    auditAction?: AuditAction,
  ): Promise<void> {
    const action: AuditAction =
      auditAction ??
      (decision.action === "deny" ? AA.CALL_DENIED : AA.CALL_ALLOWED);

    await this._guard.auditSink.emit(
      createAuditEvent({
        action,
        runId: envelope.runId,
        callId: envelope.callId,
        callIndex: envelope.callIndex,
        toolName: envelope.toolName,
        toolArgs: this._guard.redaction.redactArgs(
          envelope.args,
        ) as Record<string, unknown>,
        sideEffect: envelope.sideEffect,
        environment: envelope.environment,
        principal: envelope.principal
          ? ({ ...envelope.principal } as Record<string, unknown>)
          : null,
        decisionSource: decision.decisionSource,
        decisionName: decision.decisionName,
        reason: decision.reason,
        hooksEvaluated: decision.hooksEvaluated,
        contractsEvaluated: decision.contractsEvaluated,
        sessionAttemptCount: await this._session.attemptCount(),
        sessionExecutionCount: await this._session.executionCount(),
        mode: this._guard.mode,
        policyVersion: this._guard.policyVersion,
        policyError: decision.policyError,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Tool success detection
  // -----------------------------------------------------------------------

  private _checkToolSuccess(
    toolName: string,
    toolResponse: unknown,
  ): boolean {
    if (this._guard._successCheck != null) {
      return this._guard._successCheck(toolName, toolResponse);
    }
    return defaultSuccessCheck(toolName, toolResponse);
  }
}
