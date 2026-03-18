/** Server-backed approval backend for human-in-the-loop workflows. */

import type {
  ApprovalBackend,
  ApprovalDecision,
  ApprovalRequest,
} from "@edictum/core";
import { ApprovalStatus, deepFreeze } from "@edictum/core";

import type { EdictumServerClient } from "./client.js";
import { SAFE_IDENTIFIER_RE } from "./client.js";

/**
 * Approval backend that delegates to the edictum-server approval queue.
 *
 * Creates approval requests via HTTP POST, then polls GET until resolved.
 */
export class ServerApprovalBackend implements ApprovalBackend {
  private readonly _client: EdictumServerClient;
  private readonly _pollInterval: number;
  private readonly _pending: Map<string, ApprovalRequest> = new Map();

  constructor(
    client: EdictumServerClient,
    options?: {
      pollInterval?: number;
    },
  ) {
    this._client = client;
    this._pollInterval = options?.pollInterval ?? 2_000;
  }

  /** Create an approval request on the server. */
  async requestApproval(
    toolName: string,
    toolArgs: Record<string, unknown>,
    message: string,
    options?: {
      timeout?: number;
      timeoutEffect?: string;
      principal?: Record<string, unknown> | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<ApprovalRequest> {
    const timeout = options?.timeout ?? 300;
    const timeoutEffect = options?.timeoutEffect ?? "deny";

    const body = {
      agent_id: this._client.agentId,
      tool_name: toolName,
      tool_args: toolArgs,
      message,
      timeout,
      timeout_effect: timeoutEffect,
    };

    const response = await this._client.post("/api/v1/approvals", body);
    const approvalId = response["id"];

    // Validate server-returned approvalId immediately
    if (typeof approvalId !== "string" || !SAFE_IDENTIFIER_RE.test(approvalId)) {
      throw new Error(
        `Server returned invalid approvalId: ${JSON.stringify(approvalId)}. Must match SAFE_IDENTIFIER_RE.`,
      );
    }

    // Deep-copy THEN freeze — prevents freezing caller-owned nested objects.
    // structuredClone handles most JSON-like data; falls back to shallow spread
    // for non-cloneable types (Buffer, typed arrays) which are already edge cases
    // since toolArgs must be JSON-serializable for the HTTP POST.
    let safeArgs: Record<string, unknown>;
    let safePrincipal: Record<string, unknown> | null;
    let safeMeta: Record<string, unknown>;
    try {
      safeArgs = structuredClone(toolArgs);
      safePrincipal = options?.principal ? structuredClone(options.principal) : null;
      safeMeta = structuredClone(options?.metadata ?? {});
    } catch {
      safeArgs = { ...toolArgs };
      safePrincipal = options?.principal ? { ...options.principal } : null;
      safeMeta = { ...(options?.metadata ?? {}) };
    }
    const request: ApprovalRequest = deepFreeze({
      approvalId,
      toolName,
      toolArgs: safeArgs,
      message,
      timeout,
      timeoutEffect,
      principal: safePrincipal,
      metadata: safeMeta,
      createdAt: new Date(),
    });

    this._pending.set(approvalId, request);
    return request;
  }

  /** Poll the server until the approval is resolved or timeout is exceeded. */
  async waitForDecision(
    approvalId: string,
    timeout?: number | null,
  ): Promise<ApprovalDecision> {
    // Validate approvalId before interpolating into URL path
    if (!SAFE_IDENTIFIER_RE.test(approvalId)) {
      throw new Error(
        `Invalid approvalId: ${JSON.stringify(approvalId)}. Must match SAFE_IDENTIFIER_RE.`,
      );
    }

    const request = this._pending.get(approvalId);
    const effectiveTimeout =
      timeout ?? (request ? request.timeout : 300);
    const timeoutEffect = request ? request.timeoutEffect : "deny";

    const deadline = Date.now() + effectiveTimeout * 1000;

    // Clean up pending map now that we have the id — avoid unbounded growth
    this._pending.delete(approvalId);

    while (true) {
      const response = await this._client.get(
        `/api/v1/approvals/${approvalId}`,
      );
      const status = response["status"] as string;

      if (status === "approved") {
        return deepFreeze({
          approved: true,
          approver: (response["decided_by"] as string) ?? null,
          reason: (response["decision_reason"] as string) ?? null,
          status: ApprovalStatus.APPROVED,
          timestamp: new Date(),
        });
      }

      if (status === "denied") {
        return deepFreeze({
          approved: false,
          approver: (response["decided_by"] as string) ?? null,
          reason: (response["decision_reason"] as string) ?? null,
          status: ApprovalStatus.DENIED,
          timestamp: new Date(),
        });
      }

      if (status === "timeout") {
        return deepFreeze({
          approved: timeoutEffect === "allow",
          approver: null,
          reason: null,
          status: ApprovalStatus.TIMEOUT,
          timestamp: new Date(),
        });
      }

      // Still pending — check local deadline
      if (Date.now() >= deadline) {
        return deepFreeze({
          approved: timeoutEffect === "allow",
          approver: null,
          reason: null,
          status: ApprovalStatus.TIMEOUT,
          timestamp: new Date(),
        });
      }

      await sleep(this._pollInterval);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
