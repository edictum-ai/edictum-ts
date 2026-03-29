import type { ToolEnvelope } from '../envelope.js'
import type { Session } from '../session.js'
import { getWorkflowStageById, type WorkflowDefinition } from './definition.js'
import { ensureWorkflowState, type WorkflowState } from './result.js'

export const WORKFLOW_APPROVED_STATUS = 'approved'
export const MAX_WORKFLOW_EVIDENCE_ITEMS = 1000

export function workflowStateKey(name: string): string {
  return `workflow:${name}:state`
}

export async function loadWorkflowState(
  session: Session,
  definition: WorkflowDefinition,
): Promise<WorkflowState> {
  const raw = await session.getValue(workflowStateKey(definition.metadata.name))
  if (raw == null) {
    return ensureWorkflowState({
      sessionId: session.sessionId,
      activeStage: definition.stages[0]?.id ?? '',
      completedStages: [],
      approvals: {},
      evidence: { reads: [], stageCalls: {} },
    })
  }

  const state = ensureWorkflowState(parseWorkflowState(raw))
  state.sessionId = session.sessionId
  if (state.activeStage !== '' && getWorkflowStageById(definition, state.activeStage) == null) {
    throw new Error(
      `workflow: persisted active stage ${JSON.stringify(state.activeStage)} does not exist`,
    )
  }
  return state
}

export async function saveWorkflowState(
  session: Session,
  definition: WorkflowDefinition,
  state: WorkflowState,
): Promise<void> {
  state.sessionId = session.sessionId
  ensureWorkflowState(state)
  await session.setValue(workflowStateKey(definition.metadata.name), JSON.stringify(state))
}

export function recordWorkflowApproval(state: WorkflowState, stageId: string): void {
  ensureWorkflowState(state)
  state.approvals[stageId] = WORKFLOW_APPROVED_STATUS
}

export function recordWorkflowResult(
  state: WorkflowState,
  stageId: string,
  envelope: ToolEnvelope,
): void {
  ensureWorkflowState(state)
  switch (envelope.toolName) {
    case 'Read': {
      if (envelope.filePath) {
        state.evidence.reads = appendUniqueCapped(
          state.evidence.reads,
          envelope.filePath,
          MAX_WORKFLOW_EVIDENCE_ITEMS,
        )
      }
      break
    }
    case 'Bash': {
      if (envelope.bashCommand) {
        state.evidence.stageCalls[stageId] = appendCapped(
          state.evidence.stageCalls[stageId] ?? [],
          envelope.bashCommand,
          MAX_WORKFLOW_EVIDENCE_ITEMS,
        )
      }
      break
    }
  }
}

function appendUniqueCapped(items: string[], item: string, limit: number): string[] {
  return items.includes(item) ? items : appendCapped(items, item, limit)
}

function appendCapped(items: string[], item: string, limit: number): string[] {
  if (items.length >= limit) {
    return items
  }
  return [...items, item]
}

function parseWorkflowState(raw: string): WorkflowState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (exc) {
    throw new Error(`workflow: decode persisted state: ${exc}`)
  }
  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
    throw new Error('workflow: decode persisted state: state must be an object')
  }
  const value = parsed as Record<string, unknown>
  const evidence = value.evidence as Record<string, unknown> | undefined
  const stageCalls = (evidence?.stageCalls ?? evidence?.stage_calls ?? {}) as Record<
    string,
    unknown
  >

  return {
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
    activeStage: typeof value.activeStage === 'string' ? value.activeStage : '',
    completedStages: normalizeStringArray(value.completedStages),
    approvals: normalizeStringMap(value.approvals),
    evidence: {
      reads: normalizeStringArray(evidence?.reads),
      stageCalls: normalizeStringArrayMap(stageCalls),
    },
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return {}
  }
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      result[key] = item
    }
  }
  return result
}

function normalizeStringArrayMap(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return {}
  }
  const result: Record<string, string[]> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = normalizeStringArray(item)
  }
  return result
}
