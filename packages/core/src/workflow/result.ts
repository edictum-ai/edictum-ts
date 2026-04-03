import { deepFreeze } from '../tool-call.js'

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
  readonly audit: Record<string, unknown> | null
  readonly events: Record<string, unknown>[]
}

/** Structured pending approval context for workflow state snapshots. */
export interface PendingApproval {
  readonly required: boolean
  readonly stageId: string
  readonly message: string
}

/** Record of the last blocked tool call in a workflow. */
export interface BlockedAction {
  readonly tool: string
  readonly summary: string
  readonly message: string
  readonly timestamp: string
}

export interface WorkflowState {
  readonly sessionId: string
  readonly activeStage: string
  readonly completedStages: readonly string[]
  readonly approvals: Readonly<Record<string, string>>
  readonly evidence: WorkflowEvidence
  readonly blockedReason: string | null
  readonly pendingApproval: PendingApproval | null
  readonly lastBlockedAction: BlockedAction | null
}

export interface WorkflowEvidence {
  readonly reads: readonly string[]
  readonly stageCalls: Readonly<Record<string, readonly string[]>>
}

export interface MutableWorkflowState {
  sessionId: string
  activeStage: string
  completedStages: string[]
  approvals: Record<string, string>
  evidence: MutableWorkflowEvidence
  blockedReason: string | null
  pendingApproval: PendingApproval | null
  lastBlockedAction: BlockedAction | null
}

export interface MutableWorkflowEvidence {
  reads: string[]
  stageCalls: Record<string, string[]>
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
  const evidence = (normalized.evidence ??= { reads: [], stageCalls: {} })
  evidence.reads ??= []
  evidence.stageCalls ??= {}
  if (normalized.blockedReason === undefined) normalized.blockedReason = null
  if (normalized.pendingApproval === undefined) normalized.pendingApproval = null
  if (normalized.lastBlockedAction === undefined) normalized.lastBlockedAction = null
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
    },
    blockedReason: state.blockedReason,
    pendingApproval: state.pendingApproval ? { ...state.pendingApproval } : null,
    lastBlockedAction: state.lastBlockedAction ? { ...state.lastBlockedAction } : null,
  }
}
