export interface WorkflowPendingApproval {
  readonly required: boolean
  readonly stageId?: string
  readonly message?: string
}

export interface WorkflowBlockedAction {
  readonly tool: string
  readonly summary: string
  readonly message: string
  readonly timestamp: string
}

export interface WorkflowContext {
  readonly name: string
  readonly version?: string
  readonly activeStage: string
  readonly completedStages: readonly string[]
  readonly blockedReason: string | null
  readonly pendingApproval: WorkflowPendingApproval
  readonly lastBlockedAction?: WorkflowBlockedAction
}

export function defaultWorkflowPendingApproval(): WorkflowPendingApproval {
  return { required: false }
}
