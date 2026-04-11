import type { ToolEnvelope } from '../envelope.js'
import type { Session } from '../session.js'
import { WorkflowAction } from './result.js'
import {
  defaultWorkflowPendingApproval,
  type WorkflowBlockedAction,
  type WorkflowContext,
  type WorkflowPendingApproval,
  type WorkflowRecordedEvidence,
} from './context.js'
import { getWorkflowStageById, type WorkflowDefinition } from './definition.js'
import { fnmatch } from '../fnmatch.js'
import {
  ensureWorkflowState,
  type MutableWorkflowState,
  type WorkflowEvaluation,
} from './result.js'

/**
 * SIZE APPROVAL: This file exceeds 200 lines. It owns the workflow state
 * storage layer end to end: persistence, migration, normalization, runtime
 * status updates, and audit snapshot construction. Splitting those concerns
 * would make the storage boundary harder to trace.
 */

export const WORKFLOW_APPROVED_STATUS = 'approved'
export const MAX_WORKFLOW_EVIDENCE_ITEMS = 1000
const MAX_WORKFLOW_ACTION_SUMMARY_LENGTH = 4_096

export function workflowStateKey(name: string): string {
  return `workflow_state__${name}`
}

function legacyWorkflowStateKey(name: string): string {
  return `workflow:${name}:state`
}

export async function loadWorkflowState(
  session: Session,
  definition: WorkflowDefinition,
): Promise<MutableWorkflowState> {
  const key = workflowStateKey(definition.metadata.name)
  const raw =
    (await session.getValue(key)) ??
    (await session.getValue(legacyWorkflowStateKey(definition.metadata.name)))
  if (raw == null) {
    return ensureWorkflowState({
      sessionId: session.sessionId,
      activeStage: definition.stages[0]?.id ?? '',
      completedStages: [],
      approvals: {},
      evidence: { reads: [], stageCalls: {}, mcpResults: {} },
      blockedReason: null,
      pendingApproval: defaultWorkflowPendingApproval(),
      lastBlockedAction: null,
      lastRecordedEvidence: null,
    })
  }

  const state = ensureWorkflowState(parseWorkflowState(raw))
  const validStageIds = new Set(definition.stages.map((stage) => stage.id))
  state.sessionId = session.sessionId
  state.evidence.reads = capStringArray(state.evidence.reads, MAX_WORKFLOW_EVIDENCE_ITEMS)
  state.evidence.stageCalls = Object.fromEntries(
    Object.entries(state.evidence.stageCalls)
      .filter(([stageId]) => validStageIds.has(stageId))
      .map(([stageId, calls]) => [stageId, capStringArray(calls, MAX_WORKFLOW_EVIDENCE_ITEMS)]),
  )
  const allStageToolPatterns = definition.stages.flatMap((stage) => stage.tools)
  state.evidence.mcpResults = Object.fromEntries(
    Object.entries(state.evidence.mcpResults)
      .filter(
        ([toolName]) =>
          allStageToolPatterns.length === 0 ||
          allStageToolPatterns.some((pattern) => fnmatch(pattern, toolName)),
      )
      .map(([toolName, results]) => [toolName, results.slice(0, MAX_WORKFLOW_EVIDENCE_ITEMS)]),
  )
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
  state: MutableWorkflowState,
): Promise<void> {
  state.sessionId = session.sessionId
  ensureWorkflowState(state)
  const key = workflowStateKey(definition.metadata.name)
  await session.setValue(
    key,
    JSON.stringify({
      sessionId: state.sessionId,
      activeStage: state.activeStage,
      completedStages: state.completedStages,
      approvals: state.approvals,
      evidence: {
        reads: state.evidence.reads,
        stageCalls: state.evidence.stageCalls,
        mcpResults: state.evidence.mcpResults,
      },
      blockedReason: state.blockedReason,
      pendingApproval: state.pendingApproval,
      lastBlockedAction: state.lastBlockedAction,
      lastRecordedEvidence: state.lastRecordedEvidence,
    }),
  )
  await session.deleteValue(legacyWorkflowStateKey(definition.metadata.name))
}

export function recordWorkflowApproval(state: MutableWorkflowState, stageId: string): void {
  ensureWorkflowState(state)
  state.approvals[stageId] = WORKFLOW_APPROVED_STATUS
  clearWorkflowRuntimeStatus(state)
}

export function recordWorkflowResult(
  state: MutableWorkflowState,
  stageId: string,
  envelope: ToolEnvelope,
  mcpResult?: Record<string, unknown>,
): void {
  ensureWorkflowState(state)
  if (mcpResult != null) {
    const existing = state.evidence.mcpResults[envelope.toolName] ?? []
    state.evidence.mcpResults[envelope.toolName] = appendDictCapped(
      existing,
      { ...mcpResult },
      MAX_WORKFLOW_EVIDENCE_ITEMS,
    )
  }
  switch (envelope.toolName) {
    case 'Read': {
      if (envelope.filePath) {
        state.evidence.reads = appendUniqueCapped(
          state.evidence.reads,
          envelope.filePath,
          MAX_WORKFLOW_EVIDENCE_ITEMS,
        )
        state.lastRecordedEvidence = buildLastRecordedEvidence(envelope)
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
        state.lastRecordedEvidence = buildLastRecordedEvidence(envelope)
      }
      break
    }
  }
}

export function clearWorkflowRuntimeStatus(state: MutableWorkflowState): void {
  ensureWorkflowState(state)
  state.blockedReason = null
  state.pendingApproval = defaultWorkflowPendingApproval()
  state.lastBlockedAction = null
}

export function hydrateActiveWorkflowRuntimeStatus(
  definition: WorkflowDefinition,
  state: MutableWorkflowState,
): void {
  ensureWorkflowState(state)
  clearWorkflowRuntimeStatus(state)

  const stage = getWorkflowStageById(definition, state.activeStage)
  if (stage?.approval == null || state.approvals[stage.id] === WORKFLOW_APPROVED_STATUS) {
    return
  }

  state.pendingApproval = {
    required: true,
    stageId: stage.id,
    message: stage.approval.message,
  }
}

export function applyWorkflowEvaluationStatus(
  state: MutableWorkflowState,
  evaluation: WorkflowEvaluation,
  envelope: ToolEnvelope,
): boolean {
  ensureWorkflowState(state)
  let changed = false

  if (evaluation.action === WorkflowAction.BLOCK) {
    if (state.blockedReason !== evaluation.reason) {
      state.blockedReason = evaluation.reason
      changed = true
    }
    if (!workflowPendingApprovalEquals(state.pendingApproval, defaultWorkflowPendingApproval())) {
      state.pendingApproval = defaultWorkflowPendingApproval()
      changed = true
    }
    const blockedAction = buildLastBlockedAction(envelope, evaluation.reason)
    if (!workflowBlockedActionEquals(state.lastBlockedAction, blockedAction)) {
      state.lastBlockedAction = blockedAction
      changed = true
    }
    return changed
  }

  if (evaluation.action === WorkflowAction.PENDING_APPROVAL) {
    const pendingApproval: WorkflowPendingApproval = {
      required: true,
      stageId: evaluation.stageId,
      message: evaluation.reason,
    }
    if (!workflowPendingApprovalEquals(state.pendingApproval, pendingApproval)) {
      state.pendingApproval = pendingApproval
      changed = true
    }
    if (state.blockedReason !== null) {
      state.blockedReason = null
      changed = true
    }
    return changed
  }

  if (
    state.blockedReason !== null ||
    !workflowPendingApprovalEquals(state.pendingApproval, defaultWorkflowPendingApproval())
  ) {
    clearWorkflowRuntimeStatus(state)
    changed = true
  }
  return changed
}

export function buildWorkflowSnapshot(
  definition: WorkflowDefinition,
  state: MutableWorkflowState,
): WorkflowContext {
  ensureWorkflowState(state)
  const snapshot: WorkflowContext = {
    name: definition.metadata.name,
    activeStage: state.activeStage,
    completedStages: [...state.completedStages],
    blockedReason: state.blockedReason,
    pendingApproval: { ...state.pendingApproval },
  }
  const version = definition.metadata.version
  if (typeof version === 'string' && version !== '') {
    ;(snapshot as { version?: string }).version = version
  }
  if (state.lastBlockedAction != null) {
    ;(snapshot as { lastBlockedAction?: WorkflowBlockedAction }).lastBlockedAction = {
      ...state.lastBlockedAction,
    }
  }
  if (state.lastRecordedEvidence != null) {
    ;(snapshot as { lastRecordedEvidence?: WorkflowRecordedEvidence }).lastRecordedEvidence = {
      ...state.lastRecordedEvidence,
    }
  }
  return snapshot
}

export function buildWorkflowEvent(
  action: string,
  workflow: WorkflowContext,
): Record<string, unknown> {
  return { action, workflow }
}

export function hydrateWorkflowEvents(
  definition: WorkflowDefinition,
  state: MutableWorkflowState,
  events: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  if (events.length === 0) {
    return []
  }
  const workflow = buildWorkflowSnapshot(definition, state)
  return events
    .map((record) => {
      const action = record['action']
      if (typeof action !== 'string') {
        return null
      }

      const eventWorkflow = applyWorkflowEventDetails(workflow, record['workflow'])
      return buildWorkflowEvent(action, eventWorkflow)
    })
    .filter((record): record is Record<string, unknown> => record != null)
}

function applyWorkflowEventDetails(workflow: WorkflowContext, value: unknown): WorkflowContext {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return workflow
  }

  const eventWorkflow = value as Record<string, unknown>
  const detailedWorkflow: WorkflowContext = {
    ...workflow,
  }

  if (typeof eventWorkflow['stage_id'] === 'string') {
    ;(detailedWorkflow as { stageId?: string }).stageId = eventWorkflow['stage_id']
  }
  if (typeof eventWorkflow['to_stage_id'] === 'string') {
    ;(detailedWorkflow as { toStageId?: string }).toStageId = eventWorkflow['to_stage_id']
  }

  return detailedWorkflow
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

function appendDictCapped(
  items: Record<string, unknown>[],
  item: Record<string, unknown>,
  limit: number,
): Record<string, unknown>[] {
  if (items.length >= limit) {
    return items
  }
  return [...items, item]
}

function parseWorkflowState(raw: string): MutableWorkflowState {
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
  const mcpResults = (evidence?.mcpResults ?? evidence?.mcp_results ?? {}) as Record<
    string,
    unknown
  >

  return {
    sessionId: normalizeString(value.sessionId ?? value.session_id),
    activeStage: normalizeString(value.activeStage ?? value.active_stage),
    completedStages: normalizeStringArray(value.completedStages ?? value.completed_stages),
    approvals: normalizeStringMap(value.approvals),
    evidence: {
      reads: normalizeStringArray(evidence?.reads),
      stageCalls: normalizeStringArrayMap(stageCalls),
      mcpResults: normalizeMcpResults(mcpResults),
    },
    blockedReason: normalizeOptionalString(value.blockedReason ?? value.blocked_reason),
    pendingApproval: normalizeWorkflowPendingApproval(
      value.pendingApproval ?? value.pending_approval,
    ),
    lastBlockedAction: normalizeWorkflowBlockedAction(
      value.lastBlockedAction ?? value.last_blocked_action,
    ),
    lastRecordedEvidence: normalizeWorkflowRecordedEvidence(
      value.lastRecordedEvidence ?? value.last_recorded_evidence,
    ),
  }
}

function buildLastBlockedAction(envelope: ToolEnvelope, message: string): WorkflowBlockedAction {
  return {
    tool: envelope.toolName,
    summary: summarizeToolCall(envelope),
    message,
    timestamp: new Date().toISOString(),
  }
}

function buildLastRecordedEvidence(envelope: ToolEnvelope): WorkflowRecordedEvidence | null {
  if (envelope.toolName !== 'Read' && envelope.toolName !== 'Bash') {
    return null
  }

  return {
    tool: envelope.toolName,
    summary: summarizeToolCall(envelope),
    timestamp: new Date().toISOString(),
  }
}

function summarizeToolCall(envelope: ToolEnvelope): string {
  const summary = envelope.bashCommand ?? envelope.filePath ?? envelope.toolName
  return summary.length > MAX_WORKFLOW_ACTION_SUMMARY_LENGTH
    ? summary.slice(0, MAX_WORKFLOW_ACTION_SUMMARY_LENGTH - 1) + '…'
    : summary
}

function workflowPendingApprovalEquals(
  left: WorkflowPendingApproval,
  right: WorkflowPendingApproval,
): boolean {
  return (
    left.required === right.required &&
    left.stageId === right.stageId &&
    left.message === right.message
  )
}

function workflowBlockedActionEquals(
  left: WorkflowBlockedAction | null,
  right: WorkflowBlockedAction,
): boolean {
  return (
    left?.tool === right.tool && left?.summary === right.summary && left?.message === right.message
  )
}

function normalizeWorkflowRecordedEvidence(value: unknown): WorkflowRecordedEvidence | null {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.tool !== 'string' || typeof record.summary !== 'string') {
    return null
  }
  return {
    tool: record.tool,
    summary: record.summary,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
  }
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function capStringArray(items: string[], limit: number): string[] {
  return items.length <= limit ? items : items.slice(0, limit)
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

function normalizeWorkflowPendingApproval(value: unknown): WorkflowPendingApproval {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return defaultWorkflowPendingApproval()
  }
  const pending = value as Record<string, unknown>
  const stageId = pending.stageId ?? pending.stage_id
  const message = pending.message
  return {
    required: pending.required === true,
    ...(typeof stageId === 'string' ? { stageId } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  }
}

function normalizeWorkflowBlockedAction(value: unknown): WorkflowBlockedAction | null {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return null
  }
  const action = value as Record<string, unknown>
  if (
    typeof action.tool !== 'string' ||
    typeof action.summary !== 'string' ||
    typeof action.message !== 'string'
  ) {
    return null
  }
  return {
    tool: action.tool,
    summary: action.summary,
    message: action.message,
    timestamp: typeof action.timestamp === 'string' ? action.timestamp : '',
  }
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

function normalizeMcpResults(value: unknown): Record<string, Record<string, unknown>[]> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return {}
  }
  const result: Record<string, Record<string, unknown>[]> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(item)) {
      result[key] = item
        .filter((entry) => typeof entry === 'object' && entry != null && !Array.isArray(entry))
        .map((entry) => ({ ...(entry as Record<string, unknown>) }))
        .slice(0, MAX_WORKFLOW_EVIDENCE_ITEMS)
    }
  }
  return result
}
