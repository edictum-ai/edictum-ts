import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  ApprovalStatus,
  AuditAction,
  CollectingAuditSink,
  Edictum,
  MemoryBackend,
  Session,
  WorkflowRuntime,
  createAuditEvent,
  loadWorkflowString,
  type ApprovalBackend,
  type ApprovalDecision,
  type ApprovalRequest,
  type AuditEvent,
  type WorkflowState,
} from '../../src/index.js'
import { workflowStateKey } from '../../src/workflow/state.js'
import { ClaudeAgentSDKAdapter } from '../../../claude-sdk/src/index.js'
import { LangChainAdapter } from '../../../langchain/src/index.js'
import { OpenAIAgentsAdapter } from '../../../openai-agents/src/index.js'
import { VercelAIAdapter } from '../../../vercel-ai/src/index.js'
import {
  loadWorkflowAdapterFixtureSuites,
  resolveWorkflowAdapterFixturesDir,
  workflowAdapterConformanceRequired,
  type WorkflowAdapterFixture,
  type WorkflowAdapterFixtureStep,
  type WorkflowAdapterFixtureSuite,
} from './adapter-conformance-fixtures.js'

type AdapterHarness = {
  readonly _pre: (
    toolName: string,
    toolInput: Record<string, unknown>,
    callId: string,
  ) => Promise<string | null>
  readonly _post: (callId: string, toolResponse?: unknown) => Promise<unknown>
}

type AdapterFactory = (
  guard: Edictum,
  options: { sessionId: string; parentSessionId?: string },
) => AdapterHarness

const fixturesDir = resolveWorkflowAdapterFixturesDir()

if (!fixturesDir && workflowAdapterConformanceRequired) {
  throw new Error(
    'EDICTUM_WORKFLOW_ADAPTER_CONFORMANCE_REQUIRED=1 but no workflow adapter fixtures found. ' +
      'Set EDICTUM_WORKFLOW_ADAPTER_FIXTURES_DIR or EDICTUM_SCHEMAS_DIR, or check out edictum-schemas as a sibling.',
  )
}

const suites = fixturesDir ? loadWorkflowAdapterFixtureSuites(fixturesDir) : null
const ALLOWED_EXTRA_ACTIONS = new Set(['workflow_completed', 'workflow_state_updated'])

const ADAPTERS: Array<{ name: string; create: AdapterFactory }> = [
  {
    name: '@edictum/vercel-ai',
    create: (guard, options) => new VercelAIAdapter(guard, options),
  },
  {
    name: '@edictum/langchain',
    create: (guard, options) => new LangChainAdapter(guard, options),
  },
  {
    name: '@edictum/openai-agents',
    create: (guard, options) => new OpenAIAgentsAdapter(guard, options),
  },
  {
    name: '@edictum/claude-sdk',
    create: (guard, options) => new ClaudeAgentSDKAdapter(guard, options),
  },
]

class FixtureApprovalBackend implements ApprovalBackend {
  private _outcomes: Array<'approved' | 'rejected'> = []

  setOutcomes(outcomes: Array<'approved' | 'rejected'> | undefined): void {
    this._outcomes = [...(outcomes ?? [])]
  }

  remainingOutcomes(): number {
    return this._outcomes.length
  }

  async requestApproval(
    toolName: string,
    toolArgs: Record<string, unknown>,
    message: string,
    options?: {
      timeout?: number
      timeoutEffect?: string
      principal?: Record<string, unknown> | null
      metadata?: Record<string, unknown> | null
      sessionId?: string | null
    },
  ): Promise<ApprovalRequest> {
    return {
      approvalId: `fixture-approval-${toolName}-${this._outcomes.length}`,
      toolName,
      toolArgs,
      message,
      timeout: options?.timeout ?? 300,
      timeoutEffect: options?.timeoutEffect ?? 'deny',
      principal: options?.principal ?? null,
      metadata: options?.metadata ?? {},
      sessionId: options?.sessionId ?? null,
      createdAt: new Date(),
    }
  }

  async waitForDecision(): Promise<ApprovalDecision> {
    const outcome = this._outcomes.shift()
    if (outcome == null) {
      throw new Error('Fixture requested approval without a configured approval outcome')
    }

    return {
      approved: outcome === 'approved',
      approver: 'fixture',
      reason: outcome === 'approved' ? null : 'Fixture approval blocked the call',
      status: outcome === 'approved' ? ApprovalStatus.APPROVED : ApprovalStatus.DENIED,
      timestamp: new Date(),
    }
  }
}

function makeRuntime(
  suite: WorkflowAdapterFixtureSuite,
  fixture: WorkflowAdapterFixture,
): WorkflowRuntime {
  const document = suite.workflows[fixture.workflow]
  if (document == null) {
    throw new Error(`Fixture ${fixture.id} references missing workflow ${fixture.workflow}`)
  }
  return new WorkflowRuntime(loadWorkflowString(yaml.dump(document, { lineWidth: -1 })))
}

async function seedWorkflowState(
  session: Session,
  workflowName: string,
  initialState: Record<string, unknown>,
): Promise<void> {
  await session.setValue(workflowStateKey(workflowName), JSON.stringify(initialState))
}

function normalizeWorkflowState(state: WorkflowState): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    active_stage: state.activeStage,
    completed_stages: [...state.completedStages],
    approvals: { ...state.approvals },
    evidence: {
      reads: [...state.evidence.reads],
      stage_calls: Object.fromEntries(
        Object.entries(state.evidence.stageCalls).map(([stageId, commands]) => [
          stageId,
          [...commands],
        ]),
      ),
    },
    blocked_reason: state.blockedReason,
    pending_approval: normalizePendingApproval(state.pendingApproval),
  }

  if (state.lastBlockedAction != null) {
    normalized.last_blocked_action = { ...state.lastBlockedAction }
  }
  if (state.lastRecordedEvidence != null) {
    normalized.last_recorded_evidence = { ...state.lastRecordedEvidence }
  }

  return normalized
}

function stateExpectation(expectation: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const key of [
    'active_stage',
    'completed_stages',
    'approvals',
    'evidence',
    'blocked_reason',
    'pending_approval',
    'last_blocked_action',
    'last_recorded_evidence',
  ]) {
    if (key in expectation) {
      normalized[key] = expectation[key]
    }
  }
  return normalized
}

function normalizePendingApproval(
  pendingApproval: WorkflowState['pendingApproval'],
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    required: pendingApproval.required,
  }
  if (pendingApproval.stageId != null) {
    normalized.stage_id = pendingApproval.stageId
  }
  if (pendingApproval.message != null) {
    normalized.message = pendingApproval.message
  }
  return normalized
}

function normalizeWorkflowContext(event: AuditEvent): Record<string, unknown> | null {
  if (event.workflow == null) {
    return null
  }

  const normalized: Record<string, unknown> = {
    name: event.workflow.name,
    active_stage: event.workflow.activeStage,
    completed_stages: [...event.workflow.completedStages],
    blocked_reason: event.workflow.blockedReason,
    pending_approval: normalizePendingApproval(event.workflow.pendingApproval),
  }

  if (event.workflow.version != null) {
    normalized.version = event.workflow.version
  }
  if (event.workflow.stageId != null) {
    normalized.stage_id = event.workflow.stageId
  }
  if (event.workflow.toStageId != null) {
    normalized.to_stage_id = event.workflow.toStageId
  }
  if (event.workflow.lastBlockedAction != null) {
    normalized.last_blocked_action = { ...event.workflow.lastBlockedAction }
  }
  if (event.workflow.lastRecordedEvidence != null) {
    normalized.last_recorded_evidence = { ...event.workflow.lastRecordedEvidence }
  }

  return normalized
}

function matchesExpected(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => matchesExpected(actual[index], item))
    )
  }

  if (expected != null && typeof expected === 'object') {
    if (actual == null || typeof actual !== 'object' || Array.isArray(actual)) {
      return false
    }
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      matchesExpected((actual as Record<string, unknown>)[key], value),
    )
  }

  return actual === expected
}

function eventMatches(actual: AuditEvent, expected: Record<string, unknown>): boolean {
  if (actual.action !== expected.action) {
    return false
  }
  if ('session_id' in expected && actual.sessionId !== expected.session_id) {
    return false
  }
  if ('parent_session_id' in expected && actual.parentSessionId !== expected.parent_session_id) {
    return false
  }
  if (
    'workflow' in expected &&
    !matchesExpected(normalizeWorkflowContext(actual), expected.workflow)
  ) {
    return false
  }
  return true
}

function assertOrderedAuditEvents(
  actualEvents: AuditEvent[],
  expectedEvents: Record<string, unknown>[],
): void {
  let actualIndex = 0

  for (const expectedEvent of expectedEvents) {
    let matched = false
    while (actualIndex < actualEvents.length) {
      const actualEvent = actualEvents[actualIndex]
      if (actualEvent == null) {
        break
      }
      if (eventMatches(actualEvent, expectedEvent)) {
        actualIndex += 1
        matched = true
        break
      }
      expect(
        ALLOWED_EXTRA_ACTIONS.has(actualEvent.action),
        `Unexpected extra audit event ${actualEvent.action} before ${String(expectedEvent.action)}`,
      ).toBe(true)
      actualIndex += 1
    }

    expect(matched, `Missing audit event ${String(expectedEvent.action)}`).toBe(true)
  }

  for (; actualIndex < actualEvents.length; actualIndex += 1) {
    const actualEvent = actualEvents[actualIndex]
    expect(
      ALLOWED_EXTRA_ACTIONS.has(actualEvent?.action ?? ''),
      `Unexpected trailing audit event ${actualEvent?.action ?? '(missing)'}`,
    ).toBe(true)
  }
}

async function runFixtureStep(
  adapter: AdapterHarness,
  runtime: WorkflowRuntime,
  session: Session,
  approvalBackend: FixtureApprovalBackend,
  fixture: WorkflowAdapterFixture,
  step: WorkflowAdapterFixtureStep,
  sink: CollectingAuditSink,
): Promise<{ decision: string; actualEvents: AuditEvent[] }> {
  approvalBackend.setOutcomes(step.approval_outcomes)
  const mark = sink.mark()

  if (step.set_stage_to != null) {
    const events = await runtime.setStage(session, step.set_stage_to)
    for (const event of events) {
      const action = event['action']
      if (typeof action !== 'string') {
        continue
      }

      await sink.emit(
        createAuditEvent({
          callId: `${fixture.id}:${step.id}`,
          sessionId: session.sessionId,
          parentSessionId: fixture.lineage?.parent_session_id ?? null,
          action: action as AuditAction,
          workflow: (event['workflow'] as AuditEvent['workflow']) ?? null,
        }),
      )
    }

    expect(
      approvalBackend.remainingOutcomes(),
      `Step ${step.id} did not consume all configured approval outcomes`,
    ).toBe(0)

    return {
      decision: 'allow',
      actualEvents: sink.sinceMark(mark),
    }
  }

  if (step.call == null) {
    throw new Error(`Fixture step ${step.id} must define call or set_stage_to`)
  }

  const callId = `${fixture.id}:${step.id}`
  const preResult = await adapter._pre(step.call.tool, step.call.args, callId)

  let decision = preResult == null ? 'allow' : 'block'
  if (step.execution === 'success' && decision === 'allow') {
    await adapter._post(callId, 'fixture-success')
  } else if (step.execution === 'error' && decision === 'allow') {
    await adapter._post(callId, 'error: fixture-failure')
  }

  expect(
    approvalBackend.remainingOutcomes(),
    `Step ${step.id} did not consume all configured approval outcomes`,
  ).toBe(0)

  return {
    decision,
    actualEvents: sink.sinceMark(mark),
  }
}

if (suites) {
  describe('workflow adapter conformance fixtures (edictum-schemas)', () => {
    for (const suite of suites) {
      describe(suite.suite, () => {
        for (const { name, create } of ADAPTERS) {
          describe(name, () => {
            for (const fixture of suite.fixtures) {
              it(`${fixture.id}: ${fixture.description}`, async () => {
                const backend = new MemoryBackend()
                const auditSink = new CollectingAuditSink()
                const approvalBackend = new FixtureApprovalBackend()
                const runtime = makeRuntime(suite, fixture)
                const workflowName = runtime.definition.metadata.name
                const sessionId = String(fixture.initial_state.session_id)
                const session = new Session(sessionId, backend)

                await seedWorkflowState(session, workflowName, fixture.initial_state)

                const guard = new Edictum({
                  backend,
                  auditSink,
                  approvalBackend,
                  workflowRuntime: runtime,
                })
                const adapter = create(guard, {
                  sessionId,
                  parentSessionId: fixture.lineage?.parent_session_id,
                })

                for (const step of fixture.steps) {
                  const { decision, actualEvents } = await runFixtureStep(
                    adapter,
                    runtime,
                    session,
                    approvalBackend,
                    fixture,
                    step,
                    auditSink,
                  )
                  if ('decision' in step.expect) {
                    expect(decision).toBe(step.expect.decision)
                  }
                  expect(normalizeWorkflowState(await runtime.state(session))).toMatchObject(
                    stateExpectation(step.expect),
                  )
                  assertOrderedAuditEvents(
                    actualEvents,
                    (step.expect.audit_events as Record<string, unknown>[] | undefined) ?? [],
                  )
                }
              })
            }
          })
        }
      })
    }
  })
} else {
  it.skip('workflow adapter conformance fixtures — edictum-schemas not found', () => {})
}
