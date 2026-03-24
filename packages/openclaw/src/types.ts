// @edictum/openclaw — OpenClaw type definitions
// These mirror OpenClaw's plugin types so we don't need a runtime import.
// OpenClaw remains a peerDependency for type checking only.

/**
 * Event passed to the before_tool_call hook handler.
 * @see OpenClaw src/plugins/types.ts PluginHookBeforeToolCallEvent
 */
export interface BeforeToolCallEvent {
  readonly toolName: string
  readonly params: Record<string, unknown>
  readonly runId?: string
  readonly toolCallId?: string
}

/**
 * Result returned from the before_tool_call hook handler.
 *
 * NOTE: OpenClaw wire protocol uses `block`/`blockReason`. Canonical Edictum
 * terminology is `deny`/`denyReason` — using `block` here is forced by the
 * OpenClaw plugin API contract (PluginHookBeforeToolCallResult).
 *
 * @see OpenClaw src/plugins/types.ts PluginHookBeforeToolCallResult
 */
export interface BeforeToolCallResult {
  params?: Record<string, unknown>
  block?: boolean
  blockReason?: string
}

/**
 * Event passed to the after_tool_call hook handler.
 * @see OpenClaw src/plugins/types.ts PluginHookAfterToolCallEvent
 */
export interface AfterToolCallEvent {
  readonly toolName: string
  readonly params: Record<string, unknown>
  readonly runId?: string
  readonly toolCallId?: string
  readonly result?: unknown
  readonly error?: string
  readonly durationMs?: number
}

/**
 * Context provided alongside hook events.
 * @see OpenClaw src/plugins/types.ts PluginHookToolContext
 */
export interface ToolHookContext {
  readonly agentId?: string
  readonly sessionKey?: string
  readonly sessionId?: string
  readonly runId?: string
  readonly toolName: string
  readonly toolCallId?: string
}

/**
 * Context provided for session lifecycle hooks.
 * @see OpenClaw src/plugins/types.ts PluginHookSessionContext
 */
export interface SessionHookContext {
  readonly agentId?: string
  readonly sessionId: string
  readonly sessionKey?: string
}

/**
 * Minimal OpenClaw plugin API surface used by the adapter.
 * The adapter only calls api.on() — nothing else.
 * @see OpenClaw src/plugins/types.ts OpenClawPluginApi
 */
export interface OpenClawPluginApi {
  readonly id: string
  readonly name: string
  readonly config: Record<string, unknown>
  readonly pluginConfig?: Record<string, unknown>
  on(hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }): void
}

/**
 * Finding from a postcondition evaluation.
 */
export interface Finding {
  readonly contractId: string | null
  readonly message: string
  readonly tags: readonly string[]
  readonly severity: string
}

/**
 * Result from post-execution governance.
 */
export interface PostCallResult {
  readonly result: unknown
  readonly postconditionsPassed: boolean
  readonly findings: readonly Finding[]
  readonly outputSuppressed: boolean
}
