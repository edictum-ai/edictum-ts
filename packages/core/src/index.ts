/** Edictum — Runtime rule enforcement for AI agent tool calls. */

export const VERSION = '0.4.0'

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
} from './tool-call.js'
export { validateToolName } from './tool-call.js'
export type { CreateEnvelopeOptions, Principal, ToolCall } from './tool-call.js'

// Contracts
export { Decision } from './rules.js'
export type { Precondition, Postcondition, SessionRule } from './rules.js'

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
export { createRuleResult, createEvaluationResult } from './evaluation.js'
export type { RuleResult, EvaluationResult } from './evaluation.js'

// Findings
export {
  buildViolations,
  classifyViolation,
  createViolation,
  createPostCallResult,
} from './violations.js'
export type { Violation, PostCallResult, PostDecisionLike } from './violations.js'

// Internal rule types (for adapter and YAML engine authors)
export type {
  GuardLike,
  InternalRule,
  InternalPrecondition,
  InternalPostcondition,
  InternalSessionRule,
  InternalSandboxRule,
} from './internal-rules.js'

// Compiled state
export { createCompiledState } from './compiled-state.js'
export type { CompiledState } from './compiled-state.js'

// Pipeline
export { CheckPipeline, createPreDecision, createPostDecision } from './pipeline.js'
export type { PreDecision, PostDecision } from './pipeline.js'

// Guard
export { Edictum } from './guard.js'
export type { EdictumOptions } from './guard.js'

// Workflow Gates
export {
  WorkflowAction,
  WorkflowRuntime,
  defaultWorkflowPendingApproval,
  loadWorkflow,
  loadWorkflowString,
} from './workflow/index.js'
export type {
  WorkflowBlockedAction,
  WorkflowApproval,
  WorkflowCheck,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowEvaluation,
  WorkflowEvidence,
  WorkflowGate,
  WorkflowMetadata,
  WorkflowPendingApproval,
  WorkflowRecordedEvidence,
  WorkflowRuntimeOptions,
  WorkflowStage,
  WorkflowState,
} from './workflow/index.js'

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
