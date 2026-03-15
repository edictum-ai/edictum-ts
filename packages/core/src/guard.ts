/**
 * Core Edictum class -- construction, contract registry, and accessor methods.
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's _guard.py
 * (314 LOC) which is already the decomposed version of the original god class.
 * The contract classification + accessor methods form a cohesive unit.
 *
 * Minimum viable guard: constructor + contract classification + accessors.
 * run(), from_yaml(), from_server() are delegated methods added later.
 */

import { randomUUID } from "node:crypto";

import type { ApprovalBackend } from "./approval.js";
import { CollectingAuditSink, CompositeSink } from "./audit.js";
import type { AuditSink } from "./audit.js";
import { createCompiledState } from "./compiled-state.js";
import { EdictumConfigError } from "./errors.js";
import type { CompiledState } from "./compiled-state.js";
import type {
  Precondition,
  Postcondition,
  SessionContract,
} from "./contracts.js";
import { SideEffect, ToolRegistry } from "./envelope.js";
import type { Principal, ToolEnvelope } from "./envelope.js";
import { fnmatch } from "./fnmatch.js";
import type {
  GuardLike,
  InternalPrecondition,
  InternalPostcondition,
  InternalSessionContract,
  InternalSandboxContract,
} from "./internal-contracts.js";
import { DEFAULT_LIMITS } from "./limits.js";
import type { OperationLimits } from "./limits.js";
import { RedactionPolicy } from "./redaction.js";
import { MemoryBackend } from "./storage.js";
import type { StorageBackend } from "./storage.js";
import type { HookRegistration } from "./types.js";

// ---------------------------------------------------------------------------
// User contract type discrimination
// ---------------------------------------------------------------------------

/** User-facing contract with optional name (not in interface, but allowed). */
type NamedContract = { readonly name?: string };

function isSessionContract(
  c: Precondition | Postcondition | SessionContract,
): c is SessionContract {
  return !("tool" in c);
}

// ---------------------------------------------------------------------------
// EdictumOptions
// ---------------------------------------------------------------------------

/** Constructor options for the Edictum guard. */
export interface EdictumOptions {
  readonly environment?: string;
  readonly mode?: "enforce" | "observe";
  readonly limits?: OperationLimits;
  readonly tools?: Record<
    string,
    { side_effect?: string; idempotent?: boolean }
  >;
  readonly contracts?: ReadonlyArray<
    Precondition | Postcondition | SessionContract
  >;
  readonly hooks?: ReadonlyArray<HookRegistration>;
  readonly auditSink?: AuditSink | AuditSink[];
  readonly redaction?: RedactionPolicy;
  readonly backend?: StorageBackend;
  readonly policyVersion?: string;
  readonly onDeny?: (
    envelope: ToolEnvelope,
    reason: string,
    source: string | null,
  ) => void;
  readonly onAllow?: (envelope: ToolEnvelope) => void;
  readonly successCheck?: (toolName: string, result: unknown) => boolean;
  readonly principal?: Principal;
  readonly principalResolver?: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Principal;
  readonly approvalBackend?: ApprovalBackend;
}

// ---------------------------------------------------------------------------
// Edictum class
// ---------------------------------------------------------------------------

/**
 * Main configuration and entrypoint.
 *
 * Two usage modes:
 * 1. With framework adapter: use the appropriate adapter
 * 2. Framework-agnostic: use guard.run() directly
 */
export class Edictum implements GuardLike {
  readonly environment: string;
  readonly mode: "enforce" | "observe";
  readonly backend: StorageBackend;
  readonly redaction: RedactionPolicy;
  readonly toolRegistry: ToolRegistry;
  readonly auditSink: AuditSink;

  private readonly _localSink: CollectingAuditSink;
  private _state: CompiledState;
  private readonly _beforeHooks: HookRegistration[];
  private readonly _afterHooks: HookRegistration[];
  private readonly _sessionId: string;

  // Callbacks and resolution
  readonly _onDeny:
    | ((
        envelope: ToolEnvelope,
        reason: string,
        source: string | null,
      ) => void)
    | null;
  readonly _onAllow: ((envelope: ToolEnvelope) => void) | null;
  readonly _successCheck:
    | ((toolName: string, result: unknown) => boolean)
    | null;
  private _principal: Principal | null;
  private readonly _principalResolver:
    | ((
        toolName: string,
        toolInput: Record<string, unknown>,
      ) => Principal)
    | null;
  readonly _approvalBackend: ApprovalBackend | null;

  constructor(options: EdictumOptions = {}) {
    this.environment = options.environment ?? "production";
    this.mode = options.mode ?? "enforce";
    this.backend = options.backend ?? new MemoryBackend();
    this.redaction = options.redaction ?? new RedactionPolicy();
    // Callbacks are wired up in run() — throw if provided before run() exists
    if (options.onDeny != null) {
      throw new EdictumConfigError(
        "onDeny requires Edictum.run() which is not yet implemented. " +
        "Remove it until run() is available.",
      );
    }
    if (options.onAllow != null) {
      throw new EdictumConfigError(
        "onAllow requires Edictum.run() which is not yet implemented. " +
        "Remove it until run() is available.",
      );
    }
    if (options.successCheck != null) {
      throw new EdictumConfigError(
        "successCheck requires Edictum.run() which is not yet implemented. " +
        "Remove it until run() is available.",
      );
    }
    this._onDeny = options.onDeny ?? null;
    this._onAllow = options.onAllow ?? null;
    this._successCheck = options.successCheck ?? null;
    this._principal = options.principal ?? null;
    this._principalResolver = options.principalResolver ?? null;
    this._approvalBackend = options.approvalBackend ?? null;

    // Audit sink: local sink always present
    this._localSink = new CollectingAuditSink();
    if (Array.isArray(options.auditSink)) {
      this.auditSink = new CompositeSink([
        this._localSink,
        ...options.auditSink,
      ]);
    } else if (options.auditSink != null) {
      this.auditSink = new CompositeSink([
        this._localSink,
        options.auditSink,
      ]);
    } else {
      this.auditSink = this._localSink;
    }

    // Build tool registry
    this.toolRegistry = new ToolRegistry();
    if (options.tools) {
      for (const [name, config] of Object.entries(options.tools)) {
        this.toolRegistry.register(
          name,
          (config.side_effect as SideEffect | undefined) ??
            SideEffect.IRREVERSIBLE,
          config.idempotent ?? false,
        );
      }
    }

    // Classify contracts and build compiled state
    this._state = Edictum._classifyContracts(
      options.contracts ?? [],
      options.limits ?? DEFAULT_LIMITS,
      options.policyVersion ?? null,
    );

    // Hooks are not reloaded -- mutable lists are fine
    this._beforeHooks = [];
    this._afterHooks = [];
    for (const item of options.hooks ?? []) {
      this._registerHook(item);
    }

    // Persistent session ID for accumulating limits across run() calls
    this._sessionId = randomUUID();
  }

  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  /** The local in-memory audit event collector. Always present. */
  get localSink(): CollectingAuditSink {
    return this._localSink;
  }

  /** Operation limits for the current contract set. */
  get limits(): OperationLimits {
    return this._state.limits;
  }

  /** Update operation limits (replaces compiled state atomically). */
  set limits(value: OperationLimits) {
    this._state = createCompiledState({ ...this._state, limits: value });
  }

  /** SHA256 hash identifying the active contract bundle. */
  get policyVersion(): string | null {
    return this._state.policyVersion;
  }

  /** Update policy version (replaces compiled state atomically). */
  set policyVersion(value: string | null) {
    this._state = createCompiledState({
      ...this._state,
      policyVersion: value,
    });
  }

  /** The persistent session ID for this guard instance. */
  get sessionId(): string {
    return this._sessionId;
  }

  // -----------------------------------------------------------------------
  // Principal
  // -----------------------------------------------------------------------

  /** Update the principal used for subsequent tool calls. */
  setPrincipal(principal: Principal): void {
    this._principal = principal;
  }

  /** Resolve the principal for a tool call. */
  _resolvePrincipal(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Principal | null {
    if (this._principalResolver != null) {
      return this._principalResolver(toolName, toolInput);
    }
    return this._principal;
  }

  // -----------------------------------------------------------------------
  // Hooks
  // -----------------------------------------------------------------------

  private _registerHook(item: HookRegistration): void {
    if (item.phase === "before") {
      this._beforeHooks.push(item);
    } else {
      this._afterHooks.push(item);
    }
  }

  getHooks(
    phase: "before" | "after",
    envelope: ToolEnvelope,
  ): HookRegistration[] {
    const hooks =
      phase === "before" ? this._beforeHooks : this._afterHooks;
    return hooks.filter(
      (h) => h.tool === "*" || fnmatch(envelope.toolName, h.tool),
    );
  }

  // -----------------------------------------------------------------------
  // Contract accessors -- enforce mode
  // -----------------------------------------------------------------------

  getPreconditions(envelope: ToolEnvelope): InternalPrecondition[] {
    return Edictum._filterByTool(
      this._state.preconditions as InternalPrecondition[],
      envelope,
    );
  }

  getPostconditions(envelope: ToolEnvelope): InternalPostcondition[] {
    return Edictum._filterByTool(
      this._state.postconditions as InternalPostcondition[],
      envelope,
    );
  }

  getSessionContracts(): InternalSessionContract[] {
    return [...this._state.sessionContracts];
  }

  getSandboxContracts(envelope: ToolEnvelope): InternalSandboxContract[] {
    return Edictum._filterSandbox(
      this._state.sandboxContracts as InternalSandboxContract[],
      envelope,
    );
  }

  // -----------------------------------------------------------------------
  // Contract accessors -- observe mode
  // -----------------------------------------------------------------------

  getObservePreconditions(
    envelope: ToolEnvelope,
  ): InternalPrecondition[] {
    return Edictum._filterByTool(
      this._state.observePreconditions as InternalPrecondition[],
      envelope,
    );
  }

  getObservePostconditions(
    envelope: ToolEnvelope,
  ): InternalPostcondition[] {
    return Edictum._filterByTool(
      this._state.observePostconditions as InternalPostcondition[],
      envelope,
    );
  }

  getObserveSessionContracts(): InternalSessionContract[] {
    return [...this._state.observeSessionContracts];
  }

  getObserveSandboxContracts(
    envelope: ToolEnvelope,
  ): InternalSandboxContract[] {
    return Edictum._filterSandbox(
      this._state.observeSandboxContracts as InternalSandboxContract[],
      envelope,
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Classify user-facing and internal contracts into enforce/observe lists.
   *
   * User-facing contracts (Precondition, Postcondition, SessionContract)
   * are converted to internal representations. Internal contracts (from
   * YAML compiler) carry _edictum_* metadata and are classified by their
   * _edictum_observe flag (Python uses _edictum_shadow — wire-format parity).
   */
  private static _classifyContracts(
    contracts: ReadonlyArray<
      Precondition | Postcondition | SessionContract
    >,
    limits: OperationLimits,
    policyVersion: string | null,
  ): CompiledState {
    const pre: InternalPrecondition[] = [];
    const post: InternalPostcondition[] = [];
    const session: InternalSessionContract[] = [];
    const sandbox: InternalSandboxContract[] = [];
    const oPre: InternalPrecondition[] = [];
    const oPost: InternalPostcondition[] = [];
    const oSession: InternalSessionContract[] = [];
    const oSandbox: InternalSandboxContract[] = [];

    for (const item of contracts) {
      const raw = item as unknown as Record<string, unknown>;
      const edictumType = raw._edictum_type as string | undefined;
      // Python YAML compiler emits _edictum_shadow; we accept both for wire-format parity
      const isObserve =
        (raw._edictum_observe as boolean) ??
        (raw._edictum_shadow as boolean) ??
        false;

      if (edictumType != null) {
        // Internal contract (from YAML compiler)
        Edictum._classifyInternal(
          raw,
          edictumType,
          isObserve,
          { pre, post, session, sandbox, oPre, oPost, oSession, oSandbox },
        );
      } else if (isSessionContract(item)) {
        const name = (raw as NamedContract).name ?? "anonymous";
        session.push({
          type: "session_contract",
          name,
          check: (item as SessionContract).check,
        });
      } else if ("tool" in item && (item as { contractType?: string }).contractType === "post") {
        const postItem = item as Postcondition;
        const name = (raw as NamedContract).name ?? "anonymous";
        post.push({
          type: "postcondition",
          name,
          tool: postItem.tool,
          check: postItem.check,
          when: postItem.when,
        });
      } else if ("tool" in item) {
        // Fail-closed: reject unknown contractType values at runtime
        const ct = (raw as { contractType?: unknown }).contractType;
        if (ct != null && ct !== "pre") {
          throw new EdictumConfigError(
            `Contract with tool "${(item as Precondition).tool}" has unknown contractType ` +
            `"${String(ct)}". Expected "pre" or omitted for Precondition, "post" for Postcondition.`,
          );
        }
        const preItem = item as Precondition;
        const name = (raw as NamedContract).name ?? "anonymous";
        pre.push({
          type: "precondition",
          name,
          tool: preItem.tool,
          check: preItem.check,
          when: preItem.when,
        });
      }
    }

    return createCompiledState({
      preconditions: pre,
      postconditions: post,
      sessionContracts: session,
      sandboxContracts: sandbox,
      observePreconditions: oPre,
      observePostconditions: oPost,
      observeSessionContracts: oSession,
      observeSandboxContracts: oSandbox,
      limits,
      policyVersion,
    });
  }

  /** Route an internal contract to the appropriate enforce/observe list. */
  private static _classifyInternal(
    raw: Record<string, unknown>,
    edictumType: string,
    isObserve: boolean,
    lists: {
      pre: InternalPrecondition[];
      post: InternalPostcondition[];
      session: InternalSessionContract[];
      sandbox: InternalSandboxContract[];
      oPre: InternalPrecondition[];
      oPost: InternalPostcondition[];
      oSession: InternalSessionContract[];
      oSandbox: InternalSandboxContract[];
    },
  ): void {
    const target = isObserve
      ? { pre: lists.oPre, post: lists.oPost, session: lists.oSession, sandbox: lists.oSandbox }
      : { pre: lists.pre, post: lists.post, session: lists.session, sandbox: lists.sandbox };

    if (edictumType === "precondition") target.pre.push(raw as unknown as InternalPrecondition);
    else if (edictumType === "postcondition") target.post.push(raw as unknown as InternalPostcondition);
    else if (edictumType === "session_contract") target.session.push(raw as unknown as InternalSessionContract);
    else if (edictumType === "sandbox") target.sandbox.push(raw as unknown as InternalSandboxContract);
  }

  /** Filter contracts by tool pattern and optional `when` guard. */
  private static _filterByTool<
    T extends {
      readonly tool: string;
      readonly when?: ((envelope: ToolEnvelope) => boolean) | null;
    },
  >(contracts: T[], envelope: ToolEnvelope): T[] {
    const result: T[] = [];
    for (const p of contracts) {
      const tool = p.tool ?? "*";
      const when = p.when ?? null;
      if (tool !== "*" && !fnmatch(envelope.toolName, tool)) {
        continue;
      }
      if (when != null && !when(envelope)) {
        continue;
      }
      result.push(p);
    }
    return result;
  }

  /** Filter sandbox contracts by tool patterns array. */
  private static _filterSandbox(
    contracts: InternalSandboxContract[],
    envelope: ToolEnvelope,
  ): InternalSandboxContract[] {
    const result: InternalSandboxContract[] = [];
    for (const s of contracts) {
      const tools = s.tools ?? ["*"];
      if (tools.some((p) => fnmatch(envelope.toolName, p))) {
        result.push(s);
      }
    }
    return result;
  }
}
