import { fnmatch } from '../fnmatch.js'
import type { ToolEnvelope } from '../envelope.js'
import { getWorkflowStageIndex, type WorkflowDefinition, type WorkflowStage } from './definition.js'
import { createWorkflowEvaluation, type WorkflowAction, type WorkflowEvaluation } from './result.js'

export function workflowToolAllowed(stage: WorkflowStage, envelope: ToolEnvelope): boolean {
  if (stage.tools.length === 0) {
    return !stage.terminal
  }
  return stage.tools.some((pattern) => fnmatch(envelope.toolName, pattern))
}

export function isWorkflowBoundaryOnlyStage(stage: WorkflowStage): boolean {
  return (
    stage.tools.length === 0 &&
    stage.checks.length === 0 &&
    (stage.approval != null || stage.exit.length > 0)
  )
}

export function workflowProgressEvent(
  action: string,
  name: string,
  fromStageId: string,
  toStageId: string,
): Record<string, unknown> {
  const workflow: Record<string, unknown> = {
    workflow_name: name,
    stage_id: fromStageId,
  }
  if (toStageId !== '') {
    workflow.to_stage_id = toStageId
  }
  return { action, workflow }
}

export function workflowMetadata(
  name: string,
  stageId: string,
  kind: string,
  condition: string,
  passed: boolean,
  evidence: string,
  extra: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    workflow_name: name,
    stage_id: stageId,
    gate_kind: kind,
    gate_condition: condition,
    gate_passed: passed,
    gate_evidence: evidence,
    ...(extra ?? {}),
  }
}

export function workflowEvaluationFromRecord(
  action: WorkflowAction,
  stageId: string,
  reason: string,
  audit: Record<string, unknown>,
  record: Record<string, unknown>,
): WorkflowEvaluation {
  return createWorkflowEvaluation({
    action,
    reason,
    stageId,
    audit,
    records: [record],
  })
}

export function getNextWorkflowStageIndex(
  definition: WorkflowDefinition,
  stageId: string,
): number | null {
  const currentIndex = mustWorkflowStageIndex(definition, stageId)
  const nextIndex = currentIndex + 1
  return nextIndex < definition.stages.length ? nextIndex : null
}

export function mustWorkflowStageIndex(definition: WorkflowDefinition, stageId: string): number {
  const index = getWorkflowStageIndex(definition, stageId)
  if (index == null) {
    throw new Error(`workflow: active stage ${JSON.stringify(stageId)} not found`)
  }
  return index
}

export function joinWorkflowEvidence(items: readonly string[]): string {
  return items.join(' | ')
}

export function workflowStageIds(stages: readonly WorkflowStage[]): string[] {
  return stages.map((stage) => stage.id)
}
