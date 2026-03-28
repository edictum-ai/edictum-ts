/**
 * LangChainAdapter tests -- exercises _pre/_post directly (no framework imports).
 *
 * Covers: allow, deny, observe mode, callbacks, audit events,
 * tool success/failure, postcondition warnings, session counting,
 * setPrincipal, per-rule observe mode, output suppression.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AuditAction,
  CollectingAuditSink,
  Edictum,
  Decision,
  createPrincipal,
  type Precondition,
  type Postcondition,
  type ToolCall,
} from '@edictum/core'

import { LangChainAdapter } from '../src/index.js'

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

describe('LangChainAdapter', () => {
  it('allows with no rules', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new LangChainAdapter(guard)

    const result = await adapter._pre('MyTool', { a: 1 }, 'call-1')
    expect(result).toBeNull()

    const allowed = sink.filter(AuditAction.CALL_ALLOWED)
    expect(allowed.length).toBe(1)
    expect(allowed[0]?.toolName).toBe('MyTool')
  })

  it('denies when precondition fails', async () => {
    const noRm: Precondition = {
      tool: 'Bash',
      check: async (toolCall) => {
        if (
          typeof toolCall.args['command'] === 'string' &&
          toolCall.args['command'].includes('rm -rf')
        ) {
          return Decision.fail('Cannot run rm -rf')
        }
        return Decision.pass_()
      },
    }
    const guard = makeGuard({ rules: [noRm] })
    const adapter = new LangChainAdapter(guard)

    const result = await adapter._pre('Bash', { command: 'rm -rf /' }, 'call-1')
    expect(result).toBe('DENIED: Cannot run rm -rf')
  })

  it('allows when precondition passes', async () => {
    const noRm: Precondition = {
      tool: 'Bash',
      check: async (toolCall) => {
        if (
          typeof toolCall.args['command'] === 'string' &&
          toolCall.args['command'].includes('rm -rf')
        ) {
          return Decision.fail('Cannot run rm -rf')
        }
        return Decision.pass_()
      },
    }
    const guard = makeGuard({ rules: [noRm] })
    const adapter = new LangChainAdapter(guard)

    const result = await adapter._pre('Bash', { command: 'ls' }, 'call-1')
    expect(result).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Post-execution
  // -----------------------------------------------------------------------

  it('post returns result when no rules', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const postResult = await adapter._post('call-1', 'tool output')

    expect(postResult.result).toBe('tool output')
    expect(postResult.postconditionsPassed).toBe(true)
    expect(postResult.violations).toHaveLength(0)
  })

  it('post returns result for unknown call_id', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)

    const postResult = await adapter._post('nonexistent', 'tool output')
    expect(postResult.result).toBe('tool output')
    expect(postResult.postconditionsPassed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Observe mode
// ---------------------------------------------------------------------------

describe('observe mode', () => {
  it('converts deny to allow in observe mode', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Decision.fail('always deny'),
    }
    const guard = makeGuard({ mode: 'observe', rules: [blockAll] })
    const adapter = new LangChainAdapter(guard)

    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBeNull() // allowed through in observe mode
  })

  it('emits CALL_WOULD_DENY audit event in observe mode', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Decision.fail('always deny'),
    }
    const guard = makeGuard({ mode: 'observe', rules: [blockAll] })
    const adapter = new LangChainAdapter(guard)

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
    const onDeny = vi.fn()
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Decision.fail('blocked'),
    }
    const guard = makeGuard({ rules: [blockAll], onDeny })
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    expect(onDeny).toHaveBeenCalledTimes(1)
    expect(onDeny.mock.calls[0]![1]).toBe('blocked')
  })

  it('fires on_allow callback on allow', async () => {
    const onAllow = vi.fn()
    const guard = makeGuard({ onAllow })
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    expect(onAllow).toHaveBeenCalledTimes(1)
  })

  it('swallows on_deny callback errors', async () => {
    const onDeny = vi.fn(() => {
      throw new Error('callback boom')
    })
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Decision.fail('blocked'),
    }
    const guard = makeGuard({ rules: [blockAll], onDeny })
    const adapter = new LangChainAdapter(guard)

    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBe('DENIED: blocked')
    expect(onDeny).toHaveBeenCalledTimes(1)
  })

  it('swallows on_allow callback errors', async () => {
    const onAllow = vi.fn(() => {
      throw new Error('callback boom')
    })
    const guard = makeGuard({ onAllow })
    const adapter = new LangChainAdapter(guard)

    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBeNull()
    expect(onAllow).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

describe('audit events', () => {
  it('emits CALL_ALLOWED on pre allow', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_ALLOWED)
    expect(events).toHaveLength(1)
    expect(events[0]!.toolName).toBe('MyTool')
  })

  it('emits CALL_DENIED on pre deny', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Decision.fail('blocked'),
    }
    const guard = makeGuard({ rules: [blockAll] })
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_DENIED)
    expect(events).toHaveLength(1)
    expect(events[0]!.reason).toBe('blocked')
  })

  it('emits CALL_EXECUTED on successful post', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    await adapter._post('call-1', 'result')

    const events = guard.localSink.filter(AuditAction.CALL_EXECUTED)
    expect(events).toHaveLength(1)
  })

  it('emits CALL_FAILED for error response', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    await adapter._post('call-1', 'error: something failed')

    const events = guard.localSink.filter(AuditAction.CALL_FAILED)
    expect(events).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Tool success/failure detection
// ---------------------------------------------------------------------------

describe('tool success detection', () => {
  it('treats null response as success', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const result = await adapter._post('call-1', null)

    expect(result.postconditionsPassed).toBe(true)
    const events = sink.filter(AuditAction.CALL_EXECUTED)
    expect(events.length).toBe(1)
  })

  it('treats { is_error: true } as failure', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new LangChainAdapter(guard)

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
    const adapter = new LangChainAdapter(guard)

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
      check: async (_envelope: ToolCall, output: unknown) => {
        if (String(output).includes('secret')) {
          return Decision.fail('Contains secret data')
        }
        return Decision.pass_()
      },
    }
    const guard = makeGuard({ rules: [postContract] })
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const result = await adapter._post('call-1', 'the secret is 42')

    expect(result.postconditionsPassed).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations[0]?.message).toBe('Contains secret data')
  })

  it('returns postconditionsPassed=true when postcondition passes', async () => {
    const postContract: Postcondition = {
      tool: '*',
      contractType: 'post',
      check: async () => Decision.pass_(),
    }
    const guard = makeGuard({ rules: [postContract] })
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const result = await adapter._post('call-1', 'safe output')

    expect(result.postconditionsPassed).toBe(true)
    expect(result.violations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Session counting
// ---------------------------------------------------------------------------

describe('session counting', () => {
  it('increments session attempt count', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('ToolA', {}, 'c1')
    await adapter._pre('ToolB', {}, 'c2')

    const events = guard.localSink.filter(AuditAction.CALL_ALLOWED)
    expect(events).toHaveLength(2)
    expect(events[0]!.sessionAttemptCount).toBe(1)
    expect(events[1]!.sessionAttemptCount).toBe(2)
  })

  it('tracks session execution count after post', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('ToolA', {}, 'c1')
    await adapter._post('c1', 'ok')

    await adapter._pre('ToolB', {}, 'c2')
    await adapter._post('c2', 'ok')

    const execEvents = guard.localSink.filter(AuditAction.CALL_EXECUTED)
    expect(execEvents).toHaveLength(2)
    expect(execEvents[0]!.sessionExecutionCount).toBe(1)
    expect(execEvents[1]!.sessionExecutionCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// setPrincipal
// ---------------------------------------------------------------------------

describe('setPrincipal', () => {
  it('uses static principal', async () => {
    const principal = createPrincipal({ userId: 'user-1', role: 'admin' })
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard, { principal })

    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_ALLOWED)
    expect(events[0]!.principal).toBeTruthy()
    expect((events[0]!.principal as Record<string, unknown>)['userId']).toBe('user-1')
  })

  it('updates principal for subsequent calls', async () => {
    const sink = makeSink()
    const guard = makeGuard({ auditSink: sink })
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const firstEvent = sink.filter(AuditAction.CALL_ALLOWED)[0]
    expect(firstEvent?.principal).toBeNull()

    adapter.setPrincipal(createPrincipal({ userId: 'updated' }))

    await adapter._pre('MyTool', {}, 'call-2')
    const secondEvent = sink.filter(AuditAction.CALL_ALLOWED)[1]
    expect((secondEvent?.principal as Record<string, unknown>)?.['userId']).toBe('updated')
  })
})

// ---------------------------------------------------------------------------
// Principal resolver
// ---------------------------------------------------------------------------

describe('principalResolver', () => {
  it('resolver overrides static principal', async () => {
    const principal = createPrincipal({ userId: 'static' })
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard, {
      principal,
      principalResolver: () => createPrincipal({ userId: 'resolved' }),
    })

    await adapter._pre('MyTool', {}, 'call-1')

    const events = guard.localSink.filter(AuditAction.CALL_ALLOWED)
    expect((events[0]!.principal as Record<string, unknown>)['userId']).toBe('resolved')
  })
})

// ---------------------------------------------------------------------------
// sessionId
// ---------------------------------------------------------------------------

describe('sessionId', () => {
  it('uses provided sessionId', () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard, {
      sessionId: 'my-session',
    })
    expect(adapter.sessionId).toBe('my-session')
  })

  it('generates sessionId when not provided', () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)
    expect(adapter.sessionId).toBeTruthy()
    expect(adapter.sessionId.length).toBeGreaterThan(0)
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
      check: async () => Decision.fail('sensitive data detected'),
    }
    const guard = makeGuard({
      rules: [postContract as unknown as Postcondition],
      tools: { MyTool: { side_effect: 'pure' } },
    })
    const adapter = new LangChainAdapter(guard)

    await adapter._pre('MyTool', {}, 'call-1')
    const postResult = await adapter._post('call-1', 'secret data')

    expect(postResult.outputSuppressed).toBe(true)
    expect(String(postResult.result)).toContain('[OUTPUT SUPPRESSED]')
  })
})

// ---------------------------------------------------------------------------
// Per-rule observe mode
// ---------------------------------------------------------------------------

describe('per-rule observe mode', () => {
  it('per-rule observe mode allows through with audit', async () => {
    const internalContract = {
      _edictum_type: 'precondition',
      _edictum_observe: false,
      type: 'precondition',
      name: 'observe_test',
      tool: '*',
      mode: 'observe',
      check: async () => Decision.fail('would deny'),
    }
    const guard = makeGuard({
      rules: [internalContract as unknown as Precondition],
    })
    const adapter = new LangChainAdapter(guard)

    const result = await adapter._pre('MyTool', {}, 'call-1')
    expect(result).toBeNull()
  })
})
