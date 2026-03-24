// @edictum/openclaw — OpenClaw adapter for edictum
// Runtime contract enforcement for OpenClaw AI agent tool calls.

export const VERSION = '0.1.0' as const

// Adapter
export { EdictumOpenClawAdapter } from './adapter.js'
export type { OpenClawAdapterOptions } from './adapter.js'

// Plugin factory
export { createEdictumPlugin, defaultPrincipalFromContext } from './plugin.js'
export type { EdictumPluginOptions } from './plugin.js'

// Types
export type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  Finding,
  OpenClawPluginApi,
  PostCallResult,
  SessionHookContext,
  ToolHookContext,
} from './types.js'
