import { EdictumConfigError } from '../errors.js'
import { validateToolName } from '../tool-call.js'
import { compileWorkflowRegex, parseCondition } from './evaluator.js'

const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

const workflowStageIndex = new WeakMap<WorkflowDefinition, Map<string, number>>()

export interface WorkflowDefinition {
  readonly apiVersion: string
  readonly kind: string
  readonly metadata: WorkflowMetadata
  readonly stages: WorkflowStage[]
}

export interface WorkflowMetadata {
  readonly name: string
  readonly description?: string
}

export interface WorkflowStage {
  readonly id: string
  readonly description?: string
  readonly entry: WorkflowGate[]
  readonly tools: string[]
  readonly checks: WorkflowCheck[]
  readonly exit: WorkflowGate[]
  readonly approval: WorkflowApproval | null
}

export interface WorkflowGate {
  readonly condition: string
  readonly message: string
}

export interface WorkflowApproval {
  readonly message: string
}

export interface WorkflowCheck {
  readonly commandMatches: string
  readonly commandNotMatches: string
  readonly message: string
  readonly commandMatchesRegex: RegExp | null
  readonly commandNotRegex: RegExp | null
}

export function validateWorkflowDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  if (definition.apiVersion !== 'edictum/v1') {
    throw new EdictumConfigError('workflow: apiVersion must be "edictum/v1"')
  }
  if (definition.kind !== 'Workflow') {
    throw new EdictumConfigError('workflow: kind must be "Workflow"')
  }
  if (!WORKFLOW_NAME_RE.test(definition.metadata.name)) {
    throw new EdictumConfigError(
      `workflow: metadata.name must match ${JSON.stringify(WORKFLOW_NAME_RE.source)}`,
    )
  }
  if (definition.stages.length === 0) {
    throw new EdictumConfigError('workflow: stages must contain at least one item')
  }

  const index = new Map<string, number>()
  for (const [stageIndex, stage] of definition.stages.entries()) {
    validateWorkflowStage(stage)
    if (index.has(stage.id)) {
      throw new EdictumConfigError(`workflow: duplicate stage id ${JSON.stringify(stage.id)}`)
    }
    index.set(stage.id, stageIndex)
  }
  workflowStageIndex.set(definition, index)
  return definition
}

export function getWorkflowStageIndex(
  definition: WorkflowDefinition,
  stageId: string,
): number | null {
  const index = workflowStageIndex.get(definition)
  return index?.get(stageId) ?? null
}

export function getWorkflowStageById(
  definition: WorkflowDefinition,
  stageId: string,
): WorkflowStage | null {
  const index = getWorkflowStageIndex(definition, stageId)
  return index == null ? null : (definition.stages[index] ?? null)
}

function validateWorkflowStage(stage: WorkflowStage): void {
  if (!WORKFLOW_NAME_RE.test(stage.id)) {
    throw new EdictumConfigError(
      `workflow: stage.id ${JSON.stringify(stage.id)} must match ${JSON.stringify(WORKFLOW_NAME_RE.source)}`,
    )
  }

  for (const tool of stage.tools) {
    try {
      validateToolName(tool)
    } catch (exc) {
      throw new EdictumConfigError(
        `workflow: invalid tool ${JSON.stringify(tool)} in stage ${JSON.stringify(stage.id)}: ${exc}`,
      )
    }
  }

  for (const gate of [...stage.entry, ...stage.exit]) {
    if (gate.condition === '') {
      throw new EdictumConfigError(
        `workflow: stage ${JSON.stringify(stage.id)} gate condition must not be empty`,
      )
    }
    try {
      parseCondition(gate.condition)
    } catch (exc) {
      throw new EdictumConfigError(
        `workflow: stage ${JSON.stringify(stage.id)} invalid gate condition ${JSON.stringify(gate.condition)}: ${exc}`,
      )
    }
  }

  for (const check of stage.checks) {
    const hasMatches = check.commandMatches !== ''
    const hasNotMatches = check.commandNotMatches !== ''
    if (hasMatches === hasNotMatches) {
      throw new EdictumConfigError(
        `workflow: stage ${JSON.stringify(stage.id)} checks must set exactly one of command_matches or command_not_matches`,
      )
    }
    if (check.message === '') {
      throw new EdictumConfigError(
        `workflow: stage ${JSON.stringify(stage.id)} checks require message`,
      )
    }
    try {
      if (check.commandMatches !== '') {
        compileWorkflowRegex(check.commandMatches, check.commandMatches)
      }
      if (check.commandNotMatches !== '') {
        compileWorkflowRegex(check.commandNotMatches, check.commandNotMatches)
      }
    } catch (exc) {
      const fieldName = check.commandMatches !== '' ? 'command_matches' : 'command_not_matches'
      const value = check.commandMatches !== '' ? check.commandMatches : check.commandNotMatches
      throw new EdictumConfigError(
        `workflow: stage ${JSON.stringify(stage.id)} invalid ${fieldName} regex ${JSON.stringify(value)}: ${exc}`,
      )
    }
  }

  if (stage.approval != null && stage.approval.message === '') {
    throw new EdictumConfigError(
      `workflow: stage ${JSON.stringify(stage.id)} approval.message is required`,
    )
  }
}
