/**
 * Core Edictum class -- construction, rule registry, and accessor methods.
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's _guard.py
 * (314 LOC) which is already the decomposed version of the original god class.
 * The rule classification + accessor methods form a cohesive unit.
 *
 * Minimum viable guard: constructor + rule classification + accessors.
 * run(), from_yaml(), from_server() are delegated methods added later.
 */

import { randomUUID } from 'node:crypto'

import type { ApprovalBackend } from './approval.js'
import {
  fromYaml as _fromYaml,
  fromYamlString as _fromYamlString,
  reload as _reload,
} from './factory.js'
import type { FromYamlOptions, ReloadOptions, YamlFactoryOptions } from './factory.js'
import type { CompositionReport } from './yaml-engine/composer.js'
import { CollectingAuditSink, CompositeSink } from './audit.js'
import type { AuditSink } from './audit.js'
import { createCompiledState } from './compiled-state.js'
import { EdictumConfigError } from './errors.js'
import type { CompiledState } from './compiled-state.js'
import type { Precondition, Postcondition, SessionRule } from './rules.js'
import { SideEffect, ToolRegistry } from './tool-call.js'
import type { Principal, ToolCall } from './tool-call.js'
import type { EvaluationResult } from './evaluation.js'
import { fnmatch } from './fnmatch.js'
import type {
  GuardLike,
  InternalPrecondition,
  InternalPostcondition,
  InternalSessionRule,
  InternalSandboxRule,
} from './internal-rules.js'
import { DEFAULT_LIMITS } from './limits.js'
import type { OperationLimits } from './limits.js'
import { RedactionPolicy } from './redaction.js'
import { MemoryBackend } from './storage.js'
import type { StorageBackend } from './storage.js'
import type { HookRegistration } from './types.js'

// ---------------------------------------------------------------------------
// User rule type discrimination
// ---------------------------------------------------------------------------

/** User-facing rule with optional name (not in interface, but allowed). */
type NamedContract = { readonly name?: string }

function isSessionRule(c: Precondition | Postcondition | SessionRule): c is SessionRule {
  return !('tool' in c)
}

// ---------------------------------------------------------------------------
// EdictumOptions
// ---------------------------------------------------------------------------

/** Constructor options for the Edictum guard. */
export interface EdictumOptions {
  readonly environment?: string
  readonly mode?: 'enforce' | 'observe'
  readonly limits?: OperationLimits
  readonly tools?: Record<string, { side_effect?: string; idempotent?: boolean }>
  readonly rules?: ReadonlyArray<Precondition | Postcondition | SessionRule>
  readonly hooks?: ReadonlyArray<HookRegistration>
  readonly auditSink?: AuditSink | AuditSink[]
  readonly redaction?: RedactionPolicy
  readonly backend?: StorageBackend
  readonly policyVersion?: string
  readonly onDeny?: (toolCall: ToolCall, reason: string, source: string | null) => void
  readonly onAllow?: (toolCall: ToolCall) => void
  readonly successCheck?: (toolName: string, result: unknown) => boolean
  readonly principal?: Principal
  readonly principalResolver?: (toolName: string, toolInput: Record<string, unknown>) => Principal
  readonly approvalBackend?: ApprovalBackend
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
  readonly environment: string
  readonly mode: 'enforce' | 'observe'
  readonly backend: StorageBackend
  readonly redaction: RedactionPolicy
  readonly toolRegistry: ToolRegistry
  readonly auditSink: AuditSink

  private readonly _localSink: CollectingAuditSink
  private _state: CompiledState
  private readonly _beforeHooks: HookRegistration[]
  private readonly _afterHooks: HookRegistration[]
  private readonly _sessionId: string

  // Callbacks and resolution — not private because _runner.ts needs access
  // (Python's _runner.py accesses self._on_deny etc. directly)
  /** @internal */ readonly _onDeny:
    | ((toolCall: ToolCall, reason: string, source: string | null) => void)
    | null
  /** @internal */ readonly _onAllow: ((toolCall: ToolCall) => void) | null
  /** @internal */ readonly _successCheck: ((toolName: string, result: unknown) => boolean) | null
  private _principal: Principal | null
  private readonly _principalResolver:
    | ((toolName: string, toolInput: Record<string, unknown>) => Principal)
    | null
  /** @internal */ readonly _approvalBackend: ApprovalBackend | null

  constructor(options: EdictumOptions = {}) {
    this.environment = options.environment ?? 'production'
    this.mode = options.mode ?? 'enforce'
    this.backend = options.backend ?? new MemoryBackend()
    this.redaction = options.redaction ?? new RedactionPolicy()
    this._onDeny = options.onDeny ?? null
    this._onAllow = options.onAllow ?? null
    this._successCheck = options.successCheck ?? null
    this._principal = options.principal ?? null
    this._principalResolver = options.principalResolver ?? null
    this._approvalBackend = options.approvalBackend ?? null

    // Audit sink: local sink always present
    this._localSink = new CollectingAuditSink()
    if (Array.isArray(options.auditSink)) {
      this.auditSink = new CompositeSink([this._localSink, ...options.auditSink])
    } else if (options.auditSink != null) {
      this.auditSink = new CompositeSink([this._localSink, options.auditSink])
    } else {
      this.auditSink = this._localSink
    }

    // Build tool registry
    this.toolRegistry = new ToolRegistry()
    if (options.tools) {
      for (const [name, config] of Object.entries(options.tools)) {
        this.toolRegistry.register(
          name,
          (config.side_effect as SideEffect | undefined) ?? SideEffect.IRREVERSIBLE,
          config.idempotent ?? false,
        )
      }
    }

    // Classify rules and build compiled state
    this._state = Edictum._classifyContracts(
      options.rules ?? [],
      options.limits ?? DEFAULT_LIMITS,
      options.policyVersion ?? null,
    )

    // Hooks are not reloaded -- mutable lists are fine
    this._beforeHooks = []
    this._afterHooks = []
    for (const item of options.hooks ?? []) {
      this._registerHook(item)
    }

    // Persistent session ID for accumulating limits across run() calls
    this._sessionId = randomUUID()
  }

  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  /** The local in-memory audit event collector. Always present. */
  get localSink(): CollectingAuditSink {
    return this._localSink
  }

  /** Operation limits for the current rule set. */
  get limits(): OperationLimits {
    return this._state.limits
  }

  /** Update operation limits (replaces compiled state atomically). */
  set limits(value: OperationLimits) {
    this._state = createCompiledState({ ...this._state, limits: value })
  }

  /** SHA256 hash identifying the active rule bundle. */
  get policyVersion(): string | null {
    return this._state.policyVersion
  }

  /**
   * Replace the compiled state atomically.
   *
   * @internal — used by factory.ts reload(). Not part of the public API.
   */
  _replaceState(newState: CompiledState): void {
    this._state = newState
  }

  /**
   * Read the current compiled state.
   *
   * @internal — used by factory.ts reload(). Not part of the public API.
   */
  _getState(): CompiledState {
    return this._state
  }

  /** Update policy version (replaces compiled state atomically). */
  set policyVersion(value: string | null) {
    this._state = createCompiledState({
      ...this._state,
      policyVersion: value,
    })
  }

  /** The persistent session ID for this guard instance. */
  get sessionId(): string {
    return this._sessionId
  }

  // -----------------------------------------------------------------------
  // Principal
  // -----------------------------------------------------------------------

  /** Update the principal used for subsequent tool calls. */
  setPrincipal(principal: Principal): void {
    this._principal = principal
  }

  /** Resolve the principal for a tool call. */
  _resolvePrincipal(toolName: string, toolInput: Record<string, unknown>): Principal | null {
    if (this._principalResolver != null) {
      return this._principalResolver(toolName, toolInput)
    }
    return this._principal
  }

  // -----------------------------------------------------------------------
  // Hooks
  // -----------------------------------------------------------------------

  private _registerHook(item: HookRegistration): void {
    if (item.phase === 'before') {
      this._beforeHooks.push(item)
    } else {
      this._afterHooks.push(item)
    }
  }

  getHooks(phase: 'before' | 'after', toolCall: ToolCall): HookRegistration[] {
    const hooks = phase === 'before' ? this._beforeHooks : this._afterHooks
    return hooks.filter((h) => h.tool === '*' || fnmatch(toolCall.toolName, h.tool))
  }

  // -----------------------------------------------------------------------
  // Rule accessors -- enforce mode
  // -----------------------------------------------------------------------

  getPreconditions(toolCall: ToolCall): InternalPrecondition[] {
    return Edictum._filterByTool(this._state.preconditions as InternalPrecondition[], toolCall)
  }

  getPostconditions(toolCall: ToolCall): InternalPostcondition[] {
    return Edictum._filterByTool(this._state.postconditions as InternalPostcondition[], toolCall)
  }

  getSessionContracts(): InternalSessionRule[] {
    return [...this._state.sessionContracts]
  }

  getSandboxContracts(toolCall: ToolCall): InternalSandboxRule[] {
    return Edictum._filterSandbox(this._state.sandboxContracts as InternalSandboxRule[], toolCall)
  }

  // -----------------------------------------------------------------------
  // Rule accessors -- observe mode
  // -----------------------------------------------------------------------

  getObservePreconditions(toolCall: ToolCall): InternalPrecondition[] {
    return Edictum._filterByTool(
      this._state.observePreconditions as InternalPrecondition[],
      toolCall,
    )
  }

  getObservePostconditions(toolCall: ToolCall): InternalPostcondition[] {
    return Edictum._filterByTool(
      this._state.observePostconditions as InternalPostcondition[],
      toolCall,
    )
  }

  getObserveSessionContracts(): InternalSessionRule[] {
    return [...this._state.observeSessionContracts]
  }

  getObserveSandboxContracts(toolCall: ToolCall): InternalSandboxRule[] {
    return Edictum._filterSandbox(
      this._state.observeSandboxContracts as InternalSandboxRule[],
      toolCall,
    )
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Classify user-facing and internal rules into enforce/observe lists.
   *
   * User-facing rules (Precondition, Postcondition, SessionRule)
   * are converted to internal representations. Internal rules (from
   * YAML compiler) carry _edictum_* metadata and are classified by their
   * _edictum_observe flag (Python uses _edictum_shadow — wire-format parity).
   */
  private static _classifyContracts(
    rules: ReadonlyArray<Precondition | Postcondition | SessionRule>,
    limits: OperationLimits,
    policyVersion: string | null,
  ): CompiledState {
    const pre: InternalPrecondition[] = []
    const post: InternalPostcondition[] = []
    const session: InternalSessionRule[] = []
    const sandbox: InternalSandboxRule[] = []
    const oPre: InternalPrecondition[] = []
    const oPost: InternalPostcondition[] = []
    const oSession: InternalSessionRule[] = []
    const oSandbox: InternalSandboxRule[] = []

    for (const item of rules) {
      const raw = item as unknown as Record<string, unknown>
      const edictumType = raw._edictum_type as string | undefined
      // Python YAML compiler emits _edictum_shadow; we accept both for wire-format parity
      const isObserve =
        (raw._edictum_observe as boolean) ?? (raw._edictum_shadow as boolean) ?? false

      if (edictumType != null) {
        // Internal rule (from YAML compiler)
        Edictum._classifyInternal(raw, edictumType, isObserve, {
          pre,
          post,
          session,
          sandbox,
          oPre,
          oPost,
          oSession,
          oSandbox,
        })
      } else if (isSessionRule(item)) {
        const name = (raw as NamedContract).name ?? 'anonymous'
        session.push({
          type: 'session_contract',
          name,
          check: (item as SessionRule).check,
        })
      } else if ('tool' in item && (item as { contractType?: string }).contractType === 'post') {
        const postItem = item as Postcondition
        const name = (raw as NamedContract).name ?? 'anonymous'
        post.push({
          type: 'postcondition',
          name,
          tool: postItem.tool,
          check: postItem.check,
          when: postItem.when,
        })
      } else if ('tool' in item) {
        // Fail-closed: reject unknown contractType and detect missing "post"
        const ct = (raw as { contractType?: unknown }).contractType
        if (ct != null && ct !== 'pre') {
          throw new EdictumConfigError(
            `Rule with tool "${(item as Precondition).tool}" has unknown contractType ` +
              `"${String(ct)}". Expected "pre" or omitted for Precondition, "post" for Postcondition.`,
          )
        }
        // Best-effort heuristic for JS consumers who forget contractType: "post".
        // NOTE: Function.length is unreliable for rest parameters (...args) and
        // default-valued params — both give length 0. This catches the common
        // case (explicit (toolCall, output)) but cannot guarantee detection.
        // Always set contractType: "post" explicitly.
        if (ct == null && item.check.length >= 2) {
          throw new EdictumConfigError(
            `Rule with tool "${(item as Precondition).tool}" has a check function with ` +
              `${item.check.length} parameters (looks like a Postcondition) but is missing ` +
              `contractType: "post". Add it to prevent misclassification.`,
          )
        }
        const preItem = item as Precondition
        const name = (raw as NamedContract).name ?? 'anonymous'
        pre.push({
          type: 'precondition',
          name,
          tool: preItem.tool,
          check: preItem.check,
          when: preItem.when,
        })
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
    })
  }

  /** Route an internal rule to the appropriate enforce/observe list. */
  private static _classifyInternal(
    raw: Record<string, unknown>,
    edictumType: string,
    isObserve: boolean,
    lists: {
      pre: InternalPrecondition[]
      post: InternalPostcondition[]
      session: InternalSessionRule[]
      sandbox: InternalSandboxRule[]
      oPre: InternalPrecondition[]
      oPost: InternalPostcondition[]
      oSession: InternalSessionRule[]
      oSandbox: InternalSandboxRule[]
    },
  ): void {
    const target = isObserve
      ? { pre: lists.oPre, post: lists.oPost, session: lists.oSession, sandbox: lists.oSandbox }
      : { pre: lists.pre, post: lists.post, session: lists.session, sandbox: lists.sandbox }

    if (edictumType === 'precondition') target.pre.push(raw as unknown as InternalPrecondition)
    else if (edictumType === 'postcondition')
      target.post.push(raw as unknown as InternalPostcondition)
    else if (edictumType === 'session_contract')
      target.session.push(raw as unknown as InternalSessionRule)
    else if (edictumType === 'sandbox') target.sandbox.push(raw as unknown as InternalSandboxRule)
    else {
      throw new EdictumConfigError(
        `Unknown _edictum_type "${edictumType}". ` +
          `Expected "precondition", "postcondition", "session_contract", or "sandbox".`,
      )
    }
  }

  /** Filter rules by tool pattern and optional `when` guard. */
  private static _filterByTool<
    T extends {
      readonly tool: string
      readonly when?: ((toolCall: ToolCall) => boolean) | null
    },
  >(rules: T[], toolCall: ToolCall): T[] {
    const result: T[] = []
    for (const p of rules) {
      const tool = p.tool ?? '*'
      const when = p.when ?? null
      if (tool !== '*' && !fnmatch(toolCall.toolName, tool)) {
        continue
      }
      if (when != null) {
        try {
          if (!when(toolCall)) continue
        } catch {
          // Fail-closed: throwing predicate includes the rule (not excludes)
          // so it gets evaluated and can deny — safer than silently skipping.
        }
      }
      result.push(p)
    }
    return result
  }

  /** Filter sandbox rules by tool patterns array. */
  private static _filterSandbox(
    rules: InternalSandboxRule[],
    toolCall: ToolCall,
  ): InternalSandboxRule[] {
    const result: InternalSandboxRule[] = []
    for (const s of rules) {
      const tools = s.tools ?? ['*']
      if (tools.some((p) => fnmatch(toolCall.toolName, p))) {
        result.push(s)
      }
    }
    return result
  }

  // -----------------------------------------------------------------------
  // Delegated methods — run, evaluate, evaluateBatch
  // -----------------------------------------------------------------------

  /** Execute a tool call with full governance pipeline. */
  async run(
    toolName: string,
    args: Record<string, unknown>,
    toolCallable: (args: Record<string, unknown>) => unknown | Promise<unknown>,
    options?: {
      sessionId?: string
      environment?: string
      principal?: Principal
    },
  ): Promise<unknown> {
    const { run } = await import('./runner.js')
    return run(this, toolName, args, toolCallable, options)
  }

  /**
   * Dry-run evaluation of a tool call against all matching rules.
   *
   * Never executes the tool. Evaluates exhaustively (no short-circuit).
   * Session rules are skipped.
   */
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      principal?: Principal
      output?: string
      environment?: string
    },
  ): Promise<EvaluationResult> {
    // Dynamic import avoids circular dependency
    return import('./dry-run.js').then(({ evaluate }) => evaluate(this, toolName, args, options))
  }

  /** Evaluate a batch of tool calls. Thin wrapper over evaluate(). */
  evaluateBatch(
    calls: Array<{
      tool: string
      args?: Record<string, unknown>
      principal?: Record<string, unknown>
      output?: string | Record<string, unknown>
      environment?: string
    }>,
  ): Promise<EvaluationResult[]> {
    return import('./dry-run.js').then(({ evaluateBatch }) => evaluateBatch(this, calls))
  }

  // -----------------------------------------------------------------------
  // YAML factory methods — delegate to factory.ts
  // Circular dependency (factory.ts imports guard.ts) is safe because
  // ESM resolves all bindings before user code calls these methods.
  // -----------------------------------------------------------------------

  /**
   * Create an Edictum instance from one or more YAML rule bundle paths.
   *
   * When multiple paths are given, bundles are composed left-to-right
   * (later layers override earlier ones).
   *
   * When the trailing options object has `returnReport: true`, returns
   * a tuple of [Edictum, CompositionReport].
   */
  static fromYaml(
    ...args: [...string[], FromYamlOptions & { returnReport: true }]
  ): [Edictum, CompositionReport]
  static fromYaml(...args: [...string[], FromYamlOptions] | string[]): Edictum
  static fromYaml(
    ...args: [...string[], FromYamlOptions] | string[]
  ): Edictum | [Edictum, CompositionReport] {
    return _fromYaml(...args)
  }

  /**
   * Create an Edictum instance from a YAML string or Uint8Array.
   */
  static fromYamlString(content: string | Uint8Array, options?: YamlFactoryOptions): Edictum {
    return _fromYamlString(content, options)
  }

  /**
   * Atomically replace this guard's rules from a YAML string.
   *
   * Pass customOperators/customSelectors if the new YAML uses custom
   * operators or selectors that were passed to fromYaml/fromYamlString.
   */
  reload(yamlContent: string, options?: ReloadOptions): void {
    _reload(this, yamlContent, options)
  }
}
