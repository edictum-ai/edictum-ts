import { EdictumConfigError } from '../errors.js'
import type { ToolEnvelope } from '../envelope.js'
import type { WorkflowDefinition, WorkflowGate, WorkflowStage } from './definition.js'
import type { WorkflowState } from './result.js'

const MAX_WORKFLOW_REGEX_LENGTH = 10_000

export interface FactEvaluator {
  evaluate(request: EvaluateRequest): Promise<FactResult> | FactResult
}

export interface EvaluateRequest {
  readonly definition: WorkflowDefinition
  readonly stage: WorkflowStage
  readonly gate: WorkflowGate
  readonly parsed: ParsedCondition
  readonly state: WorkflowState
  readonly call: ToolEnvelope
}

export interface FactResult {
  readonly passed: boolean
  readonly evidence: string
  readonly kind: string
  readonly condition: string
  readonly message: string
  readonly stageId: string
  readonly workflow: string
  readonly extraAudit?: Record<string, unknown>
}

export interface ParsedCondition {
  readonly kind:
    | 'stage_complete'
    | 'file_read'
    | 'approval'
    | 'command_matches'
    | 'command_not_matches'
    | 'exec'
  readonly arg: string
  readonly exitCode: number
  readonly regex: RegExp | null
  readonly condition: string
}

const singleStringArgRe = /^([a-z_]+)\("((?:[^"\\]|\\.)*)"\)$/
const optionalArgRe = /^approval\((?:"((?:[^"\\]|\\.)*)")?\)$/
const execConditionRe = /^exec\("((?:[^"\\]|\\.)*)"(?:,\s*exit_code=(\d+))?\)$/

export function parseCondition(raw: string): ParsedCondition {
  if (raw.startsWith('stage_complete(')) {
    const arg = parseSingleStringArg(raw, 'stage_complete')
    return { kind: 'stage_complete', arg, exitCode: 0, regex: null, condition: raw }
  }
  if (raw.startsWith('file_read(')) {
    const arg = parseSingleStringArg(raw, 'file_read')
    return { kind: 'file_read', arg, exitCode: 0, regex: null, condition: raw }
  }
  if (raw.startsWith('approval(')) {
    const arg = parseOptionalStringArg(raw, 'approval')
    return { kind: 'approval', arg, exitCode: 0, regex: null, condition: raw }
  }
  if (raw.startsWith('command_matches(')) {
    const arg = parseSingleStringArg(raw, 'command_matches')
    return {
      kind: 'command_matches',
      arg,
      exitCode: 0,
      regex: compileWorkflowRegex(arg, raw),
      condition: raw,
    }
  }
  if (raw.startsWith('command_not_matches(')) {
    const arg = parseSingleStringArg(raw, 'command_not_matches')
    return {
      kind: 'command_not_matches',
      arg,
      exitCode: 0,
      regex: compileWorkflowRegex(arg, raw),
      condition: raw,
    }
  }
  if (raw.startsWith('exec(')) {
    const match = execConditionRe.exec(raw)
    if (match == null) {
      throw new EdictumConfigError(`workflow: unsupported exec condition ${JSON.stringify(raw)}`)
    }
    const command = JSON.parse(`"${match[1] ?? ''}"`) as string
    const exitCode = match[2] != null && match[2] !== '' ? Number.parseInt(match[2], 10) : 0
    return {
      kind: 'exec',
      arg: command,
      exitCode,
      regex: null,
      condition: raw,
    }
  }

  throw new EdictumConfigError(`workflow: unsupported condition ${JSON.stringify(raw)}`)
}

export function compileWorkflowRegex(pattern: string, context: string): RegExp {
  if (pattern.length > MAX_WORKFLOW_REGEX_LENGTH) {
    throw new EdictumConfigError(
      `workflow: regex in ${JSON.stringify(context)} exceeds ${MAX_WORKFLOW_REGEX_LENGTH} characters`,
    )
  }
  try {
    return new RegExp(pattern)
  } catch (exc) {
    throw new EdictumConfigError(`workflow: invalid regex in ${JSON.stringify(context)}: ${exc}`)
  }
}

export function workflowGateRecord(result: FactResult, passed: boolean): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    workflow_name: result.workflow,
    stage_id: result.stageId,
    gate_kind: result.kind,
    gate_condition: result.condition,
    gate_passed: passed,
    gate_evidence: result.evidence,
  }
  for (const [key, value] of Object.entries(result.extraAudit ?? {})) {
    metadata[key] = value
  }
  return {
    name: `${result.workflow}:${result.stageId}:${result.kind}`,
    type: 'workflow_gate',
    passed,
    message: result.message,
    metadata,
  }
}

export function usesExecCondition(definition: WorkflowDefinition): boolean {
  for (const stage of definition.stages) {
    for (const gate of [...stage.entry, ...stage.exit]) {
      if (parseCondition(gate.condition).kind === 'exec') {
        return true
      }
    }
  }
  return false
}

function parseSingleStringArg(raw: string, fn: string): string {
  const match = singleStringArgRe.exec(raw)
  if (match == null || match[1] !== fn) {
    throw new EdictumConfigError(`workflow: unsupported ${fn} condition ${JSON.stringify(raw)}`)
  }
  return JSON.parse(`"${match[2] ?? ''}"`) as string
}

function parseOptionalStringArg(raw: string, fn: string): string {
  const match = optionalArgRe.exec(raw)
  if (match == null || fn !== 'approval') {
    throw new EdictumConfigError(`workflow: unsupported ${fn} condition ${JSON.stringify(raw)}`)
  }
  if (!match[1]) {
    return ''
  }
  return JSON.parse(`"${match[1]}"`) as string
}
