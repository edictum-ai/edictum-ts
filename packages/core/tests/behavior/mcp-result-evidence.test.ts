import { describe, expect, test } from 'vitest'

import { makeCall, makeWorkflowRuntime, makeWorkflowSession } from '../workflow/fixtures.js'

const MCP_WORKFLOW = `apiVersion: edictum/v1
kind: Workflow
metadata:
  name: mcp-evidence-test
stages:
  - id: scan
    tools: [ScanTool]
    exit:
      - condition: mcp_result_matches("ScanTool", "verdict", "approved")
        message: ScanTool must return verdict=approved
  - id: deploy
    entry:
      - condition: stage_complete("scan")
    tools: [Deploy]
`

describe('WorkflowRuntime.recordResult mcpResult parameter', () => {
  test('recording an mcpResult populates evidence.mcpResults', async () => {
    const runtime = makeWorkflowRuntime(MCP_WORKFLOW)
    const session = makeWorkflowSession('mcp-evidence-1')
    const call = makeCall('ScanTool', {})

    await runtime.evaluate(session, call)
    await runtime.recordResult(session, 'scan', call, { verdict: 'approved', score: 100 })

    const state = await runtime.state(session)
    expect(state.evidence.mcpResults['ScanTool']).toBeDefined()
    expect(state.evidence.mcpResults['ScanTool']?.[0]).toEqual({ verdict: 'approved', score: 100 })
  })

  test('mcpResult makes mcp_result_matches gate pass', async () => {
    const runtime = makeWorkflowRuntime(MCP_WORKFLOW)
    const session = makeWorkflowSession('mcp-evidence-2')
    const scan = makeCall('ScanTool', {})
    const deploy = makeCall('Deploy', {})

    await runtime.evaluate(session, scan)
    await runtime.recordResult(session, 'scan', scan, { verdict: 'approved' })

    // After recording approval, deploy should be allowed
    const decision = await runtime.evaluate(session, deploy)
    expect(decision.action).toBe('allow')
    expect(decision.stageId).toBe('deploy')
  })

  test('mcp_result_matches gate stays blocked without mcpResult', async () => {
    const runtime = makeWorkflowRuntime(MCP_WORKFLOW)
    const session = makeWorkflowSession('mcp-evidence-3')
    const scan = makeCall('ScanTool', {})
    const deploy = makeCall('Deploy', {})

    await runtime.evaluate(session, scan)
    // Record without mcpResult — gate should remain blocked
    await runtime.recordResult(session, 'scan', scan, undefined)

    const decision = await runtime.evaluate(session, deploy)
    expect(decision.action).toBe('block')
    expect(decision.reason).toContain('approved')
  })

  describe('security', () => {
    test('array value does not satisfy string gate condition', async () => {
      const runtime = makeWorkflowRuntime(MCP_WORKFLOW)
      const session = makeWorkflowSession('mcp-security-1')
      const scan = makeCall('ScanTool', {})
      const deploy = makeCall('Deploy', {})

      await runtime.evaluate(session, scan)
      // Attacker passes verdict as array ["approved"] instead of string "approved"
      await runtime.recordResult(session, 'scan', scan, { verdict: ['approved'] })

      const decision = await runtime.evaluate(session, deploy)
      expect(decision.action).toBe('block')
    })

    test('null value does not satisfy string gate condition', async () => {
      const runtime = makeWorkflowRuntime(MCP_WORKFLOW)
      const session = makeWorkflowSession('mcp-security-2')
      const scan = makeCall('ScanTool', {})
      const deploy = makeCall('Deploy', {})

      await runtime.evaluate(session, scan)
      await runtime.recordResult(session, 'scan', scan, { verdict: null })

      const decision = await runtime.evaluate(session, deploy)
      expect(decision.action).toBe('block')
    })

    test('undefined field does not satisfy string gate condition', async () => {
      const runtime = makeWorkflowRuntime(MCP_WORKFLOW)
      const session = makeWorkflowSession('mcp-security-3')
      const scan = makeCall('ScanTool', {})
      const deploy = makeCall('Deploy', {})

      await runtime.evaluate(session, scan)
      // verdict field is missing entirely
      await runtime.recordResult(session, 'scan', scan, { status: 'ok' })

      const decision = await runtime.evaluate(session, deploy)
      expect(decision.action).toBe('block')
    })
  })
})
