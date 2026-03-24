/**
 * LangChainAdapter integration tests -- asMiddleware, asToolWrapper, security.
 *
 * Covers: asMiddleware wrapToolCall, asToolWrapper, deny propagation,
 * postcondition enforcement through wrapper paths.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AuditAction,
  Edictum,
  EdictumDenied,
  Verdict,
  type Precondition,
  type Postcondition,
  type ToolEnvelope,
} from '@edictum/core'

import { LangChainAdapter } from '../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGuard(options: ConstructorParameters<typeof Edictum>[0] = {}): Edictum {
  return new Edictum(options)
}

// ---------------------------------------------------------------------------
// asMiddleware
// ---------------------------------------------------------------------------

describe('asMiddleware', () => {
  it('returns correct structure with name and wrapToolCall', () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)
    const middleware = adapter.asMiddleware()

    expect(middleware.name).toBe('edictum')
    expect(typeof middleware.wrapToolCall).toBe('function')
  })

  it('wrapToolCall allows and executes tool on pass', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)
    const middleware = adapter.asMiddleware()

    const handler = vi.fn(async () => 'tool result')

    const result = await middleware.wrapToolCall(
      { toolCall: { name: 'MyTool', args: {}, id: 'c1' } },
      handler,
    )

    expect(handler).toHaveBeenCalledTimes(1)
    expect(result).toBe('tool result')
  })

  it('wrapToolCall throws EdictumDenied on deny', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('blocked'),
    }
    const guard = makeGuard({ contracts: [blockAll] })
    const adapter = new LangChainAdapter(guard)
    const middleware = adapter.asMiddleware()

    const handler = vi.fn(async () => 'tool result')

    await expect(
      middleware.wrapToolCall({ toolCall: { name: 'MyTool', args: {}, id: 'c1' } }, handler),
    ).rejects.toThrow(EdictumDenied)

    expect(handler).not.toHaveBeenCalled()
  })

  it('wrapToolCall fires onPostconditionWarn callback', async () => {
    const onWarn = vi.fn()
    const postContract: Postcondition = {
      tool: '*',
      contractType: 'post',
      check: async (_envelope: ToolEnvelope, output: unknown) => {
        if (String(output).includes('bad')) {
          return Verdict.fail('Bad output')
        }
        return Verdict.pass_()
      },
    }
    const guard = makeGuard({
      contracts: [postContract],
      tools: { MyTool: { side_effect: 'pure' } },
    })
    const adapter = new LangChainAdapter(guard)
    const middleware = adapter.asMiddleware({
      onPostconditionWarn: onWarn,
    })

    const handler = vi.fn(async () => 'bad data here')

    await middleware.wrapToolCall({ toolCall: { name: 'MyTool', args: {}, id: 'c1' } }, handler)

    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[1]?.length).toBeGreaterThan(0)
  })

  it('wrapToolCall in observe mode allows denied calls through', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('blocked'),
    }
    const guard = makeGuard({ mode: 'observe', contracts: [blockAll] })
    const adapter = new LangChainAdapter(guard)
    const middleware = adapter.asMiddleware()

    const handler = vi.fn(async () => 'tool result')

    const result = await middleware.wrapToolCall(
      { toolCall: { name: 'MyTool', args: {}, id: 'c1' } },
      handler,
    )

    expect(handler).toHaveBeenCalledTimes(1)
    expect(result).toBe('tool result')
  })

  it('wrapToolCall swallows onPostconditionWarn callback errors', async () => {
    const onWarn = vi.fn(() => {
      throw new Error('warn callback boom')
    })
    const postContract: Postcondition = {
      tool: '*',
      contractType: 'post',
      check: async () => Verdict.fail('bad output'),
    }
    const guard = makeGuard({
      contracts: [postContract],
      tools: { MyTool: { side_effect: 'pure' } },
    })
    const adapter = new LangChainAdapter(guard)
    const middleware = adapter.asMiddleware({
      onPostconditionWarn: onWarn,
    })

    const handler = vi.fn(async () => 'result')

    const result = await middleware.wrapToolCall(
      { toolCall: { name: 'MyTool', args: {}, id: 'c1' } },
      handler,
    )

    expect(result).toBeDefined()
    expect(onWarn).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// asToolWrapper
// ---------------------------------------------------------------------------

describe('asToolWrapper', () => {
  it('wraps a tool callable and returns result on allow', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)
    const wrapper = adapter.asToolWrapper()

    const toolFn = vi.fn(async (args: Record<string, unknown>) => {
      return `result for ${args['key']}`
    })

    const governed = wrapper(toolFn)
    const result = await governed('MyTool', { key: 'val' })

    expect(toolFn).toHaveBeenCalledTimes(1)
    expect(toolFn).toHaveBeenCalledWith({ key: 'val' })
    expect(result).toBe('result for val')
  })

  it('throws EdictumDenied when precondition denies', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('blocked by wrapper'),
    }
    const guard = makeGuard({ contracts: [blockAll] })
    const adapter = new LangChainAdapter(guard)
    const wrapper = adapter.asToolWrapper()

    const toolFn = vi.fn(async () => 'result')
    const governed = wrapper(toolFn)

    await expect(governed('MyTool', {})).rejects.toThrow(EdictumDenied)
    expect(toolFn).not.toHaveBeenCalled()
  })

  it('does not call tool when denied', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('no'),
    }
    const guard = makeGuard({ contracts: [blockAll] })
    const adapter = new LangChainAdapter(guard)
    const wrapper = adapter.asToolWrapper()

    const toolFn = vi.fn(async () => 'result')
    const governed = wrapper(toolFn)

    try {
      await governed('MyTool', {})
    } catch {
      // expected
    }
    expect(toolFn).not.toHaveBeenCalled()
  })

  it('fires onPostconditionWarn callback', async () => {
    const onWarn = vi.fn()
    const postContract: Postcondition = {
      tool: '*',
      contractType: 'post',
      check: async (_envelope: ToolEnvelope, output: unknown) => {
        if (String(output).includes('sensitive')) {
          return Verdict.fail('Sensitive data')
        }
        return Verdict.pass_()
      },
    }
    const guard = makeGuard({
      contracts: [postContract],
      tools: { MyTool: { side_effect: 'pure' } },
    })
    const adapter = new LangChainAdapter(guard)
    const wrapper = adapter.asToolWrapper({
      onPostconditionWarn: onWarn,
    })

    const toolFn = vi.fn(async () => 'sensitive info here')
    const governed = wrapper(toolFn)
    await governed('MyTool', {})

    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[1]?.length).toBeGreaterThan(0)
  })

  it('swallows onPostconditionWarn callback errors', async () => {
    const onWarn = vi.fn(() => {
      throw new Error('warn boom')
    })
    const postContract: Postcondition = {
      tool: '*',
      contractType: 'post',
      check: async () => Verdict.fail('bad'),
    }
    const guard = makeGuard({
      contracts: [postContract],
      tools: { MyTool: { side_effect: 'pure' } },
    })
    const adapter = new LangChainAdapter(guard)
    const wrapper = adapter.asToolWrapper({
      onPostconditionWarn: onWarn,
    })

    const toolFn = vi.fn(async () => 'result')
    const governed = wrapper(toolFn)

    await governed('MyTool', {})
    expect(onWarn).toHaveBeenCalledTimes(1)
  })

  it('allows through in observe mode', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('blocked'),
    }
    const guard = makeGuard({ mode: 'observe', contracts: [blockAll] })
    const adapter = new LangChainAdapter(guard)
    const wrapper = adapter.asToolWrapper()

    const toolFn = vi.fn(async () => 'observe result')
    const governed = wrapper(toolFn)

    const result = await governed('MyTool', {})
    expect(toolFn).toHaveBeenCalledTimes(1)
    expect(result).toBe('observe result')
  })

  it('generates callId when not provided', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)
    const wrapper = adapter.asToolWrapper()

    const toolFn = vi.fn(async () => 'result')
    const governed = wrapper(toolFn)

    await governed('MyTool', {})

    const events = guard.localSink.filter(AuditAction.CALL_ALLOWED)
    expect(events).toHaveLength(1)
    expect(events[0]!.toolName).toBe('MyTool')
  })

  it('uses provided callId', async () => {
    const guard = makeGuard()
    const adapter = new LangChainAdapter(guard)
    const wrapper = adapter.asToolWrapper()

    const toolFn = vi.fn(async () => 'result')
    const governed = wrapper(toolFn)

    await governed('MyTool', {}, 'explicit-call-id')

    const events = guard.localSink.filter(AuditAction.CALL_EXECUTED)
    expect(events).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Security: deny propagation end-to-end
// ---------------------------------------------------------------------------

describe('security', () => {
  it('deny propagates through asMiddleware wrapToolCall', async () => {
    const blockAll: Precondition = {
      tool: '*',
      check: async () => Verdict.fail('security deny'),
    }
    const guard = makeGuard({ contracts: [blockAll] })
    const adapter = new LangChainAdapter(guard)
    const middleware = adapter.asMiddleware()

    const handler = vi.fn(async () => 'should not reach')

    await expect(
      middleware.wrapToolCall(
        { toolCall: { name: 'Bash', args: { command: 'rm -rf /' }, id: 'c1' } },
        handler,
      ),
    ).rejects.toThrow(EdictumDenied)

    expect(handler).not.toHaveBeenCalled()

    const denied = guard.localSink.filter(AuditAction.CALL_DENIED)
    expect(denied).toHaveLength(1)
    expect(denied[0]!.reason).toBe('security deny')
  })

  it('deny propagates through asToolWrapper', async () => {
    const blockBash: Precondition = {
      tool: 'Bash',
      check: async (envelope) => {
        if (
          typeof envelope.args['command'] === 'string' &&
          envelope.args['command'].includes('rm')
        ) {
          return Verdict.fail('dangerous command')
        }
        return Verdict.pass_()
      },
    }
    const guard = makeGuard({ contracts: [blockBash] })
    const adapter = new LangChainAdapter(guard)
    const wrapper = adapter.asToolWrapper()

    const toolFn = vi.fn(async () => 'executed')
    const governed = wrapper(toolFn)

    await expect(governed('Bash', { command: 'rm -rf /' })).rejects.toThrow(EdictumDenied)

    expect(toolFn).not.toHaveBeenCalled()
  })

  it('postcondition deny effect suppresses output through asToolWrapper', async () => {
    const postContract = {
      _edictum_type: 'postcondition',
      type: 'postcondition',
      name: 'suppress_secrets',
      tool: '*',
      effect: 'deny',
      check: async (_env: ToolEnvelope, output: unknown) => {
        if (String(output).includes('secret')) {
          return Verdict.fail('contains secrets')
        }
        return Verdict.pass_()
      },
    }
    const guard = makeGuard({
      contracts: [postContract as unknown as Postcondition],
      tools: { MyTool: { side_effect: 'pure' } },
    })
    const adapter = new LangChainAdapter(guard)
    const wrapper = adapter.asToolWrapper()

    const toolFn = vi.fn(async () => 'secret data here')
    const governed = wrapper(toolFn)

    const result = await governed('MyTool', {})
    expect(String(result)).toContain('[OUTPUT SUPPRESSED]')
    expect(String(result)).not.toContain('secret data here')
  })
})
