// @edictum/openclaw — OpenClaw adapter for edictum
// Translates between OpenClaw plugin hooks and Edictum's GovernancePipeline.

import type { Principal, ToolEnvelope, AuditAction as AuditActionType } from "@edictum/core";
import {
  AuditAction,
  createAuditEvent,
  createEnvelope,
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
  private readonly _principal: Principal | null;
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
    this._sessionId = options.sessionId ?? guard.sessionId;
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

  /** Update the static principal. */
  setPrincipal(principal: Principal): void {
    (this as unknown as { _principal: Principal | null })._principal = principal;
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
    const principal = this._resolvePrincipal(toolName, toolInput, ctx);
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

    // --- Pending approval ---
    if (decision.action === "pending_approval") {
      // Access internal approval backend (same pattern as vercel-ai adapter)
      const approvalBackend = (
        this._guard as unknown as { _approvalBackend: { requestApproval: (req: unknown) => Promise<boolean> } | null }
      )._approvalBackend;

      if (!approvalBackend) {
        const reason =
          decision.reason ?? "Approval required but no approval backend configured.";
        this._safeDeny(envelope, reason, decision.decisionSource);
        await this._emitAuditPre(envelope, decision, AuditAction.CALL_DENIED);
        return reason;
      }
      // Request approval
      await this._emitAuditPre(
        envelope,
        decision,
        AuditAction.CALL_APPROVAL_REQUESTED,
      );
      try {
        const approved = await approvalBackend.requestApproval({
          envelope,
          reason: decision.approvalMessage ?? decision.reason ?? "Approval required.",
          timeout: decision.approvalTimeout,
          timeoutEffect: decision.approvalTimeoutEffect,
        });
        if (approved) {
          await this._emitAuditPre(
            envelope,
            decision,
            AuditAction.CALL_APPROVAL_GRANTED,
          );
          this._safeAllow(envelope);
          this._pending.set(callId, { envelope, startMs: Date.now() });
          return null;
        }
      } catch {
        // Approval backend failure → deny
      }
      const reason = decision.reason ?? "Approval denied or timed out.";
      this._safeDeny(envelope, reason, decision.decisionSource);
      await this._emitAuditPre(
        envelope,
        decision,
        AuditAction.CALL_APPROVAL_DENIED,
      );
      return reason;
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

  private _resolvePrincipal(
    toolName: string,
    toolInput: Record<string, unknown>,
    ctx: ToolHookContext,
  ): Principal | null {
    if (this._principalResolver) {
      return this._principalResolver(toolName, toolInput, ctx);
    }
    return this._principal;
  }

  private _checkToolSuccess(
    toolName: string,
    result: unknown,
    error?: string,
  ): boolean {
    if (this._successCheck) {
      return this._successCheck(toolName, result);
    }
    return !error;
  }

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFindings(postDecision: {
  postconditionsPassed: boolean;
  warnings: string[];
  contractsEvaluated: Record<string, unknown>[];
  policyError: boolean;
}): Finding[] {
  if (postDecision.postconditionsPassed && !postDecision.policyError) {
    return [];
  }
  const findings: Finding[] = [];
  for (const w of postDecision.warnings) {
    findings.push({
      contractId: null,
      message: w,
      tags: [],
      severity: "warn",
    });
  }
  for (const c of postDecision.contractsEvaluated) {
    if (c.passed === false || c.policyError === true) {
      findings.push({
        contractId: (c.contractId as string) ?? null,
        message: (c.message as string) ?? "Postcondition failed.",
        tags: (c.tags as string[]) ?? [],
        severity: (c.policyError as boolean) ? "error" : "warn",
      });
    }
  }
  return findings;
}

function summarizeResult(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  const str = typeof result === "string" ? result : JSON.stringify(result);
  return str.length > 200 ? str.slice(0, 197) + "..." : str;
}
