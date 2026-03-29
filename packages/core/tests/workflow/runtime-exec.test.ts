import { describe, expect, test } from 'vitest'

import { WorkflowRuntime, loadWorkflowString } from '../../src/index.js'
import { makeCall, makeWorkflowRuntime, makeWorkflowSession } from './fixtures.js'

describe('WorkflowExecRuntime', () => {
  test('exec and command evaluators', async () => {
    const runtime = makeWorkflowRuntime(
      `apiVersion: edictum/v1
kind: Workflow
metadata:
  name: verify-process
stages:
  - id: local-verify
    tools: [Bash]
    checks:
      - command_matches: "^node --version$"
        message: Only node --version is allowed
    exit:
      - condition: exec("node --version", exit_code=0)
        message: Node must be installed
  - id: commit-push
    entry:
      - condition: stage_complete("local-verify")
    tools: [Bash]
    checks:
      - command_not_matches: "^git push origin main$"
        message: Push to a branch, not main
    exit:
      - condition: command_not_matches("^git push origin main$")
        message: Push to a branch, not main
`,
      { execEvaluatorEnabled: true },
    )
    const session = makeWorkflowSession('wf-exec')

    const verify = makeCall('Bash', { command: 'node --version' })
    let decision = await runtime.evaluate(session, verify)
    expect(decision.action).toBe('allow')

    await runtime.recordResult(session, decision.stageId, verify)

    const mainPush = makeCall('Bash', { command: 'git push origin main' })
    decision = await runtime.evaluate(session, mainPush)
    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('Push to a branch, not main')
  })

  test('exec requires explicit opt-in', () => {
    const definition = loadWorkflowString(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: exec-disabled
stages:
  - id: verify
    tools: [Bash]
    exit:
      - condition: exec("node --version", exit_code=0)
        message: Node must be installed
`)

    expect(() => new WorkflowRuntime(definition)).toThrow(
      /exec\(\.\.\.\) conditions require|exec\(\)/,
    )
  })

  test('exec evaluator times out hung commands', async () => {
    const hangingCommand = 'node -e "setTimeout(() => {}, 5000)"'
    const runtime = makeWorkflowRuntime(
      `apiVersion: edictum/v1
kind: Workflow
metadata:
  name: exec-timeout
stages:
  - id: verify
    tools: [Bash]
    exit:
      - condition: exec("node -e \\"setTimeout(() => {}, 5000)\\"", exit_code=0)
        message: Command must finish
`,
      { execEvaluatorEnabled: true, execEvaluatorTimeoutMs: 25 },
    )
    const session = makeWorkflowSession('wf-exec-timeout')
    const call = makeCall('Bash', { command: hangingCommand })
    const decision = await runtime.evaluate(session, call)

    expect(decision.action).toBe('allow')
    await expect(runtime.recordResult(session, decision.stageId, call)).rejects.toThrow(
      /timed out/i,
    )
  }, 10_000)

  test('empty tools means all tools allowed', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: unrestricted-stage
stages:
  - id: implement
`)
    const session = makeWorkflowSession('wf-empty-tools')
    const decision = await runtime.evaluate(session, makeCall('Edit', { path: 'src/app.ts' }))
    expect(decision.action).toBe('allow')
  })

  test('tools allowlist is authoritative when present', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: listed-tools-only
stages:
  - id: inspect
    tools: [Read]
`)
    const session = makeWorkflowSession('wf-listed-tools-only')

    const readDecision = await runtime.evaluate(session, makeCall('Read', { path: 'specs/008.md' }))
    expect(readDecision.action).toBe('allow')

    const editDecision = await runtime.evaluate(session, makeCall('Edit', { path: 'src/app.ts' }))
    expect(editDecision.action).toBe('block')
  })

  test('stage tools allowlist blocks read and grep when absent', async () => {
    const runtime = makeWorkflowRuntime(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: inspection-tools
stages:
  - id: implement
    tools: [Edit]
`)
    const session = makeWorkflowSession('wf-inspection-tools')

    for (const call of [
      makeCall('Read', { path: 'specs/008.md' }),
      makeCall('Grep', { path: 'specs', pattern: 'workflow' }),
    ]) {
      const decision = await runtime.evaluate(session, call)
      expect(decision.action).toBe('block')
    }
  })
})
