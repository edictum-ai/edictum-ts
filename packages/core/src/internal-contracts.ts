/**
 * Internal contract representations used by GuardLike and GovernancePipeline.
 *
 * User-facing types (Precondition, Postcondition, SessionContract) are plain
 * objects optimized for DX. These internal types carry the metadata the
 * pipeline needs (name, mode, source, effect, timeout) that Python stores
 * as _edictum_* function attributes.
 *
 * The Guard class converts user contracts → internal contracts at construction.
 * The YAML compiler produces internal contracts directly.
 */

import type { ToolEnvelope } from "./envelope.js";
import type { OperationLimits } from "./limits.js";
import type { Session } from "./session.js";
import type { Verdict } from "./contracts.js";
import type { HookRegistration } from "./types.js";

// ---------------------------------------------------------------------------
// Internal contract types
// ---------------------------------------------------------------------------

interface InternalContractBase {
  readonly name: string;
  readonly mode?: "enforce" | "observe";
  readonly source?: string;
}

/** Internal precondition — enriched with pipeline metadata. */
export interface InternalPrecondition extends InternalContractBase {
  readonly type: "precondition";
  readonly tool: string;
  readonly check: (envelope: ToolEnvelope) => Verdict | Promise<Verdict>;
  readonly when?: ((envelope: ToolEnvelope) => boolean) | null;
  readonly effect?: "deny" | "approve";
  readonly timeout?: number;
  readonly timeoutEffect?: "deny" | "allow";
}

/** Internal postcondition — enriched with effect and redaction info. */
export interface InternalPostcondition extends InternalContractBase {
  readonly type: "postcondition";
  readonly tool: string;
  readonly check: (
    envelope: ToolEnvelope,
    response: unknown,
  ) => Verdict | Promise<Verdict>;
  readonly when?: ((envelope: ToolEnvelope) => boolean) | null;
  readonly effect?: "warn" | "redact" | "deny";
  readonly redactPatterns?: readonly RegExp[];
}

/** Internal session contract. */
export interface InternalSessionContract extends InternalContractBase {
  readonly type: "session_contract";
  readonly check: (session: Session) => Verdict | Promise<Verdict>;
}

/** Internal sandbox contract — tool matching uses tools[] not tool. */
export interface InternalSandboxContract extends InternalContractBase {
  readonly type: "sandbox";
  readonly tools: readonly string[];
  readonly check: (envelope: ToolEnvelope) => Verdict | Promise<Verdict>;
  readonly effect?: "deny" | "approve";
  readonly timeout?: number;
  readonly timeoutEffect?: "deny" | "allow";
}

/** Union of all internal contract types. */
export type InternalContract =
  | InternalPrecondition
  | InternalPostcondition
  | InternalSessionContract
  | InternalSandboxContract;

// ---------------------------------------------------------------------------
// GuardLike — interface the pipeline depends on
// ---------------------------------------------------------------------------

/**
 * Interface representing what the GovernancePipeline needs from the Guard.
 *
 * Decouples pipeline from concrete Guard class for testability.
 * The real Edictum class implements this.
 */
export interface GuardLike {
  readonly limits: OperationLimits;

  // Enforce-mode contract accessors
  getHooks(
    phase: "before" | "after",
    envelope: ToolEnvelope,
  ): HookRegistration[];
  getPreconditions(envelope: ToolEnvelope): InternalPrecondition[];
  getPostconditions(envelope: ToolEnvelope): InternalPostcondition[];
  getSessionContracts(): InternalSessionContract[];
  getSandboxContracts(envelope: ToolEnvelope): InternalSandboxContract[];

  // Observe-mode contract accessors
  getObservePreconditions(envelope: ToolEnvelope): InternalPrecondition[];
  getObservePostconditions(envelope: ToolEnvelope): InternalPostcondition[];
  getObserveSandboxContracts(
    envelope: ToolEnvelope,
  ): InternalSandboxContract[];
  getObserveSessionContracts(): InternalSessionContract[];
}
