import { WorkflowAction, createWorkflowEvaluation, type WorkflowEvaluation } from './result.js'
import { workflowGateRecord } from './evaluator.js'
import type { WorkflowRuntime } from './runtime.js'
import {
  isWorkflowBoundaryOnlyStage,
  workflowEvaluationFromRecord,
  workflowMetadata,
  workflowToolAllowed,
} from './runtime-helpers.js'
import type { WorkflowStage } from './definition.js'
import type { ToolEnvelope } from '../envelope.js'

export interface WorkflowStageDecision {
  readonly allowed: boolean
  readonly evaluation: WorkflowEvaluation
  readonly invalidEvaluation: WorkflowEvaluation | null
}

export function evaluateCurrentWorkflowStage(
  runtime: WorkflowRuntime,
  stage: WorkflowStage,
  envelope: ToolEnvelope,
): WorkflowStageDecision {
  if (isWorkflowBoundaryOnlyStage(stage)) {
    return {
      allowed: false,
      evaluation: createWorkflowEvaluation(),
      invalidEvaluation: null,
    }
  }

  if (!workflowToolAllowed(stage, envelope)) {
    const condition = stage.tools.join(',')
    return {
      allowed: false,
      evaluation: createWorkflowEvaluation(),
      invalidEvaluation: workflowEvaluationFromRecord(
        WorkflowAction.BLOCK,
        stage.id,
        'Tool is not allowed in this workflow stage',
        workflowMetadata(
          runtime.definition.metadata.name,
          stage.id,
          'tools',
          condition,
          false,
          envelope.toolName,
        ),
        workflowGateRecord(
          {
            passed: false,
            evidence: envelope.toolName,
            kind: 'tools',
            condition,
            message: 'Tool is not allowed in this workflow stage',
            stageId: stage.id,
            workflow: runtime.definition.metadata.name,
          },
          false,
        ),
      ),
    }
  }

  for (const check of stage.checks) {
    const command = envelope.bashCommand ?? ''
    const passed =
      check.commandMatches !== ''
        ? (check.commandMatchesRegex?.test(command) ?? false)
        : check.commandNotRegex == null
          ? false
          : !check.commandNotRegex.test(command)

    if (!passed) {
      const condition = check.commandMatches !== '' ? check.commandMatches : check.commandNotMatches
      return {
        allowed: false,
        evaluation: createWorkflowEvaluation(),
        invalidEvaluation: workflowEvaluationFromRecord(
          WorkflowAction.BLOCK,
          stage.id,
          check.message,
          workflowMetadata(
            runtime.definition.metadata.name,
            stage.id,
            'check',
            condition,
            false,
            envelope.bashCommand ?? '',
          ),
          workflowGateRecord(
            {
              passed: false,
              evidence: command,
              kind: 'check',
              condition,
              message: check.message,
              stageId: stage.id,
              workflow: runtime.definition.metadata.name,
            },
            false,
          ),
        ),
      }
    }
  }

  const condition = stage.tools.length > 0 ? stage.tools.join(',') : 'tools'
  return {
    allowed: true,
    evaluation: workflowEvaluationFromRecord(
      WorkflowAction.ALLOW,
      stage.id,
      '',
      workflowMetadata(
        runtime.definition.metadata.name,
        stage.id,
        'tools',
        condition,
        true,
        envelope.toolName,
      ),
      workflowGateRecord(
        {
          passed: true,
          evidence: envelope.toolName,
          kind: 'tools',
          condition,
          message: 'tool allowed in active stage',
          stageId: stage.id,
          workflow: runtime.definition.metadata.name,
        },
        true,
      ),
    ),
    invalidEvaluation: null,
  }
}
