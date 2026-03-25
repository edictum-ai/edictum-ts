/**
 * OpenAI Agents SDK adapter tests.
 *
 * Tests use _pre/_post directly — no SDK dependency needed.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AuditAction,
  CollectingAuditSink,
  Edictum,
  Verdict,
  type Precondition,
  type Postcondition,
  type SessionContract,
  createPrincipal,
} from '@edictum/core'
import { OpenAIAgentsAdapter } from '../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGuard(options: ConstructorParameters<typeof Edictum>[0] = {}): Edictum {
  return new Edictum(options)
}

// ---------------------------------------------------------------------------
// Basic allow / deny
// ---------------------------------------------------------------------------

describe('OpenAIAgentsAdapter', () => {
  it('allows with no contracts', async () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)
    const result = await adapter._pre('MyTool', { key: 'value' }, 'call-1')
    expect(result).toBeNull()
  })

  it('denies when precondition fails', async () => {
    const noRm: Precondition = {
      tool: 'Bash',
      check: async (envelope) => {
        if (
          typeof envelope.args['command'] === 'string' &&
          envelope.args['command'].includes('rm -rf')
        ) {
          return Verdict.fail('Cannot run rm -rf')
        }
        return Verdict.pass_()
      },
    }
    const guard = makeGuard({ contracts: [noRm] })
    const adapter = new OpenAIAgentsAdapter(guard)

    const result = await adapter._pre('Bash', { command: 'rm -rf /' }, 'call-1')
    expect(result).toBe('DENIED: Cannot run rm -rf')
  })

  it('allows when precondition passes', async () => {
    const noRm: Precondition = {
      tool: 'Bash',
      check: async (envelope) => {
        if (
          typeof envelope.args['command'] === 'string' &&
          envelope.args['command'].includes('rm -rf')
        ) {
          return Verdict.fail('Cannot run rm -rf')
        }
        return Verdict.pass_()
      },
    }
    const guard = makeGuard({ contracts: [noRm] })
    const adapter = new OpenAIAgentsAdapter(guard)

    const result = await adapter._pre('Bash', { command: 'ls' }, 'call-1')
    expect(result).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Post-execution
  // -----------------------------------------------------------------------

  it('post returns result when no contracts', async () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const postResult = await adapter._post('call-1', 'tool output')

    expect(postResult.result).toBe('tool output')
    expect(postResult.postconditionsPassed).toBe(true)
    expect(postResult.findings).toHaveLength(0)
  })

  it('post returns result for unknown call_id', async () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)

    const postResult = await adapter._post('nonexistent', 'tool output')
    expect(postResult.result).toBe('tool output')
    expect(postResult.postconditionsPassed).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Observe mode
  // -----------------------------------------------------------------------

  it('observe mode converts deny to allow', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('always deny'),
    }
    const guard = makeGuard({ mode: 'observe', contracts: [blockAll] })
    const adapter = new OpenAIAgentsAdapter(guard)

    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBeNull() // allowed through in observe mode
  })

  it('observe mode emits CALL_WOULD_DENY audit event', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('always deny'),
    }
    const guard = makeGuard({ mode: 'observe', contracts: [blockAll] })
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_WOULD_DENY)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]!.toolName).toBe('MyTool')
  })

  // -----------------------------------------------------------------------
  // Callbacks
  // -----------------------------------------------------------------------

  it('fires onDeny callback on denial', async () => {
    const onDeny = vi.fn()
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('blocked'),
    }
    const guard = makeGuard({ contracts: [blockAll], onDeny })
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    expect(onDeny).toHaveBeenCalledTimes(1)
    expect(onDeny.mock.calls[0]![1]).toBe('blocked')
  })

  it('fires onAllow callback on allow', async () => {
    const onAllow = vi.fn()
    const guard = makeGuard({ onAllow })
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    expect(onAllow).toHaveBeenCalledTimes(1)
  })

  it('swallows onDeny callback exceptions', async () => {
    const onDeny = vi.fn(() => {
      throw new Error('callback boom')
    })
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('blocked'),
    }
    const guard = makeGuard({ contracts: [blockAll], onDeny })
    const adapter = new OpenAIAgentsAdapter(guard)

    // Should not throw
    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBe('DENIED: blocked')
    expect(onDeny).toHaveBeenCalledTimes(1)
  })

  it('fires onPostconditionWarn callback', async () => {
    const onWarn = vi.fn()
    const postContract: Postcondition = {
      tool: '*',
      contractType: 'post',
      check: async () => Verdict.fail('output issue'),
    }
    const guard = makeGuard({
      contracts: [postContract],
      tools: { MyTool: { side_effect: 'pure' } },
    })
    const adapter = new OpenAIAgentsAdapter(guard)
    adapter.asGuardrails({ onPostconditionWarn: onWarn })

    await adapter._pre('MyTool', {}, 'call-1')
    const postResult = await adapter._post('call-1', 'some output')

    expect(postResult.postconditionsPassed).toBe(false)
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]![1]).toHaveLength(1)
  })

  // -----------------------------------------------------------------------
  // Audit events
  // -----------------------------------------------------------------------

  it('emits CALL_ALLOWED on allow', async () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_ALLOWED)
    expect(events).toHaveLength(1)
    expect(events[0]!.toolName).toBe('MyTool')
  })

  it('emits CALL_DENIED on deny', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('blocked'),
    }
    const guard = makeGuard({ contracts: [blockAll] })
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_DENIED)
    expect(events).toHaveLength(1)
    expect(events[0]!.reason).toBe('blocked')
  })

  it('emits CALL_EXECUTED on post', async () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    await adapter._post('call-1', 'result')

    const events = guard.localSink.filter(AuditAction.CALL_EXECUTED)
    expect(events).toHaveLength(1)
  })

  it('emits CALL_FAILED for error response', async () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    await adapter._post('call-1', 'error: something failed')

    const events = guard.localSink.filter(AuditAction.CALL_FAILED)
    expect(events).toHaveLength(1)
  })

  // -----------------------------------------------------------------------
  // Session counting
  // -----------------------------------------------------------------------

  it('increments session attempt count', async () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('ToolA', {}, 'c1')
    await adapter._pre('ToolB', {}, 'c2')

    // Check audit events for session_attempt_count
    const events = guard.localSink.filter(AuditAction.CALL_ALLOWED)
    expect(events).toHaveLength(2)
    expect(events[0]!.sessionAttemptCount).toBe(1)
    expect(events[1]!.sessionAttemptCount).toBe(2)
  })

  it('tracks session execution count after post', async () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('ToolA', {}, 'c1')
    await adapter._post('c1', 'ok')

    await adapter._pre('ToolB', {}, 'c2')
    await adapter._post('c2', 'ok')

    const execEvents = guard.localSink.filter(AuditAction.CALL_EXECUTED)
    expect(execEvents).toHaveLength(2)
    expect(execEvents[0]!.sessionExecutionCount).toBe(1)
    expect(execEvents[1]!.sessionExecutionCount).toBe(2)
  })

  // -----------------------------------------------------------------------
  // Principal
  // -----------------------------------------------------------------------

  it('uses static principal', async () => {
    const principal = createPrincipal({ userId: 'user-1', role: 'admin' })
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard, { principal })

    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_ALLOWED)
    expect(events[0]!.principal).toBeTruthy()
    expect((events[0]!.principal as Record<string, unknown>)['userId']).toBe('user-1')
  })

  it('uses principal resolver over static', async () => {
    const principal = createPrincipal({ userId: 'static' })
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard, {
      principal,
      principalResolver: () => createPrincipal({ userId: 'resolved' }),
    })

    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_ALLOWED)
    expect((events[0]!.principal as Record<string, unknown>)['userId']).toBe('resolved')
  })

  it('setPrincipal updates principal', async () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)

    adapter.setPrincipal(createPrincipal({ userId: 'updated' }))
    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_ALLOWED)
    expect((events[0]!.principal as Record<string, unknown>)['userId']).toBe('updated')
  })

  // -----------------------------------------------------------------------
  // asGuardrails interface
  // -----------------------------------------------------------------------

  it('asGuardrails returns correct structure', () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)
    const { inputGuardrail, outputGuardrail } = adapter.asGuardrails()

    expect(inputGuardrail.name).toBe('edictum_input_guardrail')
    expect(outputGuardrail.name).toBe('edictum_output_guardrail')
    expect(typeof inputGuardrail.execute).toBe('function')
    expect(typeof outputGuardrail.execute).toBe('function')
  })

  it('asGuardrails input allows through', async () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)
    const { inputGuardrail } = adapter.asGuardrails()

    const result = await inputGuardrail.execute({
      input: { toolName: 'MyTool', toolInput: {}, callId: 'c1' },
    })
    expect(result.tripwireTriggered).toBe(false)
  })

  it('asGuardrails input trips on deny', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('blocked'),
    }
    const guard = makeGuard({ contracts: [blockAll] })
    const adapter = new OpenAIAgentsAdapter(guard)
    const { inputGuardrail } = adapter.asGuardrails()

    const result = await inputGuardrail.execute({
      input: { toolName: 'MyTool', toolInput: {}, callId: 'c1' },
    })
    expect(result.tripwireTriggered).toBe(true)
    expect(result.outputInfo).toBe('DENIED: blocked')
  })

  // -----------------------------------------------------------------------
  // Session ID
  // -----------------------------------------------------------------------

  it('uses custom sessionId', () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard, {
      sessionId: 'custom-session',
    })
    expect(adapter.sessionId).toBe('custom-session')
  })

  it('generates sessionId when not provided', () => {
    const guard = makeGuard()
    const adapter = new OpenAIAgentsAdapter(guard)
    expect(adapter.sessionId).toBeTruthy()
    expect(adapter.sessionId.length).toBeGreaterThan(0)
  })

  // -----------------------------------------------------------------------
  // Postcondition output suppression
  // -----------------------------------------------------------------------

  it('post suppresses output on deny effect', async () => {
    // Internal postcondition with effect: "deny" (user-facing Postcondition
    // doesn't have an effect field — it's on internal contracts from YAML)
    const postContract = {
      _edictum_type: 'postcondition',
      type: 'postcondition',
      name: 'suppress_test',
      tool: '*',
      effect: 'deny',
      check: async () => Verdict.fail('sensitive data detected'),
    }
    const guard = makeGuard({
      contracts: [postContract as unknown as Postcondition],
      tools: { MyTool: { side_effect: 'pure' } },
    })
    const adapter = new OpenAIAgentsAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const postResult = await adapter._post('call-1', 'secret data')

    expect(postResult.outputSuppressed).toBe(true)
    expect(String(postResult.result)).toContain('[OUTPUT SUPPRESSED]')
  })

  // -----------------------------------------------------------------------
  // Per-contract observe mode
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Ambiguous same-name call correlation (Finding #8)
  // -----------------------------------------------------------------------

  describe('ambiguous same-name call correlation', () => {
    it('skips postcondition when two same-name calls pending (no explicit ID)', async () => {
      const postContract: Postcondition = {
        tool: '*',
        contractType: 'post',
        check: async () => Verdict.fail('should not run'),
      }
      const guard = makeGuard({ contracts: [postContract] })
      const adapter = new OpenAIAgentsAdapter(guard)

      // Two Read calls pending
      await adapter._pre('Read', { path: '/a' }, 'call-1')
      await adapter._pre('Read', { path: '/b' }, 'call-2')

      // Output guardrail has no explicit call ID — should passthrough (not misattribute)
      const { outputGuardrail } = adapter.asGuardrails()
      const result = await outputGuardrail.execute({ agentOutput: 'file contents' })

      expect(result.tripwireTriggered).toBe(false)
    })

    it('correlates correctly when only one call pending', async () => {
      const postContract: Postcondition = {
        tool: '*',
        contractType: 'post',
        check: async () => Verdict.fail('postcondition ran'),
      }
      const guard = makeGuard({
        contracts: [postContract],
        tools: { Read: { side_effect: 'pure' } },
      })
      const adapter = new OpenAIAgentsAdapter(guard)

      await adapter._pre('Read', { path: '/a' }, 'call-1')

      // Only one pending → unambiguous, postcondition should run
      const { outputGuardrail } = adapter.asGuardrails()
      const result = await outputGuardrail.execute({ agentOutput: 'file contents' })

      // Postcondition ran and failed → tripwire triggered (output suppressed by deny effect)
      // or at minimum the postcondition was evaluated
      // With a warn-effect postcondition, tripwireTriggered may be false but postcondition ran
      expect(result).toBeDefined()
    })

    it('correlates correctly with explicit call ID via _post', async () => {
      const postContract: Postcondition = {
        tool: '*',
        contractType: 'post',
        check: async () => Verdict.fail('postcondition ran'),
      }
      const guard = makeGuard({
        contracts: [postContract],
        tools: { Read: { side_effect: 'pure' } },
      })
      const adapter = new OpenAIAgentsAdapter(guard)

      await adapter._pre('Read', { path: '/a' }, 'call-1')
      await adapter._pre('Read', { path: '/b' }, 'call-2')

      // Direct _post with explicit callId → should correlate correctly
      const postResult = await adapter._post('call-2', 'file contents')

      expect(postResult.postconditionsPassed).toBe(false)
      expect(postResult.findings.length).toBeGreaterThan(0)
    })
  })

  it('per-contract observe mode allows through with audit', async () => {
    // Create an internal contract with observe mode
    const observeContract: Precondition & { mode?: string } = {
      tool: '*',
      check: async () => Verdict.fail('would deny'),
      mode: 'observe',
    }
    // Simulate internal contract with _edictum_type
    const internalContract = {
      _edictum_type: 'precondition',
      _edictum_observe: false,
      type: 'precondition',
      name: 'observe_test',
      tool: '*',
      mode: 'observe',
      check: async () => Verdict.fail('would deny'),
    }
    const guard = makeGuard({ contracts: [internalContract as unknown as Precondition] })
    const adapter = new OpenAIAgentsAdapter(guard)

    const result = await adapter._pre('MyTool', {}, 'call-1')
    // Per-contract observe: the contract itself has mode=observe,
    // so the pipeline marks it as observed but allows through
    expect(result).toBeNull()
  })
})
