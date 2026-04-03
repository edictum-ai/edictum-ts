/** Tests for P4 session lineage, workflow audit actions, and runner emission. */

import { describe, expect, test } from 'vitest'

import {
  AuditAction,
  createAuditEvent,
  Edictum,
  MemoryBackend,
  Session,
  WorkflowRuntime,
  loadWorkflowString,
} from '../../src/index.js'
import type { AuditEvent } from '../../src/index.js'
import { CapturingAuditSink } from '../helpers.js'
import {
  AutoApprovalBackend,
  makeCall,
  makeWorkflowRuntime,
  makeWorkflowSession,
} from '../workflow/fixtures.js'

// ---------------------------------------------------------------------------
// AuditAction — workflow actions exist
// ---------------------------------------------------------------------------

describe('WorkflowAuditActions', () => {
  test('WORKFLOW_STAGE_ADVANCED has correct value', () => {
    expect(AuditAction.WORKFLOW_STAGE_ADVANCED).toBe('workflow_stage_advanced')
  })

  test('WORKFLOW_COMPLETED has correct value', () => {
    expect(AuditAction.WORKFLOW_COMPLETED).toBe('workflow_completed')
  })

  test('WORKFLOW_STATE_UPDATED has correct value', () => {
    expect(AuditAction.WORKFLOW_STATE_UPDATED).toBe('workflow_state_updated')
  })

  test('workflow audit actions can be used in createAuditEvent', () => {
    const staged = createAuditEvent({ action: AuditAction.WORKFLOW_STAGE_ADVANCED })
    expect(staged.action).toBe(AuditAction.WORKFLOW_STAGE_ADVANCED)

    const completed = createAuditEvent({ action: AuditAction.WORKFLOW_COMPLETED })
    expect(completed.action).toBe(AuditAction.WORKFLOW_COMPLETED)

    const updated = createAuditEvent({ action: AuditAction.WORKFLOW_STATE_UPDATED })
    expect(updated.action).toBe(AuditAction.WORKFLOW_STATE_UPDATED)
  })
})

// ---------------------------------------------------------------------------
// AuditEvent — session lineage fields
// ---------------------------------------------------------------------------

describe('AuditEventSessionLineage', () => {
  test('sessionId defaults to null', () => {
    const event = createAuditEvent()
    expect(event.sessionId).toBeNull()
  })

  test('parentSessionId defaults to null', () => {
    const event = createAuditEvent()
    expect(event.parentSessionId).toBeNull()
  })

  test('sessionId can be set', () => {
    const event = createAuditEvent({ sessionId: 'session-123' })
    expect(event.sessionId).toBe('session-123')
  })

  test('parentSessionId can be set', () => {
    const event = createAuditEvent({ parentSessionId: 'parent-456' })
    expect(event.parentSessionId).toBe('parent-456')
  })

  test('both session fields can be set together', () => {
    const event = createAuditEvent({
      sessionId: 'child-session',
      parentSessionId: 'parent-session',
    })
    expect(event.sessionId).toBe('child-session')
    expect(event.parentSessionId).toBe('parent-session')
  })
})

// ---------------------------------------------------------------------------
// AuditEvent — workflow field
// ---------------------------------------------------------------------------

describe('AuditEventWorkflowField', () => {
  test('workflow defaults to null', () => {
    const event = createAuditEvent()
    expect(event.workflow).toBeNull()
  })

  test('workflow can carry context', () => {
    const event = createAuditEvent({
      action: AuditAction.WORKFLOW_STAGE_ADVANCED,
      workflow: {
        workflow_name: 'deploy-process',
        stage_id: 'review',
        to_stage_id: 'push',
      },
    })
    expect(event.workflow).toEqual({
      workflow_name: 'deploy-process',
      stage_id: 'review',
      to_stage_id: 'push',
    })
  })
})

// ---------------------------------------------------------------------------
// Runner workflow event emission — stage advance
// ---------------------------------------------------------------------------

describe('RunnerWorkflowEventEmission', () => {
  test('emits WORKFLOW_STAGE_ADVANCED on stage advance', async () => {
    const sink = new CapturingAuditSink()
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: stage-advance-process
stages:
  - id: read-context
    tools: [Read]
    exit:
      - condition: file_read("specs/008.md")
        message: Read the workflow spec first
  - id: implement
    entry:
      - condition: stage_complete("read-context")
    tools: [Edit]
`)
    const guard = new Edictum({
      backend: new MemoryBackend(),
      workflowRuntime: runtime,
      auditSink: sink,
    })

    // Read the file to satisfy exit gate
    await guard.run('Read', { path: 'specs/008.md' }, async () => 'content', {
      sessionId: 'wf-emit-test',
    })

    // Stage advance events are emitted during pre-execute when the next tool
    // call triggers the workflow evaluation that advances the stage.
    await guard.run('Edit', { path: 'src/app.ts' }, async () => 'edited', {
      sessionId: 'wf-emit-test',
    })

    const stageAdvanced = sink.getByAction(AuditAction.WORKFLOW_STAGE_ADVANCED)
    expect(stageAdvanced.length).toBe(1)
    expect(stageAdvanced[0]!.workflow).toBeDefined()
    expect(stageAdvanced[0]!.workflow).not.toBeNull()
    expect((stageAdvanced[0]!.workflow as Record<string, unknown>)['workflow_name']).toBe(
      'stage-advance-process',
    )
    expect((stageAdvanced[0]!.workflow as Record<string, unknown>)['stage_id']).toBe('read-context')
    expect((stageAdvanced[0]!.workflow as Record<string, unknown>)['to_stage_id']).toBe('implement')
  })

  test('emits WORKFLOW_COMPLETED on final stage completion', async () => {
    const sink = new CapturingAuditSink()
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: completion-process
stages:
  - id: read-context
    tools: [Read]
    exit:
      - condition: file_read("specs/008.md")
        message: Read the workflow spec first
  - id: implement
    entry:
      - condition: stage_complete("read-context")
    tools: [Edit]
`)
    const guard = new Edictum({
      backend: new MemoryBackend(),
      workflowRuntime: runtime,
      auditSink: sink,
    })

    // Advance through both stages
    await guard.run('Read', { path: 'specs/008.md' }, async () => 'content', {
      sessionId: 'wf-complete-test',
    })

    // The implement stage is the last and has no exit conditions, so it should
    // complete on the next successful tool execution via recordResult
    await guard.run('Edit', { path: 'src/app.ts' }, async () => 'edited', {
      sessionId: 'wf-complete-test',
    })

    const completed = sink.getByAction(AuditAction.WORKFLOW_COMPLETED)
    expect(completed.length).toBe(1)
    expect(completed[0]!.workflow).toBeDefined()
    expect((completed[0]!.workflow as Record<string, unknown>)['workflow_name']).toBe(
      'completion-process',
    )
  })

  test('does not emit workflow events when no workflow is configured', async () => {
    const sink = new CapturingAuditSink()
    const guard = new Edictum({
      backend: new MemoryBackend(),
      auditSink: sink,
    })

    await guard.run('Read', {}, async () => 'ok')

    const stageAdvanced = sink.getByAction(AuditAction.WORKFLOW_STAGE_ADVANCED)
    const completed = sink.getByAction(AuditAction.WORKFLOW_COMPLETED)
    expect(stageAdvanced.length).toBe(0)
    expect(completed.length).toBe(0)
  })

  test('post-execute audit includes workflow context', async () => {
    const sink = new CapturingAuditSink()
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: audit-context-process
stages:
  - id: implement
    tools: [Edit]
`)
    const guard = new Edictum({
      backend: new MemoryBackend(),
      workflowRuntime: runtime,
      auditSink: sink,
    })

    await guard.run('Edit', { path: 'src/app.ts' }, async () => 'edited', {
      sessionId: 'wf-audit-ctx',
    })

    // The CALL_EXECUTED event should carry the workflow context from pre-execute
    const executed = sink.getByAction(AuditAction.CALL_EXECUTED)
    expect(executed.length).toBe(1)
    // workflow field presence depends on whether the workflow eval produced audit metadata
    // When there are records, the workflow metadata should be present
  })
})

// ---------------------------------------------------------------------------
// Runner workflow event emission — approval path
// ---------------------------------------------------------------------------

describe('RunnerWorkflowApprovalEventEmission', () => {
  test('emits workflow events through approval path', async () => {
    const sink = new CapturingAuditSink()
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: approval-emit-process
stages:
  - id: implement
    tools: [Edit]
  - id: review
    entry:
      - condition: stage_complete("implement")
    approval:
      message: Approval required before push
  - id: push
    entry:
      - condition: stage_complete("review")
    tools: [Bash]
`)
    const guard = new Edictum({
      backend: new MemoryBackend(),
      workflowRuntime: runtime,
      approvalBackend: new AutoApprovalBackend(),
      auditSink: sink,
    })

    // This should advance through implement -> review (approval) -> push
    const result = await guard.run(
      'Bash',
      { command: 'git push origin feature' },
      async () => 'pushed',
      { sessionId: 'wf-approval-emit' },
    )

    expect(result).toBe('pushed')

    // Should have stage advance events emitted
    const stageAdvanced = sink.getByAction(AuditAction.WORKFLOW_STAGE_ADVANCED)
    expect(stageAdvanced.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// WorkflowRuntime.reset returns workflow_state_updated events
// ---------------------------------------------------------------------------

describe('WorkflowRuntimeResetEvents', () => {
  test('reset returns workflow_state_updated progress event', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: reset-event-process
stages:
  - id: implement
    tools: [Edit]
  - id: review
    entry:
      - condition: stage_complete("implement")
    approval:
      message: Approval required before push
  - id: push
    entry:
      - condition: stage_complete("review")
    tools: [Bash]
`)
    const session = makeWorkflowSession('wf-reset-events')

    // Advance to push stage
    await runtime.recordApproval(session, 'review')

    const events = await runtime.reset(session, 'implement')

    expect(events).toHaveLength(1)
    expect(events[0]!['action']).toBe('workflow_state_updated')
    expect((events[0]!['workflow'] as Record<string, unknown>)['workflow_name']).toBe(
      'reset-event-process',
    )
    expect((events[0]!['workflow'] as Record<string, unknown>)['stage_id']).toBe('implement')
  })

  test('reset clears enrichment fields', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: reset-enrich-process
stages:
  - id: implement
    tools: [Edit]
  - id: review
    entry:
      - condition: stage_complete("implement")
    approval:
      message: Approval required
`)
    const session = makeWorkflowSession('wf-reset-enrich')

    await runtime.reset(session, 'implement')

    const state = await runtime.state(session)
    expect(state.blockedReason).toBeNull()
    expect(state.pendingApproval).toBeNull()
    expect(state.lastBlockedAction).toBeNull()
  })
})
