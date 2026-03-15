/** Edictum — Runtime contract enforcement for AI agent tool calls. */

export const VERSION = "0.1.0";

// Errors
export { EdictumConfigError, EdictumDenied, EdictumToolError } from "./errors.js";

// Envelope & Classification
export {
  BashClassifier,
  createEnvelope,
  createPrincipal,
  deepFreeze,
  SideEffect,
  ToolRegistry,
  _validateToolName,
} from "./envelope.js";
export type { CreateEnvelopeOptions, Principal, ToolEnvelope } from "./envelope.js";

// Contracts
export { Verdict } from "./contracts.js";
export type { Precondition, Postcondition, SessionContract } from "./contracts.js";

// Hooks
export { HookDecision, HookResult } from "./hooks.js";

// Limits
export { DEFAULT_LIMITS } from "./limits.js";
export type { OperationLimits } from "./limits.js";

// Types (internal, but exported for adapter authors)
export type { HookRegistration, ToolConfig } from "./types.js";

// Storage
export { MemoryBackend } from "./storage.js";
export type { StorageBackend } from "./storage.js";

// Session
export { Session } from "./session.js";

// Approval
export {
  ApprovalStatus,
  LocalApprovalBackend,
} from "./approval.js";
export type {
  ApprovalBackend,
  ApprovalDecision,
  ApprovalRequest,
} from "./approval.js";

// Audit
export {
  AuditAction,
  CollectingAuditSink,
  CompositeSink,
  createAuditEvent,
  FileAuditSink,
  MarkEvictedError,
  StdoutAuditSink,
} from "./audit.js";
export type { AuditEvent, AuditSink } from "./audit.js";

// Redaction
export { RedactionPolicy } from "./redaction.js";

// Evaluation
export { createContractResult, createEvaluationResult } from "./evaluation.js";
export type { ContractResult, EvaluationResult } from "./evaluation.js";

// Findings
export {
  buildFindings,
  classifyFinding,
  createFinding,
  createPostCallResult,
} from "./findings.js";
export type { Finding, PostCallResult, PostDecisionLike } from "./findings.js";

// Internal contract types (for adapter and YAML engine authors)
export type {
  GuardLike,
  InternalContract,
  InternalPrecondition,
  InternalPostcondition,
  InternalSessionContract,
  InternalSandboxContract,
} from "./internal-contracts.js";

// Compiled state
export { createCompiledState } from "./compiled-state.js";
export type { CompiledState } from "./compiled-state.js";

// Pipeline
export { GovernancePipeline, createPreDecision, createPostDecision } from "./pipeline.js";
export type { PreDecision, PostDecision } from "./pipeline.js";

// Guard
export { Edictum } from "./guard.js";
export type { EdictumOptions } from "./guard.js";

// Fnmatch
export { fnmatch } from "./fnmatch.js";
