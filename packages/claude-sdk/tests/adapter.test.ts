/**
 * ClaudeAgentSDKAdapter tests -- exercises _pre/_post directly (no framework imports).
 *
 * Covers: allow, deny, observe mode, callbacks, audit events,
 * tool success/failure, postcondition warnings, session counting,
 * setPrincipal, toSdkHooks interface, per-contract observe mode.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AuditAction,
  CollectingAuditSink,
  Edictum,
  Verdict,
  createPrincipal,
  type Precondition,
  type Postcondition,
  type ToolEnvelope,
} from '@edictum/core'

import { ClaudeAgentSDKAdapter } from '../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSink(): CollectingAuditSink {
  return new CollectingAuditSink()
}

function makeGuard(options: ConstructorParameters<typeof Edictum>[0] = {}): Edictum {
  return new Edictum(options)
}

// ---------------------------------------------------------------------------
// Basic allow / deny
// ---------------------------------------------------------------------------

describe('ClaudeAgentSDKAdapter', () => {
  it('allows with no contracts', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    const result = await adapter._pre('MyTool', { a: 1 }, 'call-1')
    expect(result).toBeNull()

    const allowed = sink.filter(AuditAction.CALL_ALLOWED)
    expect(allowed.length).toBe(1)
    expect(allowed[0]?.toolName).toBe('MyTool')
  })

  it('denies when precondition fails', async () => {
    const noRm: Precondition = {
      tool: '*',
      check: async (envelope: ToolEnvelope) => {
        if ((envelope.args as Record<string, unknown>)['dangerous']) {
          return Verdict.fail('Too dangerous')
        }
        return Verdict.pass_()
      },
    }
    const sink = makeSink()
    const guard = makeGuard({ contracts: [noRm], auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    const result = await adapter._pre('MyTool', { dangerous: true }, 'call-1')
    expect(result).toBe('DENIED: Too dangerous')

    const denied = sink.filter(AuditAction.CALL_DENIED)
    expect(denied.length).toBe(1)
  })

  it('returns null for allowed calls', async () => {
    const alwaysPass: Precondition = {
      tool: '*',
      check: async () => Verdict.pass_(),
    }
    const guard = makeGuard({ contracts: [alwaysPass] })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Observe mode
// ---------------------------------------------------------------------------

describe('observe mode', () => {
  it('converts deny to allow in observe mode', async () => {
    const alwaysDeny: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('Blocked'),
    }
    const sink = makeSink()
    const guard = makeGuard({
      mode: 'observe',
      contracts: [alwaysDeny],
      auditSink: sink,
    })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBeNull() // allowed through

    const wouldDeny = sink.filter(AuditAction.CALL_WOULD_DENY)
    expect(wouldDeny.length).toBe(1)
    expect(wouldDeny[0]?.reason).toBe('Blocked')
  })

  it('emits CALL_WOULD_DENY audit event in observe mode', async () => {
    const alwaysDeny: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('always deny'),
    }
    const guard = makeGuard({ mode: 'observe', contracts: [alwaysDeny] })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_WOULD_DENY)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]!.toolName).toBe('MyTool')
  })
})

// ---------------------------------------------------------------------------
// Callbacks: on_deny / on_allow
// ---------------------------------------------------------------------------

describe('callbacks', () => {
  it('fires on_deny callback on denial', async () => {
    const denyFn = vi.fn()
    const alwaysDeny: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('Nope'),
    }
    const guard = makeGuard({
      contracts: [alwaysDeny],
      onDeny: denyFn,
    })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    expect(denyFn).toHaveBeenCalledTimes(1)
    expect(denyFn.mock.calls[0]?.[1]).toBe('Nope')
  })

  it('fires on_allow callback on allow', async () => {
    const allowFn = vi.fn()
    const guard = makeGuard({ onAllow: allowFn })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    expect(allowFn).toHaveBeenCalledTimes(1)
  })

  it('swallows on_deny callback errors', async () => {
    const denyFn = vi.fn(() => {
      throw new Error('callback boom')
    })
    const alwaysDeny: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('Nope'),
    }
    const guard = makeGuard({
      contracts: [alwaysDeny],
      onDeny: denyFn,
    })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    // Should not throw
    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBe('DENIED: Nope')
    expect(denyFn).toHaveBeenCalledTimes(1)
  })

  it('swallows on_allow callback errors', async () => {
    const allowFn = vi.fn(() => {
      throw new Error('callback boom')
    })
    const guard = makeGuard({ onAllow: allowFn })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    // Should not throw
    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBeNull()
    expect(allowFn).toHaveBeenCalledTimes(1)
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
    const adapter = new ClaudeAgentSDKAdapter(guard)
    adapter.toSdkHooks({ onPostconditionWarn: onWarn })

    await adapter._pre('MyTool', {}, 'call-1')
    const postResult = await adapter._post('call-1', 'some output')

    expect(postResult.postconditionsPassed).toBe(false)
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]![1]).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

describe('audit events', () => {
  it('emits CALL_ALLOWED on pre allow', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', { x: 1 }, 'call-1')

    const events = sink.filter(AuditAction.CALL_ALLOWED)
    expect(events.length).toBe(1)
    expect(events[0]?.toolName).toBe('MyTool')
  })

  it('emits CALL_DENIED on pre deny', async () => {
    const alwaysDeny: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('No'),
    }
    const sink = makeSink()
    const guard = makeGuard({ contracts: [alwaysDeny], auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    const events = sink.filter(AuditAction.CALL_DENIED)
    expect(events.length).toBe(1)
  })

  it('emits CALL_EXECUTED on successful post', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    await adapter._post('call-1', 'success result')

    const events = sink.filter(AuditAction.CALL_EXECUTED)
    expect(events.length).toBe(1)
    expect(events[0]?.toolSuccess).toBe(true)
  })

  it('emits CALL_FAILED on failed tool response', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    await adapter._post('call-1', 'error: something broke')

    const events = sink.filter(AuditAction.CALL_FAILED)
    expect(events.length).toBe(1)
    expect(events[0]?.toolSuccess).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tool success/failure detection
// ---------------------------------------------------------------------------

describe('tool success detection', () => {
  it('treats null response as success', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const result = await adapter._post('call-1', null)

    expect(result.postconditionsPassed).toBe(true)
    const events = sink.filter(AuditAction.CALL_EXECUTED)
    expect(events.length).toBe(1)
  })

  it('treats { is_error: true } as failure', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    await adapter._post('call-1', { is_error: true })

    const events = sink.filter(AuditAction.CALL_FAILED)
    expect(events.length).toBe(1)
  })

  it('uses custom successCheck when provided', async () => {
    const sink = makeSink()
    const guard = makeGuard({
      auditSink: sink,
      successCheck: (_name: string, result: unknown) => result === 'custom-ok',
    })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    await adapter._post('call-1', 'custom-ok')
    expect(sink.filter(AuditAction.CALL_EXECUTED).length).toBe(1)

    await adapter._pre('MyTool', {}, 'call-2')
    await adapter._post('call-2', 'custom-not-ok')
    expect(sink.filter(AuditAction.CALL_FAILED).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Postcondition warnings
// ---------------------------------------------------------------------------

describe('postcondition warnings', () => {
  it('returns postconditionsPassed=false when postcondition fails', async () => {
    const postContract: Postcondition = {
      tool: '*',
      contractType: 'post',
      check: async (_envelope: ToolEnvelope, output: unknown) => {
        if (String(output).includes('secret')) {
          return Verdict.fail('Contains secret data')
        }
        return Verdict.pass_()
      },
    }
    const guard = makeGuard({ contracts: [postContract] })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const result = await adapter._post('call-1', 'the secret is 42')

    expect(result.postconditionsPassed).toBe(false)
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings[0]?.message).toBe('Contains secret data')
  })

  it('returns postconditionsPassed=true when postcondition passes', async () => {
    const postContract: Postcondition = {
      tool: '*',
      contractType: 'post',
      check: async () => Verdict.pass_(),
    }
    const guard = makeGuard({ contracts: [postContract] })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const result = await adapter._post('call-1', 'safe output')

    expect(result.postconditionsPassed).toBe(true)
    expect(result.findings.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Session counting
// ---------------------------------------------------------------------------

describe('session counting', () => {
  it('increments attempt count on each _pre call', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('Tool1', {}, 'call-1')
    await adapter._pre('Tool2', {}, 'call-2')
    await adapter._pre('Tool3', {}, 'call-3')

    // After 3 _pre calls, attempt count should be 3
    const lastEvent = sink.events[sink.events.length - 1]
    expect(lastEvent?.sessionAttemptCount).toBe(3)
  })

  it('increments execution count on each _post call', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('Tool1', {}, 'call-1')
    await adapter._post('call-1', 'ok')
    await adapter._pre('Tool2', {}, 'call-2')
    await adapter._post('call-2', 'ok')

    // Find the last CALL_EXECUTED event
    const executed = sink.filter(AuditAction.CALL_EXECUTED)
    expect(executed.length).toBe(2)
    expect(executed[1]?.sessionExecutionCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// setPrincipal
// ---------------------------------------------------------------------------

describe('setPrincipal', () => {
  it('updates principal for subsequent calls', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    // First call without principal
    await adapter._pre('MyTool', {}, 'call-1')
    const firstEvent = sink.filter(AuditAction.CALL_ALLOWED)[0]
    expect(firstEvent?.principal).toBeNull()

    // Set principal
    const principal = createPrincipal({
      userId: 'user-123',
      role: 'admin',
    })
    adapter.setPrincipal(principal)

    // Second call with principal
    await adapter._pre('MyTool', {}, 'call-2')
    const secondEvent = sink.filter(AuditAction.CALL_ALLOWED)[1]
    expect(secondEvent?.principal).not.toBeNull()
    expect((secondEvent?.principal as Record<string, unknown>)?.['userId']).toBe('user-123')
  })
})

// ---------------------------------------------------------------------------
// Principal resolver
// ---------------------------------------------------------------------------

describe('principalResolver', () => {
  it('resolver overrides static principal', async () => {
    const sink = makeSink()
    const staticPrincipal = createPrincipal({ userId: 'static' })
    const guard = makeGuard({ auditSink: sink })
    const adapter = new ClaudeAgentSDKAdapter(guard, {
      principal: staticPrincipal,
      principalResolver: (toolName: string) => createPrincipal({ userId: `resolved-${toolName}` }),
    })

    await adapter._pre('SpecialTool', {}, 'call-1')
    const event = sink.filter(AuditAction.CALL_ALLOWED)[0]
    expect((event?.principal as Record<string, unknown>)?.['userId']).toBe('resolved-SpecialTool')
  })
})

// ---------------------------------------------------------------------------
// sessionId
// ---------------------------------------------------------------------------

describe('sessionId', () => {
  it('uses provided sessionId', () => {
    const guard = makeGuard()
    const adapter = new ClaudeAgentSDKAdapter(guard, {
      sessionId: 'my-session',
    })
    expect(adapter.sessionId).toBe('my-session')
  })

  it('generates sessionId when not provided', () => {
    const guard = makeGuard()
    const adapter = new ClaudeAgentSDKAdapter(guard)
    expect(adapter.sessionId).toBeTruthy()
    expect(adapter.sessionId.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// _post with unknown callId
// ---------------------------------------------------------------------------

describe('_post edge cases', () => {
  it('returns result passthrough for unknown callId', async () => {
    const guard = makeGuard()
    const adapter = new ClaudeAgentSDKAdapter(guard)

    const result = await adapter._post('unknown-id', 'some output')
    expect(result.result).toBe('some output')
    expect(result.postconditionsPassed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// toSdkHooks
// ---------------------------------------------------------------------------

describe('toSdkHooks', () => {
  it('returns correct structure with PreToolUse and PostToolUse arrays', () => {
    const guard = makeGuard()
    const adapter = new ClaudeAgentSDKAdapter(guard)
    const hooks = adapter.toSdkHooks()

    expect(hooks.PreToolUse).toHaveLength(1)
    expect(hooks.PostToolUse).toHaveLength(1)
    expect(typeof hooks.PreToolUse[0]).toBe('function')
    expect(typeof hooks.PostToolUse[0]).toBe('function')
  })

  it('PreToolUse hook returns allow for passing contracts', async () => {
    const guard = makeGuard()
    const adapter = new ClaudeAgentSDKAdapter(guard)
    const hooks = adapter.toSdkHooks()

    const result = await hooks.PreToolUse[0]!({
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'MyTool',
        tool_input: {},
      },
    })

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    })
  })

  it('PreToolUse hook returns deny for failing contracts', async () => {
    const alwaysDeny: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('Blocked by policy'),
    }
    const guard = makeGuard({ contracts: [alwaysDeny] })
    const adapter = new ClaudeAgentSDKAdapter(guard)
    const hooks = adapter.toSdkHooks()

    const result = await hooks.PreToolUse[0]!({
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'MyTool',
        tool_input: {},
      },
    })

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'DENIED: Blocked by policy',
      },
    })
  })

  it('PostToolUse hook returns empty object when no postconditions', async () => {
    const guard = makeGuard()
    const adapter = new ClaudeAgentSDKAdapter(guard)
    const hooks = adapter.toSdkHooks()

    // First trigger pre to create pending state
    await hooks.PreToolUse[0]!({
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'MyTool',
        tool_input: {},
      },
    })

    const result = await hooks.PostToolUse[0]!({
      input: {
        hook_event_name: 'PostToolUse',
        tool_name: 'MyTool',
        tool_result: 'success',
      },
    })

    expect(result).toEqual({})
  })

  it('PostToolUse hook returns additionalContext on postcondition failure', async () => {
    const postContract: Postcondition = {
      tool: '*',
      contractType: 'post',
      check: async (_envelope: ToolEnvelope, output: unknown) => {
        if (String(output).includes('secret')) {
          return Verdict.fail('Contains secret data')
        }
        return Verdict.pass_()
      },
    }
    const guard = makeGuard({
      contracts: [postContract],
      tools: { MyTool: { side_effect: 'pure' } },
    })
    const adapter = new ClaudeAgentSDKAdapter(guard)
    const hooks = adapter.toSdkHooks()

    await hooks.PreToolUse[0]!({
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'MyTool',
        tool_input: {},
      },
    })

    const result = (await hooks.PostToolUse[0]!({
      input: {
        hook_event_name: 'PostToolUse',
        tool_name: 'MyTool',
        tool_result: 'the secret is here',
      },
    })) as { hookSpecificOutput?: { additionalContext?: string } }

    expect(result.hookSpecificOutput?.additionalContext).toContain('Contains secret data')
  })
})

// ---------------------------------------------------------------------------
// Postcondition output suppression
// ---------------------------------------------------------------------------

describe('postcondition output suppression', () => {
  it('post suppresses output on deny effect', async () => {
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
    const adapter = new ClaudeAgentSDKAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const postResult = await adapter._post('call-1', 'secret data')

    expect(postResult.outputSuppressed).toBe(true)
    expect(String(postResult.result)).toContain('[OUTPUT SUPPRESSED]')
  })
})

// ---------------------------------------------------------------------------
// Per-contract observe mode
// ---------------------------------------------------------------------------

describe('per-contract observe mode', () => {
  it('per-contract observe mode allows through with audit', async () => {
    const internalContract = {
      _edictum_type: 'precondition',
      _edictum_observe: false,
      type: 'precondition',
      name: 'observe_test',
      tool: '*',
      mode: 'observe',
      check: async () => Verdict.fail('would deny'),
    }
    const guard = makeGuard({
      contracts: [internalContract as unknown as Precondition],
    })
    const adapter = new ClaudeAgentSDKAdapter(guard)

    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBeNull()
  })
})
