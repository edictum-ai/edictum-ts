import type { ToolEnvelope } from '../envelope.js'
import type { Session } from '../session.js'
import { getWorkflowStageById, type WorkflowStage } from './definition.js'
import {
  WorkflowAction,
  createWorkflowEvaluation,
  type WorkflowEvaluation,
  type WorkflowState,
  workflowStateCompletedStage,
} from './result.js'
import type { WorkflowRuntime } from './runtime.js'
import {
  getNextWorkflowStageIndex,
  mustWorkflowStageIndex,
  workflowEvaluationFromRecord,
  workflowMetadata,
  workflowProgressEvent,
} from './runtime-helpers.js'
import { evaluateCurrentWorkflowStage } from './runtime-stage.js'
import { loadWorkflowState, saveWorkflowState } from './state.js'
import { workflowGateRecord } from './evaluator.js'

type WorkflowEnvelopeContinuation = 'boundary' | 'handled' | 'none'

export async function evaluateWorkflowRuntime(
  runtime: WorkflowRuntime,
  session: Session,
  envelope: ToolEnvelope,
): Promise<WorkflowEvaluation> {
  const state = await loadWorkflowState(session, runtime.definition)
  if (state.activeStage === '') {
    return createWorkflowEvaluation({ action: WorkflowAction.ALLOW })
  }

  let changed = false
  const events: Record<string, unknown>[] = []

  for (;;) {
    const stage = getWorkflowStageById(runtime.definition, state.activeStage)
    if (stage == null) {
      throw new Error(`workflow: active stage ${JSON.stringify(state.activeStage)} not found`)
    }

    const currentStage = evaluateCurrentWorkflowStage(runtime, stage, envelope)
    if (currentStage.allowed) {
      if (changed) {
        await saveWorkflowState(session, runtime.definition, state)
      }
      return {
        ...currentStage.evaluation,
        events: [...currentStage.evaluation.events, ...events],
      }
    }

    if (currentStage.invalidEvaluation != null && currentStage.invalidKind === 'check') {
      if (changed) {
        await saveWorkflowState(session, runtime.definition, state)
      }
      return {
        ...currentStage.invalidEvaluation,
        events: [...currentStage.invalidEvaluation.events, ...events],
      }
    }

    const nextIndex = getNextWorkflowStageIndex(runtime.definition, stage.id)
    const hasNext = nextIndex != null
    if (currentStage.invalidEvaluation != null && !hasNext) {
      return currentStage.invalidEvaluation
    }

    const completion = await evaluateWorkflowCompletion(runtime, stage, state, envelope, hasNext)
    if (!completion.completed) {
      if (
        completion.evaluation.action !== WorkflowAction.ALLOW ||
        completion.evaluation.reason !== ''
      ) {
        if (changed && completion.evaluation.action === WorkflowAction.PENDING_APPROVAL) {
          await saveWorkflowState(session, runtime.definition, state)
        }
        return {
          ...completion.evaluation,
          events: [...completion.evaluation.events, ...events],
        }
      }
      if (currentStage.invalidEvaluation != null) {
        return currentStage.invalidEvaluation
      }
      return completion.evaluation
    }

    if (!workflowStateCompletedStage(state, stage.id)) {
      state.completedStages.push(stage.id)
    }

    if (!hasNext) {
      state.activeStage = ''
      events.push(
        workflowProgressEvent('workflow_completed', runtime.definition.metadata.name, stage.id, ''),
      )
      await saveWorkflowState(session, runtime.definition, state)
      return createWorkflowEvaluation({
        action: WorkflowAction.ALLOW,
        events,
      })
    }

    const nextStageId = runtime.definition.stages[nextIndex]?.id ?? ''
    state.activeStage = nextStageId
    events.push(
      workflowProgressEvent(
        'workflow_stage_advanced',
        runtime.definition.metadata.name,
        stage.id,
        nextStageId,
      ),
    )
    changed = true
  }
}

async function evaluateWorkflowCompletion(
  runtime: WorkflowRuntime,
  stage: WorkflowStage,
  state: WorkflowState,
  envelope: ToolEnvelope,
  hasNext: boolean,
): Promise<{ evaluation: WorkflowEvaluation; completed: boolean }> {
  if (stage.exit.length > 0) {
    const exitResult = await runtime.evaluateWorkflowGates(stage, state, envelope, stage.exit)
    if (exitResult.blocked) {
      return { evaluation: exitResult.evaluation, completed: false }
    }
  }

  if (stage.approval != null && state.approvals[stage.id] !== 'approved') {
    return {
      evaluation: workflowEvaluationFromRecord(
        WorkflowAction.PENDING_APPROVAL,
        stage.id,
        stage.approval.message,
        workflowMetadata(
          runtime.definition.metadata.name,
          stage.id,
          'approval',
          'stage boundary',
          false,
          '',
          {
            approval_requested_for: stage.id,
          },
        ),
        workflowGateRecord(
          {
            passed: false,
            evidence: '',
            kind: 'approval',
            condition: 'stage boundary',
            message: stage.approval.message,
            stageId: stage.id,
            workflow: runtime.definition.metadata.name,
            extraAudit: {
              approval_requested_for: stage.id,
            },
          },
          false,
        ),
      ),
      completed: false,
    }
  }

  if (!hasNext) {
    if (stage.exit.length > 0 || stage.approval != null) {
      return {
        evaluation: createWorkflowEvaluation({ action: WorkflowAction.ALLOW }),
        completed: true,
      }
    }
    return { evaluation: createWorkflowEvaluation(), completed: false }
  }

  const nextStageIndex = mustWorkflowStageIndex(runtime.definition, stage.id) + 1
  const nextStage = runtime.definition.stages[nextStageIndex]
  if (nextStage == null) {
    throw new Error(`workflow: next stage after ${JSON.stringify(stage.id)} not found`)
  }
  const nextState = {
    ...state,
    completedStages: workflowStateCompletedStage(state, stage.id)
      ? [...state.completedStages]
      : [...state.completedStages, stage.id],
  }
  const entryResult = await runtime.evaluateWorkflowGates(
    nextStage,
    nextState,
    envelope,
    nextStage.entry,
  )
  if (entryResult.blocked) {
    return { evaluation: entryResult.evaluation, completed: false }
  }

  if (stage.exit.length === 0 && stage.approval == null) {
    const continuation = await detectWorkflowEnvelopeContinuation(
      runtime,
      nextState,
      nextStageIndex,
      envelope,
    )
    if (continuation === 'none') {
      return { evaluation: createWorkflowEvaluation(), completed: false }
    }
  }

  return { evaluation: createWorkflowEvaluation(), completed: true }
}

async function detectWorkflowEnvelopeContinuation(
  runtime: WorkflowRuntime,
  state: WorkflowState,
  stageIndex: number,
  envelope: ToolEnvelope,
): Promise<WorkflowEnvelopeContinuation> {
  const stage = runtime.definition.stages[stageIndex]
  if (stage == null) {
    throw new Error(`workflow: stage at index ${stageIndex} not found`)
  }

  const currentStage = evaluateCurrentWorkflowStage(runtime, stage, envelope)
  if (currentStage.allowed || currentStage.invalidKind === 'check') {
    return 'handled'
  }

  const nextIndex = getNextWorkflowStageIndex(runtime.definition, stage.id)
  if (nextIndex == null) {
    if (stage.exit.length > 0) {
      const exitResult = await runtime.evaluateWorkflowGates(stage, state, envelope, stage.exit)
      if (!exitResult.blocked) {
        return 'handled'
      }
    }
    if (stage.approval != null || (stage.tools.length === 0 && stage.checks.length === 0)) {
      return 'boundary'
    }
    return 'none'
  }

  const nextStage = runtime.definition.stages[nextIndex]
  if (nextStage == null) {
    throw new Error(`workflow: next stage after ${JSON.stringify(stage.id)} not found`)
  }

  const nextState: WorkflowState = {
    ...state,
    completedStages: workflowStateCompletedStage(state, stage.id)
      ? [...state.completedStages]
      : [...state.completedStages, stage.id],
  }
  const entryResult = await runtime.evaluateWorkflowGates(
    nextStage,
    nextState,
    envelope,
    nextStage.entry,
  )
  if (entryResult.blocked) {
    return 'none'
  }

  const continuation = await detectWorkflowEnvelopeContinuation(
    runtime,
    nextState,
    nextIndex,
    envelope,
  )
  if (stage.approval != null || stage.exit.length > 0) {
    return continuation
  }

  return continuation === 'handled' ? 'handled' : 'none'
}
