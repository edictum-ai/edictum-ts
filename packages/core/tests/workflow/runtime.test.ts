import { describe, expect, test } from 'vitest'

import { Edictum, EdictumDenied, MemoryBackend, Session } from '../../src/index.js'
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

    await runtime.reset(session, 'implement')
    const state = await runtime.state(session)
    expect(state.activeStage).toBe('implement')
    expect(state.completedStages).toEqual([])
    expect(state.approvals).toEqual({})
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
    expect(state.activeStage).toBe('')
    expect(state.completedStages).toEqual(['implement', 'review', 'push'])
  })
})
