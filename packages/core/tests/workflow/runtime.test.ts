import { describe, expect, test } from 'vitest'

import {
  AuditAction,
  Edictum,
  EdictumDenied,
  MemoryBackend,
  RedactionPolicy,
  Session,
  WorkflowRuntime,
} from '../../src/index.js'
import { MAX_WORKFLOW_EVIDENCE_ITEMS, workflowStateKey } from '../../src/workflow/state.js'
import {
  makeCall,
  makeWorkflowRuntime,
  makeWorkflowSession,
  AutoApprovalBackend,
} from './fixtures.js'

describe('WorkflowRuntime', () => {
  test('read before edit records evidence only after success', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: core-dev-process
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
    const session = makeWorkflowSession('wf-read-before-edit')

    const edit = makeCall('Edit', { path: 'src/app.ts' })
    let decision = await runtime.evaluate(session, edit)
    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('Read the workflow spec first')

    const read = makeCall('Read', { path: 'specs/008.md' })
    decision = await runtime.evaluate(session, read)
    expect(decision.action).toBe('allow')
    expect(decision.stageId).toBe('read-context')

    await runtime.recordResult(session, decision.stageId, read)

    const state = await runtime.state(session)
    expect(state.evidence.reads).toEqual(['specs/008.md'])

    decision = await runtime.evaluate(session, edit)
    expect(decision.action).toBe('allow')
    expect(decision.stageId).toBe('implement')
  })

  test('approval boundary and reset', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: approval-process
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
    checks:
      - command_not_matches: "^git push origin main$"
        message: Push to a branch, not main
`)
    const session = makeWorkflowSession('wf-approval')

    const push = makeCall('Bash', { command: 'git push origin feature' })
    let decision = await runtime.evaluate(session, push)
    expect(decision.action).toBe('pending_approval')
    expect(decision.stageId).toBe('review')

    await runtime.recordApproval(session, 'review')

    decision = await runtime.evaluate(session, push)
    expect(decision.action).toBe('allow')
    expect(decision.stageId).toBe('push')

    decision = await runtime.evaluate(
      session,
      makeCall('Bash', { command: 'git push origin main' }),
    )
    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('Push to a branch, not main')

    const events = await runtime.reset(session, 'implement')
    const state = await runtime.state(session)
    expect(state.activeStage).toBe('implement')
    expect(state.completedStages).toEqual([])
    expect(state.approvals).toEqual({})
    expect(state.pendingApproval).toEqual({ required: false })
    expect(state.blockedReason).toBeNull()
    expect(state.lastBlockedAction).toBeNull()
    expect(events).toEqual([
      {
        action: AuditAction.WORKFLOW_STATE_UPDATED,
        workflow: {
          name: 'approval-process',
          activeStage: 'implement',
          completedStages: [],
          blockedReason: null,
          pendingApproval: { required: false },
        },
      },
    ])
  })

  test('programmatic definitions re-derive compiled check regexes', async () => {
    const runtime = new WorkflowRuntime({
      apiVersion: 'edictum/v1',
      kind: 'Workflow',
      metadata: { name: 'programmatic-checks' },
      stages: [
        {
          id: 'commit-push',
          entry: [],
          tools: ['Bash'],
          checks: [
            {
              commandMatches: '',
              commandNotMatches: '^git push origin main$',
              message: 'Push to a branch, not main',
              commandMatchesRegex: null,
              commandNotRegex: null,
            },
          ],
          exit: [],
          approval: null,
        },
      ],
    })
    const session = makeWorkflowSession('wf-programmatic-checks')

    const decision = await runtime.evaluate(
      session,
      makeCall('Bash', { command: 'git push origin main' }),
    )
    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('Push to a branch, not main')
  })

  test('stage check failure wins over generic completion failure when next stage exists', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: push-reason-precedence
stages:
  - id: implement
    tools: [Edit]
  - id: review
    entry:
      - condition: stage_complete("implement")
    approval:
      message: Approval required before push
  - id: commit-push
    entry:
      - condition: stage_complete("review")
    tools: [Bash]
    checks:
      - command_matches: '^git\\s+(status|diff|add|commit|push)\\b'
        message: Only git status/diff/add/commit/push are allowed in commit-push
      - command_not_matches: '^git\\s+push\\b.*\\bmain\\b'
        message: Push to a branch, not main
    exit:
      - condition: 'command_matches("^git\\s+push\\b")'
        message: A successful git push is required before leaving commit-push
      - condition: 'command_not_matches("^git\\s+push\\b.*\\bmain\\b")'
        message: Push to a branch, not main
  - id: done
    entry:
      - condition: stage_complete("commit-push")
`)
    const session = makeWorkflowSession('wf-push-reason-precedence')

    let decision = await runtime.evaluate(session, makeCall('Edit', { path: 'src/app.ts' }))
    expect(decision.action).toBe('allow')
    await runtime.recordResult(session, decision.stageId, makeCall('Edit', { path: 'src/app.ts' }))

    decision = await runtime.evaluate(
      session,
      makeCall('Bash', { command: 'git push origin main --dry-run' }),
    )
    expect(decision.action).toBe('pending_approval')
    expect(decision.stageId).toBe('review')

    await runtime.recordApproval(session, 'review')

    decision = await runtime.evaluate(
      session,
      makeCall('Bash', { command: 'git push origin main --dry-run' }),
    )
    expect(decision.action).toBe('block')
    expect(decision.stageId).toBe('commit-push')
    expect(decision.reason).toBe('Push to a branch, not main')
  })

  describe('security', () => {
    test('rejects corrupted persisted workflow state', async () => {
      const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: corrupt-state-process
stages:
  - id: implement
    tools: [Edit]
`)
      const session = makeWorkflowSession('wf-corrupt-state')

      await session.setValue(workflowStateKey('corrupt-state-process'), '{"activeStage":')

      await expect(runtime.state(session)).rejects.toThrow(/decode persisted state/i)
    })

    test('caps persisted evidence arrays and ignores phantom stage evidence on reload', async () => {
      const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: persisted-evidence-process
stages:
  - id: implement
    tools: [Edit]
`)
      const session = makeWorkflowSession('wf-persisted-evidence')

      await session.setValue(
        workflowStateKey('persisted-evidence-process'),
        JSON.stringify({
          activeStage: 'implement',
          completedStages: [],
          approvals: {},
          evidence: {
            reads: Array.from(
              { length: MAX_WORKFLOW_EVIDENCE_ITEMS + 25 },
              (_, index) => `spec-${index}.md`,
            ),
            stageCalls: {
              implement: Array.from(
                { length: MAX_WORKFLOW_EVIDENCE_ITEMS + 25 },
                (_, index) => `echo ${index}`,
              ),
              phantom: ['echo bypass'],
            },
          },
        }),
      )

      const state = await runtime.state(session)

      expect(state.evidence.reads).toHaveLength(MAX_WORKFLOW_EVIDENCE_ITEMS)
      expect(state.evidence.stageCalls.implement).toHaveLength(MAX_WORKFLOW_EVIDENCE_ITEMS)
      expect(state.evidence.stageCalls.phantom).toBeUndefined()
    })

    test('phantom persisted stage data does not satisfy workflow gates', async () => {
      const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: phantom-stage-process
stages:
  - id: read-context
    tools: [Read]
    exit:
      - condition: file_read("specs/008.md")
        message: Read the workflow spec first
  - id: review
    entry:
      - condition: stage_complete("read-context")
    approval:
      message: Approval required before push
  - id: push
    entry:
      - condition: stage_complete("review")
    tools: [Bash]
`)
      const session = makeWorkflowSession('wf-phantom-stage')

      await session.setValue(
        workflowStateKey('phantom-stage-process'),
        JSON.stringify({
          activeStage: 'read-context',
          completedStages: ['phantom-stage'],
          approvals: { 'phantom-stage': 'approved' },
          evidence: {
            reads: [],
            stageCalls: { 'phantom-stage': ['echo bypass'] },
          },
        }),
      )

      const decision = await runtime.evaluate(
        session,
        makeCall('Bash', { command: 'git push origin feature' }),
      )

      expect(decision.action).toBe('block')
      expect(decision.stageId).toBe('read-context')
      expect(decision.reason).toBe('Read the workflow spec first')
    })
  })

  test('workflow state persistence round trip preserves enriched fields', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: snapshot-roundtrip
stages:
  - id: implement
    tools: [Edit]
`)
    const session = makeWorkflowSession('snapshot-roundtrip')

    await session.setValue(
      workflowStateKey('snapshot-roundtrip'),
      JSON.stringify({
        activeStage: 'implement',
        completedStages: [],
        approvals: {},
        evidence: {
          reads: [],
          stageCalls: {},
        },
        blockedReason: 'Only review-safe git commands allowed',
        pendingApproval: {
          required: true,
          stageId: 'implement',
          message: 'Approve after local review',
        },
        lastBlockedAction: {
          tool: 'Bash',
          summary: 'git push origin HEAD',
          message: 'Only review-safe git commands allowed',
          timestamp: '2026-04-04T00:00:00Z',
        },
      }),
    )

    const state = await runtime.state(session)

    expect(state.blockedReason).toBe('Only review-safe git commands allowed')
    expect(state.pendingApproval).toEqual({
      required: true,
      stageId: 'implement',
      message: 'Approve after local review',
    })
    expect(state.lastBlockedAction).toEqual({
      tool: 'Bash',
      summary: 'git push origin HEAD',
      message: 'Only review-safe git commands allowed',
      timestamp: '2026-04-04T00:00:00Z',
    })
  })

  test('blocked workflow call persists blocked snapshot', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: blocked-snapshot
stages:
  - id: implement
    tools: [Edit]
`)
    const session = makeWorkflowSession('blocked-snapshot')

    const decision = await runtime.evaluate(
      session,
      makeCall('Bash', { command: 'git push origin HEAD' }),
    )
    const state = await runtime.state(session)

    expect(decision.action).toBe('block')
    expect(state.blockedReason).toBe('Tool is not allowed in this workflow stage')
    expect(state.pendingApproval).toEqual({ required: false })
    expect(state.lastBlockedAction).toEqual(
      expect.objectContaining({
        tool: 'Bash',
        summary: 'git push origin HEAD',
        message: 'Tool is not allowed in this workflow stage',
      }),
    )
  })

  test('pending workflow call persists pending approval snapshot', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: pending-snapshot
stages:
  - id: implement
    tools: [Edit]
  - id: review
    entry:
      - condition: stage_complete("implement")
    approval:
      message: need review
  - id: push
    entry:
      - condition: stage_complete("review")
    tools: [Bash]
`)
    const session = makeWorkflowSession('pending-snapshot')

    const edit = makeCall('Edit', { path: 'src/app.ts' })
    let decision = await runtime.evaluate(session, edit)
    await runtime.recordResult(session, decision.stageId, edit)

    decision = await runtime.evaluate(
      session,
      makeCall('Bash', { command: 'git push origin feature' }),
    )
    const state = await runtime.state(session)

    expect(decision.action).toBe('pending_approval')
    expect(state.blockedReason).toBeNull()
    expect(state.pendingApproval).toEqual({
      required: true,
      stageId: 'review',
      message: 'need review',
    })
  })
})

describe('WorkflowGuardIntegration', () => {
  test('guard.run records workflow evidence on successful execution', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: guard-process
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
    })

    await expect(
      guard.run('Edit', { path: 'src/app.ts' }, async () => 'edited', { sessionId: 'wf-guard' }),
    ).rejects.toThrow(EdictumDenied)

    await guard.run('Read', { path: 'specs/008.md' }, async () => 'read', { sessionId: 'wf-guard' })
    const result = await guard.run('Edit', { path: 'src/app.ts' }, async () => 'edited', {
      sessionId: 'wf-guard',
    })

    expect(result).toBe('edited')
    const state = await runtime.state(new Session('wf-guard', guard.backend))
    expect(state.evidence.reads).toEqual(['specs/008.md'])
  })

  test('workflow approval path re-evaluates and advances before execution', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: approval-guard-process
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
    })

    const result = await guard.run(
      'Bash',
      { command: 'git push origin feature' },
      async () => 'pushed',
      { sessionId: 'wf-approval-guard' },
    )

    expect(result).toBe('pushed')
    const state = await runtime.state(new Session('wf-approval-guard', guard.backend))
    expect(state.activeStage).toBe('push')
    expect(state.completedStages).toEqual(['implement', 'review'])
  })

  test('guard.run emits workflow audit events with workflow snapshots and sessionId', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: audit-process
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
    })

    await guard.run('Read', { path: 'specs/008.md' }, async () => 'read', { sessionId: 'wf-audit' })
    await guard.run('Edit', { path: 'src/app.ts' }, async () => 'edited', { sessionId: 'wf-audit' })

    const allowed = guard.localSink.events.find(
      (event) => event.action === AuditAction.CALL_ALLOWED,
    )
    expect(allowed?.sessionId).toBe('wf-audit')
    expect(allowed?.workflow).toEqual({
      name: 'audit-process',
      activeStage: 'read-context',
      completedStages: [],
      blockedReason: null,
      pendingApproval: { required: false },
    })

    const stageAdvanced = guard.localSink.events.find(
      (event) => event.action === AuditAction.WORKFLOW_STAGE_ADVANCED,
    )
    expect(stageAdvanced?.sessionId).toBe('wf-audit')
    expect(stageAdvanced?.workflow).toMatchObject({
      name: 'audit-process',
      activeStage: 'implement',
      completedStages: ['read-context'],
      blockedReason: null,
      pendingApproval: { required: false },
      lastRecordedEvidence: {
        tool: 'Read',
        summary: 'specs/008.md',
      },
    })

    const completed = guard.localSink.events.find(
      (event) => event.action === AuditAction.WORKFLOW_COMPLETED,
    )
    expect(completed).toBeUndefined()

    const state = await runtime.state(new Session('wf-audit', guard.backend))
    expect(state.activeStage).toBe('implement')
    expect(state.completedStages).toEqual(['read-context'])
  })

  test('guard.run redacts workflow blocked action summaries in audit events', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: redacted-blocked-summary
stages:
  - id: implement
    tools: [Edit]
`)
    const guard = new Edictum({
      backend: new MemoryBackend(),
      workflowRuntime: runtime,
      redaction: new RedactionPolicy(),
    })

    await expect(
      guard.run(
        'Bash',
        { command: 'export AWS_SECRET_KEY=abc123 && git push origin feature' },
        async () => 'blocked',
        { sessionId: 'wf-redacted-summary' },
      ),
    ).rejects.toBeInstanceOf(EdictumDenied)

    const denied = guard.localSink.events.find((event) => event.action === AuditAction.CALL_DENIED)
    expect(denied?.toolArgs).toEqual({
      command: 'export AWS_SECRET_KEY=[REDACTED] && git push origin feature',
    })
    expect(denied?.workflow?.lastBlockedAction?.summary).toBe(
      'export AWS_SECRET_KEY=[REDACTED] && git push origin feature',
    )
    expect(denied?.workflow?.lastBlockedAction?.summary).not.toContain('abc123')
  })
})
