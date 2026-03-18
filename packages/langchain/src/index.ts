/**
 * @edictum/langchain -- LangChain.js adapter for edictum.
 *
 * Translates Edictum pipeline decisions into LangChain middleware format.
 * The adapter does NOT contain governance logic -- that lives in GovernancePipeline.
 *
 * Integration point: wrapToolCall middleware for ToolNode.
 */

import { randomUUID } from "node:crypto";

import {
  type AuditAction,
  AuditAction as AA,
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
// LangChain types (structural -- no framework import needed)
// ---------------------------------------------------------------------------

/** Structural type for a LangChain tool call request. */
export interface ToolCallRequest {
  readonly toolCall: {
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly id: string;
  };
}

/** Handler function that executes the actual tool. */
export type ToolCallHandler = (request: ToolCallRequest) => Promise<unknown>;

// ---------------------------------------------------------------------------
// LangChainAdapterOptions
// ---------------------------------------------------------------------------

export interface LangChainAdapterOptions {
  readonly sessionId?: string;
  readonly principal?: Principal;
  readonly principalResolver?: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Principal;
}

// ---------------------------------------------------------------------------
// AsMiddlewareOptions
// ---------------------------------------------------------------------------

export interface AsMiddlewareOptions {
  readonly onPostconditionWarn?: (
    result: unknown,
    findings: Finding[],
  ) => void;
}

// ---------------------------------------------------------------------------
// AsToolWrapperOptions
// ---------------------------------------------------------------------------

export interface AsToolWrapperOptions {
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
// LangChainAdapter
// ---------------------------------------------------------------------------

/**
 * Translate Edictum pipeline decisions into LangChain middleware format.
 *
 * The adapter does NOT contain governance logic -- that lives in
 * GovernancePipeline. The adapter only:
 * 1. Creates envelopes from LangChain ToolCallRequest
 * 2. Manages pending state (envelope) between pre/post
 * 3. Translates PreDecision/PostDecision into middleware behavior
 * 4. Handles observe mode (deny -> allow conversion)
 */
export class LangChainAdapter {
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

  constructor(guard: Edictum, options?: LangChainAdapterOptions) {
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
  // asMiddleware
  // -----------------------------------------------------------------------

  /**
   * Returns a middleware-compatible object for LangChain ToolNode.
   *
   * Usage:
   * ```ts
   * const adapter = new LangChainAdapter(guard);
   * const middleware = adapter.asMiddleware();
   * // Pass to ToolNode or agent as tool_call_middleware
   * ```
   */
  asMiddleware(options?: AsMiddlewareOptions): {
    name: string;
    wrapToolCall: (
      request: ToolCallRequest,
      handler: ToolCallHandler,
    ) => Promise<unknown>;
  } {
    const onPostconditionWarn = options?.onPostconditionWarn ?? null;

    return {
      name: "edictum",
      wrapToolCall: async (
        request: ToolCallRequest,
        handler: ToolCallHandler,
      ): Promise<unknown> => {
        const { name: toolName, args: toolArgs, id: callId } = request.toolCall;

        // Pre-execution governance
        const preResult = await this._pre(toolName, toolArgs, callId);
        if (preResult != null) {
          throw new EdictumDenied(preResult);
        }

        // Execute the tool
        let result: unknown;
        let toolSuccess = true;
        try {
          result = await handler(request);
        } catch (err) {
          result = String(err);
          toolSuccess = false;
        }

        // Post-execution governance (always runs, even on tool failure)
        const postResult = await this._post(callId, result);

        // Fire callback on postcondition failure
        if (!postResult.postconditionsPassed && onPostconditionWarn != null) {
          try {
            onPostconditionWarn(
              postResult.result,
              [...postResult.findings],
            );
          } catch {
            // on_postcondition_warn callback raised -- swallow
          }
        }

        // Re-throw tool errors after recording the execution
        if (!toolSuccess) {
          throw new Error(String(result));
        }

        return postResult.result;
      },
    };
  }

  // -----------------------------------------------------------------------
  // asToolWrapper
  // -----------------------------------------------------------------------

  /**
   * Returns a wrapper function for any tool callable.
   *
   * The wrapper runs pre-execution governance before calling the tool,
   * then post-execution governance after. Throws EdictumDenied on deny.
   *
   * Usage:
   * ```ts
   * const adapter = new LangChainAdapter(guard);
   * const wrapper = adapter.asToolWrapper();
   * const governed = wrapper(myToolFn);
   * const result = await governed("MyTool", { arg: "value" });
   * ```
   */
  asToolWrapper(options?: AsToolWrapperOptions): (
    toolCallable: (args: Record<string, unknown>) => unknown | Promise<unknown>,
  ) => (
    toolName: string,
    toolInput: Record<string, unknown>,
    callId?: string,
  ) => Promise<unknown> {
    const onPostconditionWarn = options?.onPostconditionWarn ?? null;

    return (
      toolCallable: (args: Record<string, unknown>) => unknown | Promise<unknown>,
    ) => {
      return async (
        toolName: string,
        toolInput: Record<string, unknown>,
        callId?: string,
      ): Promise<unknown> => {
        const resolvedCallId = callId ?? randomUUID();

        // Pre-execution governance
        const preResult = await this._pre(toolName, toolInput, resolvedCallId);
        if (preResult != null) {
          throw new EdictumDenied(preResult);
        }

        // Execute the tool
        let result: unknown;
        let toolSuccess = true;
        try {
          result = await toolCallable(toolInput);
        } catch (err) {
          result = String(err);
          toolSuccess = false;
        }

        // Post-execution governance (always runs, even on tool failure)
        const postResult = await this._post(resolvedCallId, result);

        // Fire callback on postcondition failure
        if (!postResult.postconditionsPassed && onPostconditionWarn != null) {
          try {
            onPostconditionWarn(
              postResult.result,
              [...postResult.findings],
            );
          } catch {
            // on_postcondition_warn callback raised -- swallow
          }
        }

        // Re-throw tool errors after recording the execution
        if (!toolSuccess) {
          throw new Error(String(result));
        }

        return postResult.result;
      };
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
