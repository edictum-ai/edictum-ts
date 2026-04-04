import type { ToolEnvelope } from '../envelope.js'
import type { Session } from '../session.js'
import {
  getWorkflowStageById,
  getWorkflowStageIndex,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from './definition.js'
import {
  type EvaluateRequest,
  type FactEvaluator,
  parseCondition,
  usesExecCondition,
  workflowGateRecord,
} from './evaluator.js'
import { approvalEvaluator } from './evaluator-approval.js'
import { commandEvaluator } from './evaluator-command.js'
import { createExecEvaluator } from './evaluator-exec.js'
import { fileReadEvaluator } from './evaluator-file.js'
import { stageCompleteEvaluator } from './evaluator-stage.js'
import {
  createWorkflowEvaluation,
  createWorkflowStateSnapshot,
  WorkflowAction,
  type WorkflowEvaluation,
} from './result.js'
import { advanceWorkflowAfterSuccess } from './runtime-post.js'
import { evaluateWorkflowRuntime } from './runtime-eval.js'
import { workflowMetadata, workflowStageIds } from './runtime-helpers.js'
import {
  applyWorkflowEvaluationStatus,
  buildWorkflowEvent,
  buildWorkflowSnapshot,
  clearWorkflowRuntimeStatus,
  hydrateWorkflowEvents,
  loadWorkflowState,
  recordWorkflowApproval,
  recordWorkflowResult,
  saveWorkflowState,
} from './state.js'
import type { WorkflowGate, WorkflowStage } from './definition.js'
import type { MutableWorkflowState, WorkflowState } from './result.js'

const DEFAULT_EXEC_EVALUATOR_TIMEOUT_MS = 30_000

export interface WorkflowRuntimeOptions {
  readonly execEvaluatorEnabled?: boolean
  readonly execEvaluatorTimeoutMs?: number
}

export class WorkflowRuntime {
  readonly definition: WorkflowDefinition
  readonly evaluators: Record<string, FactEvaluator>

  private _lock: Promise<void> = Promise.resolve()

  constructor(definition: WorkflowDefinition, options: WorkflowRuntimeOptions = {}) {
    this.definition = validateWorkflowDefinition(definition)

    if (
      options.execEvaluatorTimeoutMs != null &&
      (!Number.isInteger(options.execEvaluatorTimeoutMs) || options.execEvaluatorTimeoutMs <= 0)
    ) {
      throw new Error('workflow: execEvaluatorTimeoutMs must be a positive integer')
    }

    if (usesExecCondition(this.definition) && !options.execEvaluatorEnabled) {
      throw new Error('workflow: exec(...) conditions require execEvaluatorEnabled')
    }

    this.evaluators = {
      stage_complete: stageCompleteEvaluator,
      file_read: fileReadEvaluator,
      approval: approvalEvaluator,
      command_matches: commandEvaluator,
      command_not_matches: commandEvaluator,
      ...(options.execEvaluatorEnabled
        ? {
            exec: createExecEvaluator({
              timeoutMs: options.execEvaluatorTimeoutMs ?? DEFAULT_EXEC_EVALUATOR_TIMEOUT_MS,
            }),
          }
        : {}),
    }
  }

  async evaluate(session: Session, envelope: ToolEnvelope): Promise<WorkflowEvaluation> {
    return await this.withLock(async () => {
      const evaluation = await evaluateWorkflowRuntime(this, session, envelope)
      const state = await loadWorkflowState(session, this.definition)
      const stateChanged = applyWorkflowEvaluationStatus(state, evaluation, envelope)
      if (stateChanged) {
        await saveWorkflowState(session, this.definition, state)
      }
      return createWorkflowEvaluation({
        ...evaluation,
        audit: buildWorkflowSnapshot(this.definition, state),
        events: hydrateWorkflowEvents(this.definition, state, evaluation.events),
      })
    })
  }

  async state(session: Session): Promise<WorkflowState> {
    return await this.withLock(async () =>
      createWorkflowStateSnapshot(await loadWorkflowState(session, this.definition)),
    )
  }

  async reset(session: Session, stageId: string): Promise<Record<string, unknown>[]> {
    return await this.withLock(async () => {
      const index = getWorkflowStageIndex(this.definition, stageId)
      if (index == null) {
        throw new Error(`workflow: unknown reset stage ${JSON.stringify(stageId)}`)
      }
      const state = await loadWorkflowState(session, this.definition)
      state.activeStage = stageId
      state.completedStages = workflowStageIds(this.definition.stages.slice(0, index))
      const clearedApprovalStageIds = new Set(
        this.definition.stages.slice(index).map((stage) => stage.id),
      )
      state.approvals = Object.fromEntries(
        Object.entries(state.approvals).filter(([key]) => !clearedApprovalStageIds.has(key)),
      )
      state.evidence.stageCalls = Object.fromEntries(
        Object.entries(state.evidence.stageCalls).filter(
          ([key]) => !clearedApprovalStageIds.has(key),
        ),
      )
      if (index === 0) {
        state.evidence.reads = []
      }
      clearWorkflowRuntimeStatus(state)
      await saveWorkflowState(session, this.definition, state)
      return [
        buildWorkflowEvent('workflow_state_updated', buildWorkflowSnapshot(this.definition, state)),
      ]
    })
  }

  async recordApproval(session: Session, stageId: string): Promise<void> {
    await this.withLock(async () => {
      if (getWorkflowStageById(this.definition, stageId) == null) {
        throw new Error(`workflow: unknown approval stage ${JSON.stringify(stageId)}`)
      }
      const state = await loadWorkflowState(session, this.definition)
      recordWorkflowApproval(state, stageId)
      await saveWorkflowState(session, this.definition, state)
    })
  }

  async recordResult(
    session: Session,
    stageId: string,
    envelope: ToolEnvelope,
  ): Promise<Record<string, unknown>[]> {
    if (stageId === '') {
      return []
    }

    return await this.withLock(async () => {
      const state = await loadWorkflowState(session, this.definition)
      recordWorkflowResult(state, stageId, envelope)
      const events = await advanceWorkflowAfterSuccess(this, state, stageId, envelope)
      await saveWorkflowState(session, this.definition, state)
      return hydrateWorkflowEvents(this.definition, state, events)
    })
  }

  async evaluateWorkflowGates(
    stage: WorkflowStage,
    state: WorkflowState | MutableWorkflowState,
    envelope: ToolEnvelope,
    gates: WorkflowGate[],
  ): Promise<{ evaluation: WorkflowEvaluation; blocked: boolean }> {
    const records: Record<string, unknown>[] = []

    for (const gate of gates) {
      const parsed = parseCondition(gate.condition)
      const evaluator = this.evaluators[parsed.kind]
      if (evaluator == null) {
        throw new Error(`workflow: unsupported condition ${JSON.stringify(gate.condition)}`)
      }
      const result = await evaluator.evaluate({
        definition: this.definition,
        stage,
        gate,
        parsed,
        state,
        call: envelope,
      } satisfies EvaluateRequest)
      records.push(workflowGateRecord(result, result.passed))
      if (!result.passed) {
        return {
          evaluation: createWorkflowEvaluation({
            action: WorkflowAction.BLOCK,
            reason: result.message,
            stageId: stage.id,
            records,
            audit: workflowMetadata(
              this.definition.metadata.name,
              stage.id,
              result.kind,
              result.condition,
              false,
              result.evidence,
              result.extraAudit ?? null,
            ),
          }),
          blocked: true,
        }
      }
    }

    return {
      evaluation: createWorkflowEvaluation({ records }),
      blocked: false,
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this._lock
    let release!: () => void
    this._lock = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
