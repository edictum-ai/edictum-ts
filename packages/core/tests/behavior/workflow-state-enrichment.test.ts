/** Tests for P4 enriched workflow state persistence — blockedReason, pendingApproval, lastBlockedAction. */

import { describe, expect, test } from 'vitest'

import { Session, MemoryBackend } from '../../src/index.js'
import { workflowStateKey } from '../../src/workflow/state.js'
import { makeWorkflowRuntime, makeWorkflowSession } from '../workflow/fixtures.js'

// ---------------------------------------------------------------------------
// Enriched state fields default to null
// ---------------------------------------------------------------------------

describe('WorkflowStateEnrichmentDefaults', () => {
  test('new workflow state has null enrichment fields', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: default-enrich-process
stages:
  - id: implement
    tools: [Edit]
`)
    const session = makeWorkflowSession('wf-enrich-defaults')
    const state = await runtime.state(session)

    expect(state.blockedReason).toBeNull()
    expect(state.pendingApproval).toBeNull()
    expect(state.lastBlockedAction).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Enriched state fields persist and reload
// ---------------------------------------------------------------------------

describe('WorkflowStateEnrichmentPersistence', () => {
  test('persisted pendingApproval reloads correctly', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: persist-pending-process
stages:
  - id: implement
    tools: [Edit]
`)
    const backend = new MemoryBackend()
    const session = new Session('wf-persist-pending', backend)

    await session.setValue(
      workflowStateKey('persist-pending-process'),
      JSON.stringify({
        activeStage: 'implement',
        completedStages: [],
        approvals: {},
        evidence: { reads: [], stageCalls: {} },
        blockedReason: 'Exit gate not satisfied',
        pendingApproval: {
          required: true,
          stageId: 'review',
          message: 'Human review needed',
        },
        lastBlockedAction: {
          tool: 'Bash',
          summary: 'git push',
          message: 'Push blocked by gate',
          timestamp: '2026-04-03T12:00:00Z',
        },
      }),
    )

    const state = await runtime.state(session)
    expect(state.blockedReason).toBe('Exit gate not satisfied')

    expect(state.pendingApproval).not.toBeNull()
    expect(state.pendingApproval!.required).toBe(true)
    expect(state.pendingApproval!.stageId).toBe('review')
    expect(state.pendingApproval!.message).toBe('Human review needed')

    expect(state.lastBlockedAction).not.toBeNull()
    expect(state.lastBlockedAction!.tool).toBe('Bash')
    expect(state.lastBlockedAction!.summary).toBe('git push')
    expect(state.lastBlockedAction!.message).toBe('Push blocked by gate')
    expect(state.lastBlockedAction!.timestamp).toBe('2026-04-03T12:00:00Z')
  })

  test('persisted snake_case fields are normalized', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: snake-case-process
stages:
  - id: implement
    tools: [Edit]
`)
    const backend = new MemoryBackend()
    const session = new Session('wf-snake-case', backend)

    // Python-style snake_case persisted state
    await session.setValue(
      workflowStateKey('snake-case-process'),
      JSON.stringify({
        activeStage: 'implement',
        completedStages: [],
        approvals: {},
        evidence: { reads: [], stageCalls: {} },
        blocked_reason: 'Blocked via Python',
        pending_approval: {
          required: false,
          stage_id: 'review-stage',
          message: 'Cross-SDK approval',
        },
        last_blocked_action: {
          tool: 'Edit',
          summary: 'edit src',
          message: 'Blocked cross-SDK',
          timestamp: '2026-04-03T13:00:00Z',
        },
      }),
    )

    const state = await runtime.state(session)
    expect(state.blockedReason).toBe('Blocked via Python')

    expect(state.pendingApproval).not.toBeNull()
    expect(state.pendingApproval!.stageId).toBe('review-stage')

    expect(state.lastBlockedAction).not.toBeNull()
    expect(state.lastBlockedAction!.tool).toBe('Edit')
  })

  test('null enrichment fields persist correctly', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: null-enrich-process
stages:
  - id: implement
    tools: [Edit]
`)
    const backend = new MemoryBackend()
    const session = new Session('wf-null-enrich', backend)

    await session.setValue(
      workflowStateKey('null-enrich-process'),
      JSON.stringify({
        activeStage: 'implement',
        completedStages: [],
        approvals: {},
        evidence: { reads: [], stageCalls: {} },
        blockedReason: null,
        pendingApproval: null,
        lastBlockedAction: null,
      }),
    )

    const state = await runtime.state(session)
    expect(state.blockedReason).toBeNull()
    expect(state.pendingApproval).toBeNull()
    expect(state.lastBlockedAction).toBeNull()
  })

  test('missing enrichment fields default to null', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: missing-enrich-process
stages:
  - id: implement
    tools: [Edit]
`)
    const backend = new MemoryBackend()
    const session = new Session('wf-missing-enrich', backend)

    // Old state format without enrichment fields
    await session.setValue(
      workflowStateKey('missing-enrich-process'),
      JSON.stringify({
        activeStage: 'implement',
        completedStages: [],
        approvals: {},
        evidence: { reads: [], stageCalls: {} },
      }),
    )

    const state = await runtime.state(session)
    expect(state.blockedReason).toBeNull()
    expect(state.pendingApproval).toBeNull()
    expect(state.lastBlockedAction).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ApprovalRequest sessionId
// ---------------------------------------------------------------------------

describe('ApprovalRequestSessionId', () => {
  test('approval request includes sessionId field', async () => {
    // This is tested through the LocalApprovalBackend
    const { LocalApprovalBackend } = await import('../../src/approval.js')
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Bash', {}, 'msg', { sessionId: 'sess-123' })
    expect(req.sessionId).toBe('sess-123')
  })

  test('approval request sessionId defaults to null', async () => {
    const { LocalApprovalBackend } = await import('../../src/approval.js')
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Bash', {}, 'msg')
    expect(req.sessionId).toBeNull()
  })
})
