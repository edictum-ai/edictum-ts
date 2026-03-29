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
  readonly sessionId: string
  readonly activeStage: string
  readonly completedStages: readonly string[]
  readonly approvals: Readonly<Record<string, string>>
  readonly evidence: WorkflowEvidence
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
}

export interface MutableWorkflowEvidence {
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

export function ensureWorkflowState(state: Partial<MutableWorkflowState>): MutableWorkflowState {
  const normalized = state as MutableWorkflowState
  normalized.sessionId ??= ''
  normalized.activeStage ??= ''
  normalized.completedStages ??= []
  normalized.approvals ??= {}
  const evidence = (normalized.evidence ??= { reads: [], stageCalls: {} })
  evidence.reads ??= []
  evidence.stageCalls ??= {}
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
  }
}
