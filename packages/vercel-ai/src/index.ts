/**
 * @edictum/vercel-ai — Vercel AI SDK adapter for edictum.
 *
 * Translates Edictum pipeline decisions into Vercel AI SDK callback format.
 * The adapter does NOT contain governance logic — that lives in GovernancePipeline.
 *
 * Integration point: experimental_onToolCallStart / experimental_onToolCallFinish
 * callbacks for generateText / streamText.
 */

import { randomUUID } from "node:crypto";

import {
  type AuditAction,
  AuditAction as AA,
  ApprovalStatus,
  createAuditEvent,
  createEnvelope,
  type Edictum,
  EdictumDenied,
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
// Vercel AI SDK event types (structural — no framework import needed)
// ---------------------------------------------------------------------------

/** Shape of the event passed to experimental_onToolCallStart. */
export interface OnToolCallStartEvent {
  readonly toolCall: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
  };
}

/** Shape of the event passed to experimental_onToolCallFinish. */
export interface OnToolCallFinishEvent {
  readonly toolCall: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
  };
  readonly output?: unknown;
  readonly error?: unknown;
}

// ---------------------------------------------------------------------------
// VercelAIAdapter options
// ---------------------------------------------------------------------------

export interface VercelAIAdapterOptions {
  readonly sessionId?: string;
  readonly principal?: Principal;
  readonly principalResolver?: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Principal;
}

export interface AsCallbacksOptions {
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
// VercelAIAdapter
// ---------------------------------------------------------------------------

/**
 * Translate Edictum pipeline decisions into Vercel AI SDK callback format.
 *
 * The adapter does NOT contain governance logic — that lives in
 * GovernancePipeline. The adapter only:
 * 1. Creates envelopes from SDK callback data
 * 2. Manages pending state (envelope) between onToolCallStart/onToolCallFinish
 * 3. Translates PreDecision/PostDecision into callback behavior
 * 4. Handles observe mode (deny -> allow conversion)
 */
export class VercelAIAdapter {
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

  constructor(guard: Edictum, options?: VercelAIAdapterOptions) {
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
  // asCallbacks
  // -----------------------------------------------------------------------

  /**
   * Returns Vercel AI SDK callbacks for generateText / streamText.
   *
   * Usage:
   * ```ts
   * const adapter = new VercelAIAdapter(guard);
   * const result = await generateText({
   *   ...options,
   *   ...adapter.asCallbacks(),
   * });
   * ```
   */
  asCallbacks(options?: AsCallbacksOptions): {
    experimental_onToolCallStart: (
      event: OnToolCallStartEvent,
    ) => Promise<void>;
    experimental_onToolCallFinish: (
      event: OnToolCallFinishEvent,
    ) => Promise<void>;
  } {
    const onPostconditionWarn = options?.onPostconditionWarn ?? null;

    return {
      experimental_onToolCallStart: async (
        event: OnToolCallStartEvent,
      ): Promise<void> => {
        const { toolCallId, toolName, args } = event.toolCall;
        const result = await this._pre(toolName, args, toolCallId);
        if (result != null) {
          throw new EdictumDenied(result);
        }
      },

      experimental_onToolCallFinish: async (
        event: OnToolCallFinishEvent,
      ): Promise<void> => {
        const { toolCallId } = event.toolCall;
        // Determine response: error takes precedence
        const toolResponse =
          event.error !== undefined ? String(event.error) : event.output;

        const postResult = await this._post(toolCallId, toolResponse);

        if (
          !postResult.postconditionsPassed &&
          onPostconditionWarn != null
        ) {
          try {
            onPostconditionWarn(
              postResult.result,
              [...postResult.findings],
            );
          } catch {
            // Callback errors are swallowed — they must not affect the SDK flow
          }
        }
      },
    };
  }

  // -----------------------------------------------------------------------
  // _pre — pre-execution governance
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

    // Finding 1: Handle pending_approval
    if (decision.action === "pending_approval") {
      if (this._guard._approvalBackend == null) {
        return `DENIED: Approval required but no approval backend configured: ${decision.reason}`;
      }

      const principalDict = envelope.principal
        ? ({ ...envelope.principal } as Record<string, unknown>)
        : null;

      const approvalRequest =
        await this._guard._approvalBackend.requestApproval(
          envelope.toolName,
          envelope.args as Record<string, unknown>,
          decision.approvalMessage ?? decision.reason ?? "",
          {
            timeout: decision.approvalTimeout,
            timeoutEffect: decision.approvalTimeoutEffect,
            principal: principalDict,
          },
        );

      await this._emitAuditPre(
        envelope,
        decision,
        AA.CALL_APPROVAL_REQUESTED,
      );

      const approvalDecision = await this._guard._approvalBackend.waitForDecision(
        approvalRequest.approvalId,
        decision.approvalTimeout,
      );

      let approved = false;
      if (approvalDecision.status === ApprovalStatus.TIMEOUT) {
        await this._emitAuditPre(envelope, decision, AA.CALL_APPROVAL_TIMEOUT);
        if (decision.approvalTimeoutEffect === "allow") {
          approved = true;
        }
      } else if (!approvalDecision.approved) {
        await this._emitAuditPre(envelope, decision, AA.CALL_APPROVAL_DENIED);
      } else {
        approved = true;
        await this._emitAuditPre(envelope, decision, AA.CALL_APPROVAL_GRANTED);
      }

      if (approved) {
        if (this._guard._onAllow) {
          try {
            this._guard._onAllow(envelope);
          } catch {
            // on_allow callback raised — swallow
          }
        }
        this._pending.set(callId, { envelope });
        return null;
      } else {
        const denyReason = approvalDecision.reason ?? decision.reason ?? "";
        if (this._guard._onDeny) {
          try {
            this._guard._onDeny(envelope, denyReason, decision.decisionName);
          } catch {
            // on_deny callback raised — swallow
          }
        }
        this._pending.delete(callId);
        return `DENIED: ${denyReason}`;
      }
    }

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
          // on_deny callback raised — swallow
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
        // on_allow callback raised — swallow
      }
    }
    this._pending.set(callId, { envelope });

    // Observe-mode audits — errors swallowed (must not block execution)
    try {
      for (const sr of decision.observeResults) {
        const observeAction = sr["passed"]
          ? AA.CALL_ALLOWED
          : AA.CALL_WOULD_DENY;
        await this._guard.auditSink.emit(
          createAuditEvent({
            action: observeAction,
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
            decisionSource: sr["source"] as string | null,
            decisionName: sr["name"] as string | null,
            reason: sr["message"] as string | null,
            mode: "observe",
            policyVersion: this._guard.policyVersion,
          }),
        );
      }
    } catch {
      // Observe audit errors must not block tool execution
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // _post — post-execution governance
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
    return createPostCallResult({
      result: effectiveResponse,
      postconditionsPassed: postDecision.postconditionsPassed,
      findings,
      outputSuppressed: postDecision.outputSuppressed,
    });
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
