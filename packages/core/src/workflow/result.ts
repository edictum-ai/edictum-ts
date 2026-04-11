import { deepFreeze } from '../tool-call.js'
import {
  defaultWorkflowPendingApproval,
  type WorkflowBlockedAction,
  type WorkflowContext,
  type WorkflowPendingApproval,
  type WorkflowRecordedEvidence,
} from './context.js'

export const WorkflowAction = {
  ALLOW: 'allow',
  BLOCK: 'block',
  PENDING_APPROVAL: 'pending_approval',
} as const

export type WorkflowAction = (typeof WorkflowAction)[keyof typeof WorkflowAction]

export interface WorkflowEvaluation {
  readonly action: WorkflowAction
  readonly reason: string
  readonly stageId: string
  readonly records: Record<string, unknown>[]
  readonly audit: Record<string, unknown> | WorkflowContext | null
  readonly events: Record<string, unknown>[]
}

export interface WorkflowState {
  readonly sessionId: string
  readonly activeStage: string
  readonly completedStages: readonly string[]
  readonly approvals: Readonly<Record<string, string>>
  readonly evidence: WorkflowEvidence
  readonly blockedReason: string | null
  readonly pendingApproval: WorkflowPendingApproval
  readonly lastBlockedAction: WorkflowBlockedAction | null
  readonly lastRecordedEvidence: WorkflowRecordedEvidence | null
}

export interface WorkflowEvidence {
  readonly reads: readonly string[]
  readonly stageCalls: Readonly<Record<string, readonly string[]>>
  readonly mcpResults: Readonly<Record<string, readonly Record<string, unknown>[]>>
}

export interface MutableWorkflowState {
  sessionId: string
  activeStage: string
  completedStages: string[]
  approvals: Record<string, string>
  evidence: MutableWorkflowEvidence
  blockedReason: string | null
  pendingApproval: WorkflowPendingApproval
  lastBlockedAction: WorkflowBlockedAction | null
  lastRecordedEvidence: WorkflowRecordedEvidence | null
}

export interface MutableWorkflowEvidence {
  reads: string[]
  stageCalls: Record<string, string[]>
  mcpResults: Record<string, Record<string, unknown>[]>
}

export function createWorkflowEvaluation(
  fields: Partial<WorkflowEvaluation> = {},
): WorkflowEvaluation {
  return deepFreeze({
    action: fields.action ?? WorkflowAction.ALLOW,
    reason: fields.reason ?? '',
    stageId: fields.stageId ?? '',
    records: fields.records ?? [],
    audit: fields.audit ?? null,
    events: fields.events ?? [],
  })
}

export function workflowStateCompletedStage(state: WorkflowState, stageId: string): boolean {
  return state.completedStages.includes(stageId)
}

export function ensureWorkflowState(state: Partial<MutableWorkflowState>): MutableWorkflowState {
  const normalized = state as MutableWorkflowState
  normalized.sessionId ??= ''
  normalized.activeStage ??= ''
  normalized.completedStages ??= []
  normalized.approvals ??= {}
  const evidence = (normalized.evidence ??= { reads: [], stageCalls: {}, mcpResults: {} })
  evidence.reads ??= []
  evidence.stageCalls ??= {}
  evidence.mcpResults ??= {}
  normalized.blockedReason ??= null
  normalized.pendingApproval ??= defaultWorkflowPendingApproval()
  if (typeof normalized.pendingApproval.required !== 'boolean') {
    normalized.pendingApproval = defaultWorkflowPendingApproval()
  }
  normalized.lastBlockedAction ??= null
  normalized.lastRecordedEvidence ??= null
  return normalized
}

export function createWorkflowStateSnapshot(state: WorkflowState): WorkflowState {
  return {
    sessionId: state.sessionId,
    activeStage: state.activeStage,
    completedStages: [...state.completedStages],
    approvals: { ...state.approvals },
    evidence: {
      reads: [...state.evidence.reads],
      stageCalls: Object.fromEntries(
        Object.entries(state.evidence.stageCalls).map(([stageId, commands]) => [
          stageId,
          [...commands],
        ]),
      ),
      mcpResults: Object.fromEntries(
        Object.entries(state.evidence.mcpResults).map(([tool, results]) => [
          tool,
          results.map((r) => ({ ...r })),
        ]),
      ),
    },
    blockedReason: state.blockedReason,
    pendingApproval: { ...state.pendingApproval },
    lastBlockedAction: state.lastBlockedAction == null ? null : { ...state.lastBlockedAction },
    lastRecordedEvidence:
      state.lastRecordedEvidence == null ? null : { ...state.lastRecordedEvidence },
  }
}
