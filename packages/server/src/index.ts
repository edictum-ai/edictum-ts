/** @edictum/server — Server SDK (HTTP client, SSE, audit sink) for edictum. */

export const VERSION = '0.3.0' as const

// Client
export { EdictumServerClient, EdictumServerError, SAFE_IDENTIFIER_RE } from './client.js'
export type { EdictumServerClientOptions } from './client.js'

// Backend
export { ServerBackend } from './backend.js'

// Audit Sink
export { ServerAuditSink } from './audit-sink.js'

// Rule Source
export { ServerRuleSource } from './rule-source.js'

// Approval Backend
export { ServerApprovalBackend } from './approval-backend.js'

// Verification
export { BundleVerificationError, verifyBundleSignature } from './verification.js'

// Factory
export { createServerGuard } from './factory.js'
export type {
  CreateServerGuardOptions,
  ServerGuard,
  ServerGuardClient,
  WatchErrorHandler,
} from './factory.js'
