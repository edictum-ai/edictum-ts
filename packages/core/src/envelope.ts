/** Tool Invocation Envelope — immutable snapshot of a tool call. */

import { randomUUID } from "node:crypto";

import { EdictumConfigError } from "./errors.js";
import type { ToolConfig } from "./types.js";

// ---------------------------------------------------------------------------
// SideEffect
// ---------------------------------------------------------------------------

/**
 * Classification of tool side effects.
 *
 * Determines postcondition behavior and retry safety.
 *
 * DEFAULTS:
 * - Unregistered tools -> IRREVERSIBLE (conservative)
 * - Bash -> IRREVERSIBLE unless strict allowlist match
 * - Classification errors always err toward MORE restrictive
 */
export const SideEffect = {
  PURE: "pure",
  READ: "read",
  WRITE: "write",
  IRREVERSIBLE: "irreversible",
} as const;

export type SideEffect = (typeof SideEffect)[keyof typeof SideEffect];

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

/**
 * Identity context for audit attribution.
 *
 * NOTE: `claims` is a plain object. The Principal itself is frozen via
 * `Object.freeze()`, making the reference immutable. Callers should treat
 * claims as read-only after construction.
 */
export interface Principal {
  readonly userId: string | null;
  readonly serviceId: string | null;
  readonly orgId: string | null;
  readonly role: string | null;
  readonly ticketRef: string | null;
  readonly claims: Readonly<Record<string, unknown>>;
}

/** Create a frozen Principal with defaults for omitted fields. */
export function createPrincipal(
  partial: Partial<Principal> = {},
): Readonly<Principal> {
  const p: Principal = {
    userId: partial.userId ?? null,
    serviceId: partial.serviceId ?? null,
    orgId: partial.orgId ?? null,
    role: partial.role ?? null,
    ticketRef: partial.ticketRef ?? null,
    claims: partial.claims ?? {},
  };
  return deepFreeze(p);
}

// ---------------------------------------------------------------------------
// _validateToolName
// ---------------------------------------------------------------------------

/**
 * Validate tool_name: reject empty, control chars, path separators.
 *
 * Throws EdictumConfigError for:
 * - Empty string
 * - Any ASCII control character (code < 0x20 or code === 0x7f)
 * - Forward slash `/`
 * - Backslash `\`
 */
export function _validateToolName(toolName: string): void {
  if (!toolName) {
    throw new EdictumConfigError(`Invalid tool_name: ${JSON.stringify(toolName)}`);
  }
  for (let i = 0; i < toolName.length; i++) {
    const code = toolName.charCodeAt(i);
    const ch = toolName[i];
    if (code < 0x20 || code === 0x7f || ch === "/" || ch === "\\") {
      throw new EdictumConfigError(`Invalid tool_name: ${JSON.stringify(toolName)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// ToolEnvelope
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of a tool invocation.
 *
 * Prefer `createEnvelope()` factory for deep-copy guarantees.
 * Direct construction validates tool_name but does NOT deep-copy args.
 */
export interface ToolEnvelope {
  // Identity
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly callId: string;
  readonly runId: string;
  readonly callIndex: number;
  readonly parentCallId: string | null;

  // Classification
  readonly sideEffect: SideEffect;
  readonly idempotent: boolean;

  // Context
  readonly environment: string;
  readonly timestamp: Date;
  readonly caller: string;
  readonly toolUseId: string | null;

  // Principal
  readonly principal: Readonly<Principal> | null;

  // Extracted convenience fields
  readonly bashCommand: string | null;
  readonly filePath: string | null;

  // Extensible
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// deepFreeze
// ---------------------------------------------------------------------------

/**
 * Recursively freeze an object and all nested objects.
 *
 * Date objects are skipped — Object.freeze() cannot prevent mutation
 * via Date prototype methods (setFullYear, setTime, etc.) because Date
 * stores state in internal slots, not own properties.
 */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }
  // Date internal slots are not freezable — skip to avoid false sense of safety
  if (obj instanceof Date) {
    return obj;
  }
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && value !== undefined && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

/** Maps tool names to governance properties. Unregistered tools default to IRREVERSIBLE. */
export class ToolRegistry {
  private readonly _tools: Map<string, ToolConfig> = new Map();

  register(
    name: string,
    sideEffect: SideEffect = SideEffect.WRITE,
    idempotent: boolean = false,
  ): void {
    this._tools.set(name, { name, sideEffect, idempotent });
  }

  classify(
    toolName: string,
    _args: Record<string, unknown>,
  ): [SideEffect, boolean] {
    const cfg = this._tools.get(toolName);
    if (cfg) {
      return [cfg.sideEffect as SideEffect, cfg.idempotent];
    }
    return [SideEffect.IRREVERSIBLE, false];
  }
}

// ---------------------------------------------------------------------------
// BashClassifier
// ---------------------------------------------------------------------------

/**
 * Classify bash commands by side-effect level.
 *
 * Default is IRREVERSIBLE. Only downgraded to READ via strict
 * allowlist AND absence of shell operators.
 *
 * This is a heuristic, not a security boundary.
 */
export const BashClassifier = {
  READ_ALLOWLIST: [
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "find",
    "grep",
    "rg",
    "git status",
    "git log",
    "git diff",
    "git show",
    "git branch",
    "git remote",
    "git tag",
    "echo",
    "pwd",
    "whoami",
    "date",
    "which",
    "file",
    "stat",
    "du",
    "df",
    "tree",
    "less",
    "more",
  ] as const,

  SHELL_OPERATORS: [
    "\n",
    "\r",
    "<(",
    "<<",
    "$",
    "${",
    ">",
    ">>",
    "|",
    ";",
    "&&",
    "||",
    "$(",
    "`",
    "#{",
  ] as const,

  classify(command: string): SideEffect {
    const stripped = command.trim();
    if (!stripped) {
      return SideEffect.READ;
    }

    for (const op of BashClassifier.SHELL_OPERATORS) {
      if (stripped.includes(op)) {
        return SideEffect.IRREVERSIBLE;
      }
    }

    for (const allowed of BashClassifier.READ_ALLOWLIST) {
      if (stripped === allowed || stripped.startsWith(allowed + " ")) {
        return SideEffect.READ;
      }
    }

    return SideEffect.IRREVERSIBLE;
  },
} as const;

// ---------------------------------------------------------------------------
// safeDeepCopy — structuredClone with JSON roundtrip fallback
// ---------------------------------------------------------------------------

function safeDeepCopy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

// ---------------------------------------------------------------------------
// createEnvelope
// ---------------------------------------------------------------------------

/** Options for `createEnvelope()` beyond the required positional args. */
export interface CreateEnvelopeOptions {
  readonly runId?: string;
  readonly callIndex?: number;
  readonly callId?: string;
  readonly parentCallId?: string | null;
  readonly sideEffect?: SideEffect;
  readonly idempotent?: boolean;
  readonly environment?: string;
  readonly timestamp?: Date;
  readonly caller?: string;
  readonly toolUseId?: string | null;
  readonly principal?: Principal | null;
  readonly metadata?: Record<string, unknown>;
  readonly registry?: ToolRegistry | null;
}

/**
 * Factory that enforces immutability guarantees.
 *
 * Prefer this factory over direct construction — it deep-copies args
 * and metadata to ensure the envelope is a true immutable snapshot.
 */
export function createEnvelope(
  toolName: string,
  toolInput: Record<string, unknown>,
  options: CreateEnvelopeOptions = {},
): Readonly<ToolEnvelope> {
  _validateToolName(toolName);

  // Deep-copy for immutability
  const safeArgs = safeDeepCopy(toolInput);

  // Deep-copy metadata
  const safeMetadata = options.metadata ? safeDeepCopy(options.metadata) : {};

  // Deep-copy Principal to protect claims dict
  let safePrincipal: Readonly<Principal> | null = null;
  if (options.principal != null) {
    const p = options.principal;
    safePrincipal = createPrincipal({
      userId: p.userId,
      serviceId: p.serviceId,
      orgId: p.orgId,
      role: p.role,
      ticketRef: p.ticketRef,
      claims: p.claims ? safeDeepCopy(p.claims as Record<string, unknown>) : {},
    });
  }

  // Classification: explicit options > registry > defaults
  const registry = options.registry ?? null;
  let sideEffect: SideEffect = options.sideEffect ?? SideEffect.IRREVERSIBLE;
  let idempotent = options.idempotent ?? false;
  let bashCommand: string | null = null;
  let filePath: string | null = null;

  // Registry overrides defaults but not explicit options
  if (registry && options.sideEffect == null) {
    [sideEffect, idempotent] = registry.classify(toolName, safeArgs);
    if (options.idempotent != null) {
      idempotent = options.idempotent;
    }
  }

  // Extract convenience fields (handle both snake_case and camelCase keys)
  if (toolName === "Bash") {
    bashCommand = (safeArgs.command as string) ?? "";
    // BashClassifier wins over registry but NOT over explicit caller options
    if (options.sideEffect == null) {
      sideEffect = BashClassifier.classify(bashCommand);
    }
  } else if (
    toolName === "Read" ||
    toolName === "Glob" ||
    toolName === "Grep"
  ) {
    filePath =
      (safeArgs.file_path as string) ??
      (safeArgs.filePath as string) ??
      (safeArgs.path as string) ??
      null;
  } else if (toolName === "Write" || toolName === "Edit") {
    filePath =
      (safeArgs.file_path as string) ??
      (safeArgs.filePath as string) ??
      (safeArgs.path as string) ??
      null;
  }

  const envelope: ToolEnvelope = {
    toolName,
    args: safeArgs,
    callId: options.callId ?? randomUUID(),
    runId: options.runId ?? "",
    callIndex: options.callIndex ?? 0,
    parentCallId: options.parentCallId ?? null,
    sideEffect,
    idempotent,
    environment: options.environment ?? "production",
    timestamp: options.timestamp ?? new Date(),
    caller: options.caller ?? "",
    toolUseId: options.toolUseId ?? null,
    principal: safePrincipal,
    bashCommand,
    filePath,
    metadata: safeMetadata,
  };

  return deepFreeze(envelope);
}
