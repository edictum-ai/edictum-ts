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

export interface WorkflowState {
  sessionId: string
  activeStage: string
  completedStages: string[]
  approvals: Record<string, string>
  evidence: WorkflowEvidence
}

export interface WorkflowEvidence {
  reads: string[]
  stageCalls: Record<string, string[]>
}

export function createWorkflowEvaluation(
  fields: Partial<WorkflowEvaluation> = {},
): WorkflowEvaluation {
  return {
    action: fields.action ?? WorkflowAction.ALLOW,
    reason: fields.reason ?? '',
    stageId: fields.stageId ?? '',
    records: fields.records ?? [],
    audit: fields.audit ?? null,
    events: fields.events ?? [],
  }
}

export function workflowStateCompletedStage(state: WorkflowState, stageId: string): boolean {
  return state.completedStages.includes(stageId)
}

export function ensureWorkflowState(state: WorkflowState): WorkflowState {
  state.completedStages ??= []
  state.approvals ??= {}
  state.evidence ??= { reads: [], stageCalls: {} }
  state.evidence.reads ??= []
  state.evidence.stageCalls ??= {}
  return state
}
