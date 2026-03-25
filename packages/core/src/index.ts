/** Edictum — Runtime contract enforcement for AI agent tool calls. */

export const VERSION = '0.1.0'

// Errors
export { EdictumConfigError, EdictumDenied, EdictumToolError } from './errors.js'

// Envelope & Classification
export {
  BashClassifier,
  createEnvelope,
  createPrincipal,
  deepFreeze,
  SideEffect,
  ToolRegistry,
  _validateToolName,
} from './envelope.js'
export type { CreateEnvelopeOptions, Principal, ToolEnvelope } from './envelope.js'

// Contracts
export { Verdict } from './contracts.js'
export type { Precondition, Postcondition, SessionContract } from './contracts.js'

// Hooks
export { HookDecision, HookResult } from './hooks.js'

// Limits
export { DEFAULT_LIMITS } from './limits.js'
export type { OperationLimits } from './limits.js'

// Types (internal, but exported for adapter authors)
export type { HookRegistration, ToolConfig } from './types.js'

// Storage
export { MemoryBackend } from './storage.js'
export type { StorageBackend } from './storage.js'

// Session
export { Session } from './session.js'

// Approval
export { ApprovalStatus, LocalApprovalBackend } from './approval.js'
export type { ApprovalBackend, ApprovalDecision, ApprovalRequest } from './approval.js'

// Audit
export {
  AuditAction,
  CollectingAuditSink,
  CompositeSink,
  createAuditEvent,
  FileAuditSink,
  MarkEvictedError,
  StdoutAuditSink,
} from './audit.js'
export type { AuditEvent, AuditSink } from './audit.js'

// Redaction
export { RedactionPolicy } from './redaction.js'

// Evaluation
export { createContractResult, createEvaluationResult } from './evaluation.js'
export type { ContractResult, EvaluationResult } from './evaluation.js'

// Findings
export { buildFindings, classifyFinding, createFinding, createPostCallResult } from './findings.js'
export type { Finding, PostCallResult, PostDecisionLike } from './findings.js'

// Internal contract types (for adapter and YAML engine authors)
export type {
  GuardLike,
  InternalContract,
  InternalPrecondition,
  InternalPostcondition,
  InternalSessionContract,
  InternalSandboxContract,
} from './internal-contracts.js'

// Compiled state
export { createCompiledState } from './compiled-state.js'
export type { CompiledState } from './compiled-state.js'

// Pipeline
export { GovernancePipeline, createPreDecision, createPostDecision } from './pipeline.js'
export type { PreDecision, PostDecision } from './pipeline.js'

// Guard
export { Edictum } from './guard.js'
export type { EdictumOptions } from './guard.js'

// Runner (framework-agnostic tool execution)
export { defaultSuccessCheck, run } from './runner.js'
export type { RunOptions } from './runner.js'

// Dry-run evaluation
export type { BatchCall, EvaluateOptions } from './dry-run.js'

// Fnmatch
export { fnmatch } from './fnmatch.js'

// YAML Factory
export { fromYaml, fromYamlString, reload } from './factory.js'
export type { YamlFactoryOptions, FromYamlOptions, ReloadOptions } from './factory.js'

// YAML Engine (public API)
export {
  evaluateExpression,
  PolicyError,
  BUILTIN_OPERATOR_NAMES,
  BUILTIN_SELECTOR_PREFIXES,
  MAX_REGEX_INPUT,
} from './yaml-engine/index.js'
export type { CustomOperator, CustomSelector } from './yaml-engine/index.js'
export {
  compileContracts,
  loadBundle,
  loadBundleString,
  computeHash,
  ensureYamlLoaded,
  MAX_BUNDLE_SIZE,
  composeBundles,
  expandMessage,
  validateOperators,
} from './yaml-engine/index.js'
export type {
  CompiledBundle,
  CompileOptions,
  BundleHash,
  ComposedBundle,
  CompositionReport,
  CompositionOverride,
  ObserveContract,
  EvaluateOptions as ExpressionEvaluateOptions,
} from './yaml-engine/index.js'
