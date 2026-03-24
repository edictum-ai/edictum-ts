// @edictum/openclaw — OpenClaw plugin factory
// Returns a plugin definition that can be loaded by OpenClaw's plugin system.

import type { Edictum } from '@edictum/core'
import type { Principal } from '@edictum/core'
import { createPrincipal } from '@edictum/core'

import { EdictumOpenClawAdapter } from './adapter.js'
import type { OpenClawAdapterOptions } from './adapter.js'
import type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  OpenClawPluginApi,
  ToolHookContext,
} from './types.js'

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface EdictumPluginOptions extends OpenClawAdapterOptions {
  /**
   * Hook priority. Higher runs first.
   * Default: 999 — run before most other plugins.
   */
  readonly priority?: number

  /**
   * Resolve OpenClaw sender context to an Edictum Principal.
   * Default: maps senderIsOwner to role "owner" vs "user".
   */
  readonly principalFromContext?: (ctx: ToolHookContext) => Principal
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Create an OpenClaw plugin definition that registers Edictum governance hooks.
 *
 * Usage:
 * ```typescript
 * import { Edictum } from "@edictum/core";
 * import { createEdictumPlugin } from "@edictum/openclaw";
 *
 * const guard = Edictum.fromYaml("contracts/openclaw-governance.yaml");
 * export default createEdictumPlugin(guard);
 * ```
 *
 * Or with options:
 * ```typescript
 * export default createEdictumPlugin(guard, {
 *   priority: 999,
 *   onDeny: (envelope, reason) => console.error(`[edictum] denied: ${reason}`),
 * });
 * ```
 */
export function createEdictumPlugin(guard: Edictum, options: EdictumPluginOptions = {}) {
  const priority = options.priority ?? 999

  // Default principal resolver: map OpenClaw context to Edictum Principal.
  // Capture principalFromContext in a const so the closure cannot observe
  // a later mutation of `options`.
  const capturedPrincipalFromContext = options.principalFromContext
  const principalResolver =
    options.principalResolver ??
    (capturedPrincipalFromContext
      ? (_toolName: string, _toolInput: Record<string, unknown>, ctx: ToolHookContext) =>
          capturedPrincipalFromContext(ctx)
      : undefined)

  return {
    id: 'edictum',
    name: 'Edictum Contract Enforcement',
    description:
      'Runtime contract enforcement for AI agent tool calls. Denies exfiltration, credential theft, destructive commands, and prompt injection.',
    register(api: OpenClawPluginApi) {
      const adapter = new EdictumOpenClawAdapter(guard, {
        ...options,
        principalResolver,
      })

      // --- before_tool_call: evaluate preconditions + sandboxes + session ---
      api.on(
        'before_tool_call',
        async (event: unknown, ctx: unknown) =>
          adapter.handleBeforeToolCall(event as BeforeToolCallEvent, ctx as ToolHookContext),
        { priority },
      )

      // --- after_tool_call: evaluate postconditions + emit audit ---
      api.on(
        'after_tool_call',
        async (event: unknown, ctx: unknown) => {
          await adapter.handleAfterToolCall(event as AfterToolCallEvent, ctx as ToolHookContext)
        },
        { priority },
      )
    },
  }
}

/**
 * Default principal resolver for OpenClaw.
 * Uses the ToolHookContext to determine sender identity.
 *
 * Maps:
 * - ctx.agentId → principal.serviceId
 * - ctx.sessionKey → principal.claims.sessionKey
 */
export function defaultPrincipalFromContext(ctx: ToolHookContext): Principal {
  return createPrincipal({
    serviceId: ctx.agentId ?? null,
    claims: {
      sessionKey: ctx.sessionKey ?? null,
      sessionId: ctx.sessionId ?? null,
      runId: ctx.runId ?? null,
    },
  })
}
