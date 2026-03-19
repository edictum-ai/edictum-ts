// @edictum/openclaw — OpenClaw adapter for edictum
// Translates between OpenClaw plugin hooks and Edictum's GovernancePipeline.
// NOTE: 500+ lines — approved due to adapter pattern requiring single-class cohesion (matches vercel-ai/claude-sdk)

import type { Principal, ToolEnvelope, AuditAction as AuditActionType } from "@edictum/core";
import {
  ApprovalStatus,
  AuditAction,
  createAuditEvent,
  createEnvelope,
  EdictumConfigError,
  GovernancePipeline,
  Session,
} from "@edictum/core";
import type { Edictum } from "@edictum/core";

import type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  Finding,
  PostCallResult,
  ToolHookContext,
} from "./types.js";
import { buildFindings, summarizeResult } from "./helpers.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpenClawAdapterOptions {
  /** Stable session ID. Defaults to guard.sessionId. */
  readonly sessionId?: string;

  /**
   * Static principal attached to every envelope.
   * Overridden by principalResolver if both are set.
   */
  readonly principal?: Principal;

  /**
   * Resolve principal dynamically per tool call.
   * Receives the OpenClaw tool hook context for sender info.
   */
  readonly principalResolver?: (
    toolName: string,
    toolInput: Record<string, unknown>,
    ctx: ToolHookContext,
  ) => Principal;

  /** Called on every denial. Errors are silently caught. */
  readonly onDeny?: (
    envelope: Readonly<ToolEnvelope>,
    reason: string,
    source: string | null,
  ) => void;

  /** Called on every allow. Errors are silently caught. */
  readonly onAllow?: (envelope: Readonly<ToolEnvelope>) => void;

  /**
   * Called when a postcondition produces findings.
   * Errors are silently caught.
   */
  readonly onPostconditionWarn?: (
    envelope: Readonly<ToolEnvelope>,
    findings: readonly Finding[],
  ) => void;

  /**
   * Determine whether a tool execution was successful.
   * Default: true unless the after_tool_call event has an error field.
   */
  readonly successCheck?: (toolName: string, result: unknown) => boolean;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingCall {
  readonly envelope: Readonly<ToolEnvelope>;
  readonly startMs: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class EdictumOpenClawAdapter {
  private readonly _guard: Edictum;
  private readonly _pipeline: GovernancePipeline;
  private readonly _session: Session;
  private readonly _sessionId: string;
  private _callIndex = 0;
  private readonly _pending = new Map<string, PendingCall>();

  // Callbacks
  /**
   * Mutable principal field. Initially set from options.principal (or null).
   * Can be updated at runtime via `setPrincipal()`. When a `principalResolver`
   * is configured, it takes priority and this field is ignored.
   */
  private _principal: Principal | null;
  private readonly _principalResolver:
    | ((
        toolName: string,
        toolInput: Record<string, unknown>,
        ctx: ToolHookContext,
      ) => Principal)
    | null;
  private readonly _onDeny:
    | ((
        envelope: Readonly<ToolEnvelope>,
        reason: string,
        source: string | null,
      ) => void)
    | null;
  private readonly _onAllow:
    | ((envelope: Readonly<ToolEnvelope>) => void)
    | null;
  private readonly _onPostconditionWarn:
    | ((
        envelope: Readonly<ToolEnvelope>,
        findings: readonly Finding[],
      ) => void)
    | null;
  private readonly _successCheck:
    | ((toolName: string, result: unknown) => boolean)
    | null;

  constructor(guard: Edictum, options: OpenClawAdapterOptions = {}) {
    this._guard = guard;
    this._pipeline = new GovernancePipeline(guard);

    const sessionId = options.sessionId ?? guard.sessionId;
    if (/[\x00-\x1f\x7f]/.test(sessionId)) {
      throw new EdictumConfigError("sessionId contains control characters");
    }
    this._sessionId = sessionId;
    this._session = new Session(this._sessionId, guard.backend);

    this._principal = options.principal ?? null;
    this._principalResolver = options.principalResolver ?? null;
    this._onDeny = options.onDeny ?? null;
    this._onAllow = options.onAllow ?? null;
    this._onPostconditionWarn = options.onPostconditionWarn ?? null;
    this._successCheck = options.successCheck ?? null;
  }

  /** The session ID used by this adapter instance. */
  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Update the static principal at runtime. This replaces the value set via
   * `options.principal` in the constructor. Has no effect when a
   * `principalResolver` is configured (the resolver always wins).
   *
   * Thread-safety note: the field is not guarded by a lock. In concurrent
   * environments, callers must ensure `setPrincipal` is not invoked while a
   * `pre()` call is in-flight, or accept the race.
   */
  setPrincipal(principal: Principal): void {
    this._principal = principal;
  }

  // -------------------------------------------------------------------------
  // Pre-execution: called from before_tool_call hook
  // -------------------------------------------------------------------------

  /**
   * Evaluate a tool call before execution.
   * Returns null on allow, or a denial reason string on deny.
   */
  async pre(
    toolName: string,
    toolInput: Record<string, unknown>,
    callId: string,
    ctx: ToolHookContext,
  ): Promise<string | null> {
    const principalResult = this._resolvePrincipal(toolName, toolInput, ctx);
    if (principalResult.error) {
      return "Principal resolution failed";
    }
    const principal = principalResult.value;
    const envelope = createEnvelope(toolName, toolInput, {
      callId,
      runId: ctx.runId ?? this._sessionId,
      callIndex: this._callIndex++,
      principal,
      environment: this._guard.environment,
      metadata: {
        openclawAgentId: ctx.agentId ?? null,
        openclawSessionKey: ctx.sessionKey ?? null,
        openclawSessionId: ctx.sessionId ?? null,
      },
      registry: this._guard.toolRegistry,
    });

    await this._session.incrementAttempts();
    const decision = await this._pipeline.preExecute(envelope, this._session);

    // --- Pending approval (same pattern as vercel-ai adapter) ---
    if (decision.action === "pending_approval") {
      const approvalBackend = this._guard._approvalBackend;

      if (!approvalBackend) {
        const reason =
          decision.reason ?? "Approval required but no approval backend configured.";
        this._safeDeny(envelope, reason, decision.decisionSource);
        await this._emitAuditPre(envelope, decision, AuditAction.CALL_DENIED);
        return reason;
      }

      try {
        const principalDict = envelope.principal
          ? ({ ...envelope.principal } as Record<string, unknown>)
          : null;

        const approvalRequest = await approvalBackend.requestApproval(
          envelope.toolName,
          envelope.args as Record<string, unknown>,
          decision.approvalMessage ?? decision.reason ?? "Approval required.",
          {
            timeout: decision.approvalTimeout,
            timeoutEffect: decision.approvalTimeoutEffect,
            principal: principalDict,
          },
        );

        await this._emitAuditPre(
          envelope,
          decision,
          AuditAction.CALL_APPROVAL_REQUESTED,
        );

        const approvalDecision = await approvalBackend.waitForDecision(
          approvalRequest.approvalId,
          decision.approvalTimeout,
        );

        let approved = false;
        if (approvalDecision.status === ApprovalStatus.TIMEOUT) {
          await this._emitAuditPre(envelope, decision, AuditAction.CALL_APPROVAL_TIMEOUT);
          if (decision.approvalTimeoutEffect === "allow") {
            approved = true;
          }
        } else if (!approvalDecision.approved) {
          await this._emitAuditPre(envelope, decision, AuditAction.CALL_APPROVAL_DENIED);
        } else {
          approved = true;
          await this._emitAuditPre(envelope, decision, AuditAction.CALL_APPROVAL_GRANTED);
        }

        if (approved) {
          this._safeAllow(envelope);
          this._pending.set(callId, { envelope, startMs: Date.now() });
          return null;
        }

        const denyReason = approvalDecision.reason ?? decision.reason ?? "Approval denied.";
        this._safeDeny(envelope, denyReason, decision.decisionSource);
        return denyReason;
      } catch {
        // Approval backend failure -> deny (not timeout — distinguish infra errors from real timeouts)
        const errorReason = "Approval backend error";
        this._safeDeny(envelope, errorReason, decision.decisionSource);
        await this._emitAuditPre(
          envelope,
          decision,
          AuditAction.CALL_DENIED,
        );
        return errorReason;
      }
    }

    // --- Deny ---
    if (decision.action === "deny") {
      // Observe mode: convert deny → allow with CALL_WOULD_DENY audit
      if (
        this._guard.mode === "observe" ||
        decision.observed
      ) {
        await this._emitAuditPre(
          envelope,
          decision,
          AuditAction.CALL_WOULD_DENY,
        );
        this._safeAllow(envelope);
        this._pending.set(callId, { envelope, startMs: Date.now() });
        return null;
      }

      const reason = decision.reason ?? "Denied by contract.";
      this._safeDeny(envelope, reason, decision.decisionSource);
      await this._emitAuditPre(envelope, decision, AuditAction.CALL_DENIED);
      return reason;
    }

    // --- Allow ---
    await this._emitAuditPre(envelope, decision, AuditAction.CALL_ALLOWED);
    this._safeAllow(envelope);
    this._pending.set(callId, { envelope, startMs: Date.now() });
    return null;
  }

  // -------------------------------------------------------------------------
  // Post-execution: called from after_tool_call hook
  // -------------------------------------------------------------------------

  /**
   * Evaluate a tool call after execution.
   * Returns postcondition findings and output suppression info.
   */
  async post(
    callId: string,
    toolResponse: unknown,
    afterEvent: AfterToolCallEvent,
  ): Promise<PostCallResult> {
    const pending = this._pending.get(callId);
    if (!pending) {
      return {
        result: toolResponse,
        postconditionsPassed: true,
        findings: [],
        outputSuppressed: false,
      };
    }
    this._pending.delete(callId);

    const { envelope, startMs } = pending;
    const durationMs = afterEvent.durationMs ?? Date.now() - startMs;
    const toolSuccess = this._checkToolSuccess(
      afterEvent.toolName,
      toolResponse,
      afterEvent.error,
    );

    const postDecision = await this._pipeline.postExecute(
      envelope,
      toolResponse,
      toolSuccess,
    );

    await this._session.recordExecution(envelope.toolName, toolSuccess);

    // Emit audit
    const [attemptCount, executionCount] = await Promise.all([
      this._session.attemptCount(),
      this._session.executionCount(),
    ]);

    const action = toolSuccess
      ? AuditAction.CALL_EXECUTED
      : AuditAction.CALL_FAILED;

    try {
      await this._guard.auditSink.emit(
        createAuditEvent({
          timestamp: new Date(),
          runId: envelope.runId,
          callId: envelope.callId,
          callIndex: envelope.callIndex,
          toolName: envelope.toolName,
          toolArgs: { ...envelope.args },
          sideEffect: envelope.sideEffect,
          environment: envelope.environment,
          principal: envelope.principal
            ? { ...envelope.principal }
            : null,
          action,
          decisionSource: null,
          decisionName: null,
          reason: afterEvent.error ?? null,
          hooksEvaluated: [],
          contractsEvaluated: postDecision.contractsEvaluated,
          toolSuccess,
          postconditionsPassed: postDecision.postconditionsPassed,
          durationMs,
          error: afterEvent.error ?? null,
          resultSummary: summarizeResult(toolResponse),
          sessionAttemptCount: attemptCount,
          sessionExecutionCount: executionCount,
          mode: this._guard.mode,
          policyVersion: this._guard.policyVersion,
          policyError: postDecision.policyError,
        }),
      );
    } catch {
      // Audit errors must never block tool execution
    }

    const findings = buildFindings(postDecision);
    if (findings.length > 0) {
      this._safePostconditionWarn(envelope, findings);
    }

    const result = postDecision.outputSuppressed
      ? "[OUTPUT SUPPRESSED BY EDICTUM]"
      : postDecision.redactedResponse !== undefined
        ? postDecision.redactedResponse
        : toolResponse;

    return {
      result,
      postconditionsPassed: postDecision.postconditionsPassed,
      findings,
      outputSuppressed: postDecision.outputSuppressed,
    };
  }

  // -------------------------------------------------------------------------
  // OpenClaw hook handlers — wire these into api.on()
  // -------------------------------------------------------------------------

  /**
   * Handler for the before_tool_call hook.
   * Returns { block, blockReason } on deny, or undefined on allow.
   */
  async handleBeforeToolCall(
    event: BeforeToolCallEvent,
    ctx: ToolHookContext,
  ): Promise<BeforeToolCallResult | undefined> {
    const callId =
      event.toolCallId ?? ctx.toolCallId ?? `ec_${Date.now()}_${this._callIndex}`;

    const reason = await this.pre(event.toolName, event.params, callId, ctx);

    if (reason !== null) {
      return { block: true, blockReason: reason };
    }
    // Allow: return nothing (OpenClaw treats undefined as allow)
  }

  /**
   * Handler for the after_tool_call hook.
   * Fire-and-forget — OpenClaw does not await this.
   */
  async handleAfterToolCall(
    event: AfterToolCallEvent,
    ctx: ToolHookContext,
  ): Promise<void> {
    const callId =
      event.toolCallId ?? ctx.toolCallId ?? this._findPendingByToolName(event.toolName);

    if (callId === null) return;

    await this.post(callId, event.result, event);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the principal for a call. If the resolver throws, returns an
   * error result so the caller can deny rather than propagating the error.
   */
  private _resolvePrincipal(
    toolName: string,
    toolInput: Record<string, unknown>,
    ctx: ToolHookContext,
  ): { value: Principal | null; error: false } | { value: null; error: true } {
    if (this._principalResolver) {
      try {
        return { value: this._principalResolver(toolName, toolInput, ctx), error: false };
      } catch {
        // A throwing resolver must never crash the adapter — signal error
        // so the caller can deny with "Principal resolution failed".
        return { value: null, error: true };
      }
    }
    return { value: this._principal, error: false };
  }

  /**
   * Determine if the tool call succeeded. If the successCheck throws,
   * default to failure (false) rather than crashing post().
   */
  private _checkToolSuccess(
    toolName: string,
    result: unknown,
    error?: string,
  ): boolean {
    if (this._successCheck) {
      try {
        return this._successCheck(toolName, result);
      } catch {
        // A throwing successCheck must never crash post() — treat as failure
        return false;
      }
    }
    return !error;
  }

  /**
   * Fallback lookup: find the first pending call whose toolName matches.
   *
   * **Limitation:** When multiple concurrent calls use the same tool, this
   * returns the first match (insertion order). The correct pending entry may
   * differ. Callers should always prefer an explicit callId when available;
   * this fallback exists only for OpenClaw runtimes that omit toolCallId
   * from the after_tool_call event.
   */
  private _findPendingByToolName(toolName: string): string | null {
    for (const [callId, pending] of this._pending) {
      if (pending.envelope.toolName === toolName) {
        return callId;
      }
    }
    return null;
  }

  private _safeDeny(
    envelope: Readonly<ToolEnvelope>,
    reason: string,
    source: string | null,
  ): void {
    try {
      this._onDeny?.(envelope, reason, source);
    } catch {
      // Callback errors must never propagate
    }
  }

  private _safeAllow(envelope: Readonly<ToolEnvelope>): void {
    try {
      this._onAllow?.(envelope);
    } catch {
      // Callback errors must never propagate
    }
  }

  private _safePostconditionWarn(
    envelope: Readonly<ToolEnvelope>,
    findings: readonly Finding[],
  ): void {
    try {
      this._onPostconditionWarn?.(envelope, findings);
    } catch {
      // Callback errors must never propagate
    }
  }

  private async _emitAuditPre(
    envelope: Readonly<ToolEnvelope>,
    decision: {
      reason: string | null;
      decisionSource: string | null;
      decisionName: string | null;
      hooksEvaluated: Record<string, unknown>[];
      contractsEvaluated: Record<string, unknown>[];
      policyError: boolean;
      observeResults?: Record<string, unknown>[];
    },
    action: AuditActionType,
  ): Promise<void> {
    try {
      const [attemptCount, executionCount] = await Promise.all([
        this._session.attemptCount(),
        this._session.executionCount(),
      ]);

      await this._guard.auditSink.emit(
        createAuditEvent({
          timestamp: new Date(),
          runId: envelope.runId,
          callId: envelope.callId,
          callIndex: envelope.callIndex,
          toolName: envelope.toolName,
          toolArgs: { ...envelope.args },
          sideEffect: envelope.sideEffect,
          environment: envelope.environment,
          principal: envelope.principal
            ? { ...envelope.principal }
            : null,
          action,
          decisionSource: decision.decisionSource,
          decisionName: decision.decisionName,
          reason: decision.reason,
          hooksEvaluated: decision.hooksEvaluated,
          contractsEvaluated: decision.contractsEvaluated,
          toolSuccess: null,
          postconditionsPassed: null,
          durationMs: 0,
          error: null,
          resultSummary: null,
          sessionAttemptCount: attemptCount,
          sessionExecutionCount: executionCount,
          mode: this._guard.mode,
          policyVersion: this._guard.policyVersion,
          policyError: decision.policyError,
        }),
      );
    } catch {
      // Audit errors must never block tool execution
    }
  }
}
