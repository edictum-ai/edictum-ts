import type { ToolEnvelope } from '../envelope.js'
import { getWorkflowStageById } from './definition.js'
import type { WorkflowState } from './result.js'
import { WORKFLOW_APPROVED_STATUS } from './state.js'
import type { WorkflowRuntime } from './runtime.js'
import { getNextWorkflowStageIndex, workflowProgressEvent } from './runtime-helpers.js'
import { workflowStateCompletedStage } from './result.js'

export async function advanceWorkflowAfterSuccess(
  runtime: WorkflowRuntime,
  state: WorkflowState,
  stageId: string,
  envelope: ToolEnvelope,
): Promise<Record<string, unknown>[]> {
  if (state.activeStage !== stageId) {
    return []
  }

  const stage = getWorkflowStageById(runtime.definition, stageId)
  if (stage == null) {
    throw new Error(`workflow: active stage ${JSON.stringify(stageId)} not found`)
  }

  if (getNextWorkflowStageIndex(runtime.definition, stage.id) != null) {
    return []
  }

  if (stage.exit.length > 0) {
    const exitEvaluation = await runtime.evaluateWorkflowGates(stage, state, envelope, stage.exit)
    if (exitEvaluation.blocked) {
      return []
    }
  }

  if (stage.approval != null && state.approvals[stage.id] !== WORKFLOW_APPROVED_STATUS) {
    return []
  }

  if (!workflowStateCompletedStage(state, stage.id)) {
    state.completedStages.push(stage.id)
  }
  state.activeStage = ''

  return [
    workflowProgressEvent('workflow_completed', runtime.definition.metadata.name, stage.id, ''),
  ]
}
