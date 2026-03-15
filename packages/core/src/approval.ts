/** Approval protocol for human-in-the-loop tool call authorization. */

import { randomUUID } from "node:crypto";
import * as readline from "node:readline";

import { RedactionPolicy } from "./redaction.js";

/** Strip ANSI escape sequences and control characters from terminal output. */
function sanitizeForTerminal(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
}

// ---------------------------------------------------------------------------
// ApprovalStatus
// ---------------------------------------------------------------------------

export const ApprovalStatus = {
  PENDING: "pending",
  APPROVED: "approved",
  DENIED: "denied",
  TIMEOUT: "timeout",
} as const;

export type ApprovalStatus =
  (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

// ---------------------------------------------------------------------------
// ApprovalRequest — frozen data object
// ---------------------------------------------------------------------------

/** A request for human approval of a tool call. */
export interface ApprovalRequest {
  readonly approvalId: string;
  readonly toolName: string;
  readonly toolArgs: Readonly<Record<string, unknown>>;
  readonly message: string;
  readonly timeout: number; // seconds
  readonly timeoutEffect: string; // "deny" | "allow"
  readonly principal: Readonly<Record<string, unknown>> | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

function createApprovalRequest(
  fields: Omit<ApprovalRequest, "createdAt"> & { createdAt?: Date },
): ApprovalRequest {
  const request: ApprovalRequest = {
    approvalId: fields.approvalId,
    toolName: fields.toolName,
    toolArgs: Object.freeze({ ...fields.toolArgs }),
    message: fields.message,
    timeout: fields.timeout,
    timeoutEffect: fields.timeoutEffect,
    principal:
      fields.principal !== null
        ? Object.freeze({ ...fields.principal })
        : null,
    metadata: Object.freeze({ ...fields.metadata }),
    createdAt: fields.createdAt ?? new Date(),
  };
  return Object.freeze(request);
}

// ---------------------------------------------------------------------------
// ApprovalDecision — frozen data object
// ---------------------------------------------------------------------------

/** The result of a human approval decision. */
export interface ApprovalDecision {
  readonly approved: boolean;
  readonly approver: string | null;
  readonly reason: string | null;
  readonly status: ApprovalStatus;
  readonly timestamp: Date;
}

function createApprovalDecision(
  fields: Partial<ApprovalDecision> & { approved: boolean },
): ApprovalDecision {
  const decision: ApprovalDecision = {
    approved: fields.approved,
    approver: fields.approver ?? null,
    reason: fields.reason ?? null,
    status: fields.status ?? ApprovalStatus.PENDING,
    timestamp: fields.timestamp ?? new Date(),
  };
  return Object.freeze(decision);
}

// ---------------------------------------------------------------------------
// ApprovalBackend — protocol
// ---------------------------------------------------------------------------

/** Protocol for human-in-the-loop approval providers. */
export interface ApprovalBackend {
  requestApproval(
    toolName: string,
    toolArgs: Record<string, unknown>,
    message: string,
    options?: {
      timeout?: number;
      timeoutEffect?: string;
      principal?: Record<string, unknown> | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<ApprovalRequest>;

  waitForDecision(
    approvalId: string,
    timeout?: number | null,
  ): Promise<ApprovalDecision>;
}

// ---------------------------------------------------------------------------
// LocalApprovalBackend — CLI-based approval for local testing
// ---------------------------------------------------------------------------

/**
 * CLI-based approval backend for local testing.
 *
 * Prompts on stdout, reads from stdin. Blocks until response or timeout.
 */
export class LocalApprovalBackend implements ApprovalBackend {
  private readonly _pending: Map<string, ApprovalRequest> = new Map();

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
    const approvalId = randomUUID();
    const request = createApprovalRequest({
      approvalId,
      toolName,
      toolArgs,
      message,
      timeout: options?.timeout ?? 300,
      timeoutEffect: options?.timeoutEffect ?? "deny",
      principal: options?.principal ?? null,
      metadata: options?.metadata ?? {},
    });
    this._pending.set(approvalId, request);

    const redaction = new RedactionPolicy();
    const safeArgs = redaction.redactArgs(toolArgs);
    process.stdout.write(`[APPROVAL REQUIRED] ${sanitizeForTerminal(message)}\n`);
    process.stdout.write(`  Tool: ${sanitizeForTerminal(toolName)}\n`);
    process.stdout.write(`  Args: ${sanitizeForTerminal(JSON.stringify(safeArgs))}\n`);
    process.stdout.write(`  ID:   ${approvalId}\n`);

    return request;
  }

  async waitForDecision(
    approvalId: string,
    timeout?: number | null,
  ): Promise<ApprovalDecision> {
    const request = this._pending.get(approvalId);
    const effectiveTimeout =
      timeout ?? (request ? request.timeout : 300);

    try {
      const response = await this._readStdin(approvalId, effectiveTimeout);
      const approved = ["y", "yes", "approve"].includes(
        response.trim().toLowerCase(),
      );
      const status = approved
        ? ApprovalStatus.APPROVED
        : ApprovalStatus.DENIED;
      return createApprovalDecision({
        approved,
        approver: "local",
        status,
      });
    } catch {
      // Timeout
      const timeoutEffect = request ? request.timeoutEffect : "deny";
      const approved = timeoutEffect === "allow";
      return createApprovalDecision({
        approved,
        status: ApprovalStatus.TIMEOUT,
      });
    }
  }

  /** Read a single line from stdin with a timeout. */
  private _readStdin(
    approvalId: string,
    timeoutSeconds: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const timer = setTimeout(() => {
        rl.close();
        reject(new Error("Approval timed out"));
      }, timeoutSeconds * 1000);

      rl.question(`Approve? [y/N] (id: ${approvalId}): `, (answer) => {
        clearTimeout(timer);
        rl.close();
        resolve(answer);
      });
    });
  }
}
