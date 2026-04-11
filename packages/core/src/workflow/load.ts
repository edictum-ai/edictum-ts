import { readFileSync, realpathSync } from 'node:fs'

import { loadAll } from 'js-yaml'

import { EdictumConfigError } from '../errors.js'
import {
  type WorkflowApproval,
  type WorkflowCheck,
  type WorkflowDefinition,
  type WorkflowGate,
  type WorkflowMetadata,
  type WorkflowStage,
  validateWorkflowDefinition,
} from './definition.js'
import { compileWorkflowRegex } from './evaluator.js'

export const MAX_WORKFLOW_DOCUMENT_SIZE = 1_048_576

export function loadWorkflow(path: string): WorkflowDefinition {
  try {
    return parseWorkflowDocument(readFileSync(realpathSync(path), 'utf8'))
  } catch (exc) {
    if (exc instanceof EdictumConfigError) {
      throw exc
    }
    throw new EdictumConfigError(`workflow: ${exc}`)
  }
}

export function loadWorkflowString(content: string | Uint8Array): WorkflowDefinition {
  return parseWorkflowDocument(typeof content === 'string' ? content : Buffer.from(content))
}

function parseWorkflowDocument(raw: string | Buffer): WorkflowDefinition {
  const buffer = typeof raw === 'string' ? Buffer.from(raw) : raw
  if (buffer.length > MAX_WORKFLOW_DOCUMENT_SIZE) {
    throw new EdictumConfigError(
      `workflow: document too large (${buffer.length} bytes, max ${MAX_WORKFLOW_DOCUMENT_SIZE})`,
    )
  }

  const documents: unknown[] = []
  try {
    loadAll(buffer.toString('utf8'), (doc) => {
      documents.push(doc)
    })
  } catch (exc) {
    throw new EdictumConfigError(`workflow: parse error: ${exc}`)
  }

  if (documents.length !== 1) {
    throw new EdictumConfigError('workflow: multiple YAML documents are not supported')
  }

  return validateWorkflowDefinition(normalizeWorkflowDefinition(documents[0]))
}

function normalizeWorkflowDefinition(value: unknown): WorkflowDefinition {
  const root = expectMapping(value, 'document')
  assertAllowedKeys(root, ['apiVersion', 'kind', 'metadata', 'stages'], 'workflow document')

  return {
    apiVersion: expectString(root.apiVersion, 'apiVersion'),
    kind: expectString(root.kind, 'kind'),
    metadata: normalizeWorkflowMetadata(root.metadata),
    stages: expectArray(root.stages, 'stages').map((stage, index) =>
      normalizeWorkflowStage(stage, `stages[${index}]`),
    ),
  }
}

function normalizeWorkflowMetadata(value: unknown): WorkflowMetadata {
  const metadata = expectMapping(value, 'metadata')
  assertAllowedKeys(metadata, ['name', 'description', 'version'], 'metadata')
  return {
    name: expectString(metadata.name, 'metadata.name'),
    description: expectOptionalString(metadata.description, 'metadata.description'),
    version: expectOptionalString(metadata.version, 'metadata.version'),
  }
}

function normalizeWorkflowStage(value: unknown, label: string): WorkflowStage {
  const stage = expectMapping(value, label)
  assertAllowedKeys(
    stage,
    ['id', 'description', 'entry', 'tools', 'checks', 'exit', 'approval', 'terminal'],
    label,
  )

  return {
    id: expectString(stage.id, `${label}.id`),
    description: expectOptionalString(stage.description, `${label}.description`),
    entry: expectOptionalArray(stage.entry, `${label}.entry`).map((gate, index) =>
      normalizeWorkflowGate(gate, `${label}.entry[${index}]`),
    ),
    tools: expectOptionalArray(stage.tools, `${label}.tools`).map((tool, index) =>
      expectString(tool, `${label}.tools[${index}]`),
    ),
    checks: expectOptionalArray(stage.checks, `${label}.checks`).map((check, index) =>
      normalizeWorkflowCheck(check, `${label}.checks[${index}]`),
    ),
    exit: expectOptionalArray(stage.exit, `${label}.exit`).map((gate, index) =>
      normalizeWorkflowGate(gate, `${label}.exit[${index}]`),
    ),
    approval: stage.approval == null ? null : normalizeWorkflowApproval(stage.approval, label),
    terminal: expectOptionalBoolean(stage.terminal, `${label}.terminal`) ?? false,
  }
}

function normalizeWorkflowGate(value: unknown, label: string): WorkflowGate {
  const gate = expectMapping(value, label)
  assertAllowedKeys(gate, ['condition', 'message'], label)
  return {
    condition: expectString(gate.condition, `${label}.condition`),
    message: expectOptionalString(gate.message, `${label}.message`) ?? '',
  }
}

function normalizeWorkflowApproval(value: unknown, label: string): WorkflowApproval {
  const approval = expectMapping(value, `${label}.approval`)
  assertAllowedKeys(approval, ['message'], `${label}.approval`)
  return {
    message: expectString(approval.message, `${label}.approval.message`),
  }
}

function normalizeWorkflowCheck(value: unknown, label: string): WorkflowCheck {
  const check = expectMapping(value, label)
  assertAllowedKeys(check, ['command_matches', 'command_not_matches', 'message'], label)
  const commandMatches =
    expectOptionalString(check.command_matches, `${label}.command_matches`) ?? ''
  const commandNotMatches =
    expectOptionalString(check.command_not_matches, `${label}.command_not_matches`) ?? ''

  return {
    commandMatches,
    commandNotMatches,
    message: expectOptionalString(check.message, `${label}.message`) ?? '',
    commandMatchesRegex:
      commandMatches === '' ? null : compileWorkflowRegex(commandMatches, commandMatches),
    commandNotRegex:
      commandNotMatches === '' ? null : compileWorkflowRegex(commandNotMatches, commandNotMatches),
  }
}

function expectMapping(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new EdictumConfigError(`workflow: parse error: ${label} must be a mapping`)
  }
  return value as Record<string, unknown>
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new EdictumConfigError(`workflow: parse error: ${label} must be a sequence`)
  }
  return value
}

function expectOptionalArray(value: unknown, label: string): unknown[] {
  if (value == null) {
    return []
  }
  return expectArray(value, label)
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new EdictumConfigError(`workflow: parse error: ${label} must be a string`)
  }
  return value
}

function expectOptionalString(value: unknown, label: string): string | undefined {
  if (value == null) {
    return undefined
  }
  return expectString(value, label)
}

function expectOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value == null) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new EdictumConfigError(`workflow: parse error: ${label} must be a boolean`)
  }
  return value
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new EdictumConfigError(`workflow: parse error: unknown field ${label}.${key}`)
    }
  }
}
