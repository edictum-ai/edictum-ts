import { describe, expect, test } from 'vitest'

import { AuditAction, type Session } from '../../src/index.js'
import { workflowStateKey } from '../../src/workflow/state.js'
import { makeCall, makeWorkflowRuntime, makeWorkflowSession } from './fixtures.js'

const WORKFLOW_NAME = 'set-stage-process'

function makeSetStageRuntime() {
  return makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: ${WORKFLOW_NAME}
stages:
  - id: plan
    tools: [Read]
  - id: implement
    tools: [Write]
  - id: review
    tools: [Bash]
  - id: done
    tools: [Edit]
`)
}

async function persistWorkflowState(
  session: Session,
  state: Record<string, unknown>,
): Promise<void> {
  await session.setValue(workflowStateKey(WORKFLOW_NAME), JSON.stringify(state))
}

describe('WorkflowRuntime.setStage', () => {
  test('moves activeStage', async () => {
    const runtime = makeSetStageRuntime()
    const session = makeWorkflowSession('wf-set-stage-active')

    await runtime.setStage(session, 'implement')

    const state = await runtime.state(session)
    expect(state.activeStage).toBe('implement')
  })

  test('updates completedStages to every stage before the target', async () => {
    const runtime = makeSetStageRuntime()
    const session = makeWorkflowSession('wf-set-stage-completed')

    await runtime.setStage(session, 'done')

    const state = await runtime.state(session)
    expect(state.completedStages).toEqual(['plan', 'implement', 'review'])
  })

  test('preserves approvals', async () => {
    const runtime = makeSetStageRuntime()
    const session = makeWorkflowSession('wf-set-stage-approvals')

    await runtime.recordApproval(session, 'review')
    await runtime.setStage(session, 'done')

    const state = await runtime.state(session)
    expect(state.approvals).toEqual({ review: 'approved' })
  })

  test('preserves stage execution evidence', async () => {
    const runtime = makeSetStageRuntime()
    const session = makeWorkflowSession('wf-set-stage-stage-calls')

    await runtime.recordResult(session, 'review', makeCall('Bash', { command: 'pnpm test' }))
    await runtime.setStage(session, 'done')

    const state = await runtime.state(session)
    expect(state.evidence.stageCalls).toEqual({ review: ['pnpm test'] })
  })

  test('preserves file read evidence', async () => {
    const runtime = makeSetStageRuntime()
    const session = makeWorkflowSession('wf-set-stage-reads')

    await runtime.recordResult(session, 'plan', makeCall('Read', { path: 'specs/008.md' }))
    await runtime.setStage(session, 'plan')

    const state = await runtime.state(session)
    expect(state.evidence.reads).toEqual(['specs/008.md'])
  })

  test('clears transient enrichment fields', async () => {
    const runtime = makeSetStageRuntime()
    const session = makeWorkflowSession('wf-set-stage-enrichment')

    await persistWorkflowState(session, {
      activeStage: 'plan',
      completedStages: [],
      approvals: { review: 'approved' },
      evidence: {
        reads: ['specs/008.md'],
        stageCalls: { review: ['pnpm test'] },
      },
      blockedReason: 'Only review-safe commands are allowed',
      pendingApproval: {
        required: true,
        stageId: 'review',
        message: 'Approval required before release',
      },
      lastBlockedAction: {
        tool: 'Bash',
        summary: 'pnpm publish',
        message: 'Only review-safe commands are allowed',
        timestamp: '2026-04-04T00:00:00Z',
      },
    })

    await runtime.setStage(session, 'implement')

    const state = await runtime.state(session)
    expect(state.blockedReason).toBeNull()
    expect(state.pendingApproval).toEqual({ required: false })
    expect(state.lastBlockedAction).toBeNull()
    expect(state.approvals).toEqual({ review: 'approved' })
    expect(state.evidence.reads).toEqual(['specs/008.md'])
    expect(state.evidence.stageCalls).toEqual({ review: ['pnpm test'] })
  })

  test('rejects an unknown stageId', async () => {
    const runtime = makeSetStageRuntime()
    const session = makeWorkflowSession('wf-set-stage-missing')

    await expect(runtime.setStage(session, 'missing')).rejects.toThrow(
      'workflow: unknown stage "missing"',
    )
  })

  test('returns a workflow_state_updated event', async () => {
    const runtime = makeSetStageRuntime()
    const session = makeWorkflowSession('wf-set-stage-event')

    const events = await runtime.setStage(session, 'implement')

    expect(events).toEqual([
      {
        action: AuditAction.WORKFLOW_STATE_UPDATED,
        workflow: {
          name: WORKFLOW_NAME,
          activeStage: 'implement',
          completedStages: ['plan'],
          blockedReason: null,
          pendingApproval: { required: false },
        },
      },
    ])
  })

  test('reset still clears approvals and stage evidence, and only clears reads at stage zero', async () => {
    const runtime = makeSetStageRuntime()
    const reviewSession = makeWorkflowSession('wf-reset-review-regression')

    await runtime.recordApproval(reviewSession, 'review')
    await runtime.recordResult(reviewSession, 'plan', makeCall('Read', { path: 'specs/008.md' }))
    await runtime.recordResult(
      reviewSession,
      'review',
      makeCall('Bash', { command: 'pnpm test' }),
    )

    await runtime.reset(reviewSession, 'review')

    const reviewResetState = await runtime.state(reviewSession)
    expect(reviewResetState.approvals).toEqual({})
    expect(reviewResetState.evidence.stageCalls).toEqual({})
    expect(reviewResetState.evidence.reads).toEqual(['specs/008.md'])

    const planSession = makeWorkflowSession('wf-reset-plan-regression')
    await runtime.recordResult(planSession, 'plan', makeCall('Read', { path: 'specs/008.md' }))

    await runtime.reset(planSession, 'plan')

    const planResetState = await runtime.state(planSession)
    expect(planResetState.evidence.reads).toEqual([])
  })

  test('setStage then evaluate allows tools from the new active stage', async () => {
    const runtime = makeSetStageRuntime()
    const session = makeWorkflowSession('wf-set-stage-evaluate')

    await runtime.setStage(session, 'implement')

    const decision = await runtime.evaluate(session, makeCall('Write', { path: 'src/app.ts' }))
    expect(decision.action).toBe('allow')
    expect(decision.stageId).toBe('implement')
  })
})
