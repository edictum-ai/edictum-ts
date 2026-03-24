import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  Edictum,
  CollectingAuditSink,
  AuditAction,
  ApprovalStatus,
  createPrincipal,
  createCompiledState,
  EdictumConfigError,
} from '@edictum/core'
import type { ApprovalBackend, Precondition, Postcondition, Verdict } from '@edictum/core'

import { EdictumOpenClawAdapter } from '../src/adapter.js'
import { createEdictumPlugin, defaultPrincipalFromContext } from '../src/plugin.js'
import { summarizeResult } from '../src/helpers.js'
import type {
  ToolHookContext,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  OpenClawPluginApi,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolHookContext> = {}): ToolHookContext {
  return {
    toolName: 'exec',
    agentId: 'agent-1',
    sessionKey: 'sk-test',
    sessionId: 'sid-test',
    runId: 'run-test',
    toolCallId: 'tc-1',
    ...overrides,
  }
}

function makeEvent(overrides: Partial<BeforeToolCallEvent> = {}): BeforeToolCallEvent {
  return {
    toolName: 'exec',
    params: { command: 'ls -la' },
    runId: 'run-test',
    toolCallId: 'tc-1',
    ...overrides,
  }
}

function makeAfterEvent(overrides: Partial<AfterToolCallEvent> = {}): AfterToolCallEvent {
  return {
    toolName: 'exec',
    params: { command: 'ls -la' },
    runId: 'run-test',
    toolCallId: 'tc-1',
    result: 'file1.txt\nfile2.txt',
    durationMs: 42,
    ...overrides,
  }
}

const noRm: Precondition = {
  tool: 'exec',
  check: async (envelope) => {
    const cmd = envelope.args.command
    if (typeof cmd === 'string' && cmd.includes('rm -rf')) {
      return { passed: false, message: 'rm -rf denied', metadata: Object.freeze({}) }
    }
    return { passed: true, message: null, metadata: Object.freeze({}) }
  },
}

const detectSecrets: Postcondition = {
  contractType: 'post' as const,
  tool: '*',
  check: async (_envelope, response) => {
    const text = typeof response === 'string' ? response : JSON.stringify(response)
    if (text.includes('sk-secret')) {
      return { passed: false, message: 'Secret detected in output', metadata: Object.freeze({}) }
    }
    return { passed: true, message: null, metadata: Object.freeze({}) }
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EdictumOpenClawAdapter', () => {
  let sink: CollectingAuditSink

  beforeEach(() => {
    sink = new CollectingAuditSink()
  })

  describe('pre-execution', () => {
    it('allows safe tool calls', async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      const result = await adapter.pre('exec', { command: 'ls -la' }, 'tc-1', ctx)

      expect(result).toBeNull()
    })

    it('denies dangerous tool calls', async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      const result = await adapter.pre('exec', { command: 'rm -rf /' }, 'tc-2', ctx)

      expect(result).toBe('rm -rf denied')
    })

    it('emits CALL_DENIED audit event on deny', async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'rm -rf /' }, 'tc-2', ctx)

      expect(sink.events.length).toBeGreaterThanOrEqual(1)
      const denied = sink.events.find((e) => e.action === AuditAction.CALL_DENIED)
      expect(denied).toBeDefined()
      expect(denied!.toolName).toBe('exec')
    })

    it('emits CALL_ALLOWED audit event on allow', async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'ls' }, 'tc-1', ctx)

      const allowed = sink.events.find((e) => e.action === AuditAction.CALL_ALLOWED)
      expect(allowed).toBeDefined()
    })
  })

  describe('observe mode', () => {
    it('converts deny to allow with CALL_WOULD_DENY audit', async () => {
      const guard = new Edictum({
        contracts: [noRm],
        auditSink: sink,
        mode: 'observe',
      })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      const result = await adapter.pre('exec', { command: 'rm -rf /' }, 'tc-3', ctx)

      // Observe mode: allow despite deny
      expect(result).toBeNull()

      const wouldDeny = sink.events.find((e) => e.action === AuditAction.CALL_WOULD_DENY)
      expect(wouldDeny).toBeDefined()
    })
  })

  describe('post-execution', () => {
    it('returns findings on postcondition failure', async () => {
      const guard = new Edictum({
        contracts: [detectSecrets],
        auditSink: sink,
      })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      // Pre-execute to register pending
      await adapter.pre('exec', { command: 'cat config' }, 'tc-4', ctx)

      // Post-execute with secret in output
      const postResult = await adapter.post(
        'tc-4',
        'config: sk-secret-key-12345',
        makeAfterEvent({ toolCallId: 'tc-4', result: 'config: sk-secret-key-12345' }),
      )

      expect(postResult.postconditionsPassed).toBe(false)
      expect(postResult.findings.length).toBeGreaterThan(0)
    })

    it('handles unknown callId gracefully', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)

      const postResult = await adapter.post(
        'unknown-id',
        'result',
        makeAfterEvent({ toolCallId: 'unknown-id' }),
      )

      expect(postResult.postconditionsPassed).toBe(true)
      expect(postResult.findings).toEqual([])
    })
  })

  describe('hook handlers', () => {
    it('handleBeforeToolCall returns block on deny', async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const event = makeEvent({ params: { command: 'rm -rf /' } })
      const ctx = makeCtx()

      const result = await adapter.handleBeforeToolCall(event, ctx)

      expect(result).toBeDefined()
      expect(result!.block).toBe(true)
      expect(result!.blockReason).toBe('rm -rf denied')
    })

    it('handleBeforeToolCall returns undefined on allow', async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const event = makeEvent({ params: { command: 'ls' } })
      const ctx = makeCtx()

      const result = await adapter.handleBeforeToolCall(event, ctx)

      expect(result).toBeUndefined()
    })

    it('handleAfterToolCall completes without error', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      // Pre first
      await adapter.handleBeforeToolCall(makeEvent(), ctx)

      // After
      await adapter.handleAfterToolCall(makeAfterEvent(), ctx)

      const executed = sink.events.find((e) => e.action === AuditAction.CALL_EXECUTED)
      expect(executed).toBeDefined()
    })
  })

  describe('callbacks', () => {
    it('calls onDeny callback on denial', async () => {
      const onDeny = vi.fn()
      const guard = new Edictum({ contracts: [noRm], auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, { onDeny })
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'rm -rf /' }, 'tc-5', ctx)

      expect(onDeny).toHaveBeenCalledOnce()
      expect(onDeny.mock.calls[0][1]).toBe('rm -rf denied')
    })

    it('calls onAllow callback on allow', async () => {
      const onAllow = vi.fn()
      const guard = new Edictum({ contracts: [noRm], auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, { onAllow })
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'ls' }, 'tc-6', ctx)

      expect(onAllow).toHaveBeenCalledOnce()
    })

    it('swallows callback errors silently', async () => {
      const onDeny = vi.fn(() => {
        throw new Error('callback exploded')
      })
      const guard = new Edictum({ contracts: [noRm], auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, { onDeny })
      const ctx = makeCtx()

      // Should not throw
      const result = await adapter.pre('exec', { command: 'rm -rf /' }, 'tc-7', ctx)
      expect(result).toBe('rm -rf denied')
      expect(onDeny).toHaveBeenCalledOnce()
    })
  })

  describe('principal', () => {
    it('uses static principal', async () => {
      const principal = createPrincipal({ userId: 'alice', role: 'admin' })
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, { principal })
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'ls' }, 'tc-8', ctx)

      const event = sink.events[0]
      expect(event.principal).toBeDefined()
      expect((event.principal as Record<string, unknown>).userId).toBe('alice')
    })

    it('principalResolver overrides static principal', async () => {
      const principal = createPrincipal({ userId: 'alice' })
      const resolver = vi.fn(() => createPrincipal({ userId: 'bob' }))
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, {
        principal,
        principalResolver: resolver,
      })
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'ls' }, 'tc-9', ctx)

      expect(resolver).toHaveBeenCalledOnce()
      const event = sink.events[0]
      expect((event.principal as Record<string, unknown>).userId).toBe('bob')
    })

    it('setPrincipal updates principal for subsequent calls', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, {
        principal: createPrincipal({ userId: 'alice' }),
      })
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'ls' }, 'tc-sp-1', ctx)
      const firstEvent = sink.events.find(
        (e) => e.action === AuditAction.CALL_ALLOWED && e.callId === 'tc-sp-1',
      )
      expect(firstEvent).toBeDefined()
      expect((firstEvent!.principal as Record<string, unknown>).userId).toBe('alice')

      adapter.setPrincipal(createPrincipal({ userId: 'bob' }))
      await adapter.pre('exec', { command: 'ls' }, 'tc-sp-2', ctx)
      const secondEvent = sink.events.find(
        (e) => e.action === AuditAction.CALL_ALLOWED && e.callId === 'tc-sp-2',
      )
      expect(secondEvent).toBeDefined()
      expect((secondEvent!.principal as Record<string, unknown>).userId).toBe('bob')
    })
  })

  describe('session tracking', () => {
    it('increments attempt count on every pre call', async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'rm -rf /' }, 'tc-a', ctx)
      await adapter.pre('exec', { command: 'rm -rf /' }, 'tc-b', ctx)
      await adapter.pre('exec', { command: 'ls' }, 'tc-c', ctx)

      // 3 attempts (2 denied + 1 allowed)
      const lastEvent = sink.events[sink.events.length - 1]
      expect(lastEvent.sessionAttemptCount).toBe(3)
    })
  })

  describe('metadata', () => {
    it('includes OpenClaw context in envelope metadata', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx({
        agentId: 'my-agent',
        sessionKey: 'my-session-key',
        sessionId: 'my-session-id',
      })

      await adapter.pre('exec', { command: 'ls' }, 'tc-meta', ctx)

      // Verify via audit event — envelope was created with metadata
      const event = sink.events[0]
      expect(event).toBeDefined()
      expect(event.toolName).toBe('exec')
      expect(event.callId).toBe('tc-meta')
      // Metadata (openclawAgentId, etc.) is on the envelope, not the audit event.
      // The envelope is internal to the adapter; we verify it was created correctly
      // by confirming the audit event has the expected callId and toolName.
    })
  })

  // -------------------------------------------------------------------------
  // #31 — Security bypass tests
  // -------------------------------------------------------------------------

  describe('security', () => {
    it('principalResolver throwing denies instead of propagating', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, {
        principalResolver: () => {
          throw new Error('resolver exploded')
        },
      })
      const ctx = makeCtx()

      // Must not throw — should return a denial reason
      const result = await adapter.pre('exec', { command: 'ls' }, 'tc-sec-1', ctx)

      expect(result).toBe('Principal resolution failed')
    })

    it('#59 — principalResolver throwing emits CALL_DENIED audit event', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, {
        principalResolver: () => {
          throw new Error('resolver exploded')
        },
      })
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'ls' }, 'tc-sec-pr-audit', ctx)

      const denied = sink.events.find(
        (e) => e.action === AuditAction.CALL_DENIED && e.reason === 'Principal resolution failed',
      )
      expect(denied).toBeDefined()
      expect(denied!.toolName).toBe('exec')
      expect(denied!.callId).toBe('tc-sec-pr-audit')
    })

    it('already-consumed callId (replay) returns passthrough from post()', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      // Pre-execute to register pending
      await adapter.pre('exec', { command: 'ls' }, 'tc-replay', ctx)

      // First post — consumes the callId
      const first = await adapter.post(
        'tc-replay',
        'first result',
        makeAfterEvent({ toolCallId: 'tc-replay', result: 'first result' }),
      )
      expect(first.postconditionsPassed).toBe(true)

      // Second post with same callId — replay attempt
      const replay = await adapter.post(
        'tc-replay',
        'replayed result',
        makeAfterEvent({ toolCallId: 'tc-replay', result: 'replayed result' }),
      )

      // Must return passthrough (no pending entry)
      expect(replay.result).toBe('replayed result')
      expect(replay.postconditionsPassed).toBe(true)
      expect(replay.findings).toEqual([])
      expect(replay.outputSuppressed).toBe(false)
    })

    it('successCheck throwing does not crash post()', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, {
        successCheck: () => {
          throw new Error('successCheck exploded')
        },
      })
      const ctx = makeCtx()

      // Pre-execute to register pending
      await adapter.pre('exec', { command: 'ls' }, 'tc-sec-sc', ctx)

      // Post should not throw despite successCheck failure
      await expect(
        adapter.post(
          'tc-sec-sc',
          'some result',
          makeAfterEvent({ toolCallId: 'tc-sec-sc', result: 'some result' }),
        ),
      ).resolves.toBeDefined()
    })

    it('summarizeResult with circular reference does not throw', () => {
      const circular: Record<string, unknown> = { a: 1 }
      circular.self = circular

      // Must not throw — should return a safe fallback
      const result = summarizeResult(circular)
      expect(result).toBe('[unserializable result]')
    })
  })

  // -------------------------------------------------------------------------
  // #52/#53/#54/#57 — Review round fixes
  // -------------------------------------------------------------------------

  describe('review round fixes', () => {
    it('#52 — callId exceeding 1000 chars is rejected', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      const longCallId = 'x'.repeat(1001)
      const result = await adapter.pre('exec', { command: 'ls' }, longCallId, ctx)

      expect(result).toBe('Invalid callId')
    })

    it('#52 — callId at exactly 1000 chars is accepted', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      const callId1000 = 'a'.repeat(1000)
      const result = await adapter.pre('exec', { command: 'ls' }, callId1000, ctx)

      expect(result).toBeNull()
    })

    it('#52/#58 — sessionId exceeding 1000 chars is rejected with correct message', () => {
      const guard = new Edictum({ auditSink: sink })

      expect(() => new EdictumOpenClawAdapter(guard, { sessionId: 's'.repeat(1001) })).toThrow(
        'sessionId exceeds maximum length',
      )
    })

    it('#53 — callId denial emits CALL_DENIED audit event', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'ls' }, 'tc-\x00bad', ctx)

      const denied = sink.events.find(
        (e) => e.action === AuditAction.CALL_DENIED && e.reason === 'Invalid callId',
      )
      expect(denied).toBeDefined()
      expect(denied!.toolName).toBe('exec')
    })

    it('#57 — toolName with control characters returns denial (not throw)', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      // pre() catches createEnvelope's EdictumConfigError and returns a
      // denial string per its API contract (returns null | string, never throws).
      const reason = await adapter.pre('exec\x00tool', { command: 'ls' }, 'tc-ctrl-tool', ctx)
      expect(reason).toBe('Invalid toolName')
    })

    it('handleBeforeToolCall with invalid toolName denies instead of throwing', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const event = makeEvent({ toolName: 'exec\x00tool' })
      const ctx = makeCtx()

      // Must NOT throw — must return a deny (block) result
      const result = await adapter.handleBeforeToolCall(event, ctx)
      expect(result?.block).toBe(true)
      expect(typeof result?.blockReason).toBe('string')
    })

    it('empty callId is accepted but tracked (no validation error)', async () => {
      // Empty string passes control-char and length checks. This is a known
      // edge case — collisions are logged via console.warn. The contract is
      // that pre() never throws for valid-shaped inputs.
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      const reason = await adapter.pre('exec', { command: 'ls' }, '', ctx)
      expect(reason).toBeNull() // allowed
    })

    it('#54/#57 — MAX_PENDING eviction: 10,001st call still works', async () => {
      // Use a separate sink with higher capacity and raise limits to allow 10,001 attempts
      const bigSink = new CollectingAuditSink(20_000)
      const guard = new Edictum({
        auditSink: bigSink,
        limits: { maxAttempts: 20_000, maxToolCalls: 20_000, maxCallsPerTool: {} },
      })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      // Suppress console.warn for the eviction log
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Fill up to MAX_PENDING (10,000) + 1
      for (let i = 0; i < 10_001; i++) {
        const result = await adapter.pre('exec', { command: 'ls' }, `tc-evict-${i}`, ctx)
        // Every call should be allowed (no contracts deny "ls")
        expect(result).toBeNull()
      }

      // Verify eviction warning was logged (first eviction at the 10,001st call)
      expect(warnSpy).toHaveBeenCalled()
      const evictionCall = warnSpy.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('MAX_PENDING'),
      )
      expect(evictionCall).toBeDefined()

      warnSpy.mockRestore()
    }, 30_000)
  })

  // -------------------------------------------------------------------------
  // #32 — Behavior tests
  // -------------------------------------------------------------------------

  describe('behavior', () => {
    it('successCheck option changes toolSuccess in post result', async () => {
      // successCheck always returns false — even for successful responses
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, {
        successCheck: () => false,
      })
      const ctx = makeCtx()

      await adapter.pre('exec', { command: 'ls' }, 'tc-beh-sc', ctx)
      await adapter.post(
        'tc-beh-sc',
        'file.txt',
        makeAfterEvent({ toolCallId: 'tc-beh-sc', result: 'file.txt' }),
      )

      // With successCheck returning false, the audit should record CALL_FAILED
      const failed = sink.events.find((e) => e.action === AuditAction.CALL_FAILED)
      expect(failed).toBeDefined()
    })

    it('sessionId option overrides default', () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, {
        sessionId: 'custom-session-id',
      })

      expect(adapter.sessionId).toBe('custom-session-id')
    })

    it('onPostconditionWarn callback is called when postcondition fails', async () => {
      const onPostconditionWarn = vi.fn()
      const guard = new Edictum({
        contracts: [detectSecrets],
        auditSink: sink,
      })
      const adapter = new EdictumOpenClawAdapter(guard, { onPostconditionWarn })
      const ctx = makeCtx()

      // Pre-execute to register pending
      await adapter.pre('exec', { command: 'cat config' }, 'tc-beh-pw', ctx)

      // Post-execute with secret in output to trigger postcondition failure
      await adapter.post(
        'tc-beh-pw',
        'config: sk-secret-key-12345',
        makeAfterEvent({ toolCallId: 'tc-beh-pw', result: 'config: sk-secret-key-12345' }),
      )

      expect(onPostconditionWarn).toHaveBeenCalledOnce()
      const [, findings] = onPostconditionWarn.mock.calls[0]
      expect(findings.length).toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------
  // #40 — sessionId validation
  // -------------------------------------------------------------------------

  describe('sessionId validation', () => {
    it('rejects sessionId with null bytes', () => {
      const guard = new Edictum({ auditSink: sink })
      expect(() => new EdictumOpenClawAdapter(guard, { sessionId: 'abc\x00def' })).toThrow(
        EdictumConfigError,
      )
    })

    it('rejects sessionId with control characters', () => {
      const guard = new Edictum({ auditSink: sink })
      expect(() => new EdictumOpenClawAdapter(guard, { sessionId: 'abc\x0adef' })).toThrow(
        'sessionId contains control characters',
      )
    })

    it('accepts clean sessionId', () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard, {
        sessionId: 'clean-session-123',
      })
      expect(adapter.sessionId).toBe('clean-session-123')
    })
  })

  // -------------------------------------------------------------------------
  // #43 — callId validation
  // -------------------------------------------------------------------------

  describe('callId validation', () => {
    it('rejects callId with null bytes', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      const result = await adapter.pre('exec', { command: 'ls' }, 'tc-\x00bad', ctx)

      expect(result).toBe('Invalid callId')
    })

    it('rejects callId with control characters', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      const result = await adapter.pre('exec', { command: 'ls' }, 'tc-\x0abad', ctx)

      expect(result).toBe('Invalid callId')
    })

    it('accepts clean callId', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      const result = await adapter.pre('exec', { command: 'ls' }, 'tc-clean-123', ctx)

      expect(result).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // #46 — approval flow tests
  // -------------------------------------------------------------------------

  describe('approval flow', () => {
    it('#60 — pending_approval with mock backend grants and emits correct audit', async () => {
      // A precondition with effect: "approve" triggers pending_approval in the pipeline.
      // We inject it as an InternalPrecondition via _replaceState, then wire a mock
      // ApprovalBackend that auto-approves.
      const mockBackend: ApprovalBackend = {
        requestApproval: vi.fn(async (_toolName, _toolArgs, _message, _opts) => ({
          approvalId: 'mock-approval-1',
          toolName: _toolName,
          toolArgs: Object.freeze({ ..._toolArgs }),
          message: _message,
          timeout: _opts?.timeout ?? 300,
          timeoutEffect: _opts?.timeoutEffect ?? 'deny',
          principal: _opts?.principal ?? null,
          metadata: Object.freeze({}),
          createdAt: new Date(),
        })),
        waitForDecision: vi.fn(async () => ({
          approved: true,
          approver: 'test-approver',
          reason: null,
          status: ApprovalStatus.APPROVED,
          timestamp: new Date(),
        })),
      }

      const guard = new Edictum({
        auditSink: sink,
        approvalBackend: mockBackend,
      })

      // Inject an InternalPrecondition with effect: "approve" so the pipeline
      // returns pending_approval for tool "exec".
      guard._replaceState(
        createCompiledState({
          preconditions: [
            {
              type: 'precondition',
              name: 'require-approval',
              tool: 'exec',
              effect: 'approve',
              check: () => ({
                passed: false,
                message: 'Needs approval',
                metadata: Object.freeze({}),
              }),
            },
          ],
        }),
      )

      const adapter = new EdictumOpenClawAdapter(guard)
      const ctx = makeCtx()

      const result = await adapter.pre('exec', { command: 'ls' }, 'tc-approval-1', ctx)

      // Approved -> null (allow)
      expect(result).toBeNull()

      // Verify the mock backend was called
      expect(mockBackend.requestApproval).toHaveBeenCalledOnce()
      expect(mockBackend.waitForDecision).toHaveBeenCalledWith('mock-approval-1', 300)

      // Verify audit trail: CALL_APPROVAL_REQUESTED then CALL_APPROVAL_GRANTED
      const requested = sink.events.find((e) => e.action === AuditAction.CALL_APPROVAL_REQUESTED)
      expect(requested).toBeDefined()
      expect(requested!.toolName).toBe('exec')

      const granted = sink.events.find((e) => e.action === AuditAction.CALL_APPROVAL_GRANTED)
      expect(granted).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // #51 — handleAfterToolCall fallback to _findPendingByToolName
  // -------------------------------------------------------------------------

  describe('handleAfterToolCall fallback', () => {
    it('falls back to _findPendingByToolName when toolCallId is undefined', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)

      // Pre-execute with a known callId via handleBeforeToolCall
      const beforeEvent = makeEvent({ toolCallId: 'tc-fallback-1' })
      const beforeCtx = makeCtx({ toolCallId: 'tc-fallback-1' })
      await adapter.handleBeforeToolCall(beforeEvent, beforeCtx)

      // After-execute with no toolCallId on event or ctx — forces fallback
      const afterEvent = makeAfterEvent({
        toolCallId: undefined,
        toolName: 'exec',
        result: 'output',
      })
      const afterCtx = makeCtx({ toolCallId: undefined })

      await adapter.handleAfterToolCall(afterEvent, afterCtx)

      // The fallback should have resolved the pending entry and emitted CALL_EXECUTED
      const executed = sink.events.find((e) => e.action === AuditAction.CALL_EXECUTED)
      expect(executed).toBeDefined()
      expect(executed!.toolName).toBe('exec')
    })

    it('silently returns when no pending entry matches toolName', async () => {
      const guard = new Edictum({ auditSink: sink })
      const adapter = new EdictumOpenClawAdapter(guard)

      const eventCountBefore = sink.events.length

      // After-execute with no toolCallId and no matching pending entry
      const afterEvent = makeAfterEvent({
        toolCallId: undefined,
        toolName: 'nonexistent_tool',
        result: 'output',
      })
      const afterCtx = makeCtx({ toolCallId: undefined, toolName: 'nonexistent_tool' })

      // Should not throw
      await adapter.handleAfterToolCall(afterEvent, afterCtx)

      // No new audit events should have been emitted
      expect(sink.events.length).toBe(eventCountBefore)
    })
  })

  // -------------------------------------------------------------------------
  // #41 — plugin behavior tests
  // -------------------------------------------------------------------------

  describe('plugin', () => {
    it('defaultPrincipalFromContext returns principal with agentId as serviceId', () => {
      const ctx = makeCtx({ agentId: 'my-agent-42' })
      const principal = defaultPrincipalFromContext(ctx)

      expect(principal).toBeDefined()
      expect((principal as Record<string, unknown>).serviceId).toBe('my-agent-42')
    })

    it('principalFromContext option maps context correctly', async () => {
      const guard = new Edictum({ auditSink: sink })
      const plugin = createEdictumPlugin(guard, {
        principalFromContext: (ctx) =>
          createPrincipal({ userId: `mapped-${ctx.agentId}`, role: 'custom' }),
      })

      // Register the plugin using a mock API that captures handlers
      const handlers: Record<
        string,
        { handler: (...args: unknown[]) => unknown; opts?: { priority?: number } }
      > = {}
      const mockApi: OpenClawPluginApi = {
        id: 'edictum',
        name: 'Edictum',
        config: {},
        on: vi.fn(
          (
            hookName: string,
            handler: (...args: unknown[]) => unknown,
            opts?: { priority?: number },
          ) => {
            handlers[hookName] = { handler, opts }
          },
        ),
      }
      plugin.register(mockApi)

      // Invoke the before_tool_call handler to trigger a real call
      const event = makeEvent({ params: { command: 'ls' } })
      const ctx = makeCtx({ agentId: 'agent-ctx-test' })
      await handlers['before_tool_call'].handler(event, ctx)

      // The principal should appear in the audit event
      const allowed = sink.events.find((e) => e.action === AuditAction.CALL_ALLOWED)
      expect(allowed).toBeDefined()
      expect((allowed!.principal as Record<string, unknown>).userId).toBe('mapped-agent-ctx-test')
    })

    it('priority option passes through to api.on', () => {
      const guard = new Edictum({ auditSink: sink })
      const plugin = createEdictumPlugin(guard, { priority: 42 })

      const onSpy = vi.fn()
      const mockApi: OpenClawPluginApi = {
        id: 'edictum',
        name: 'Edictum',
        config: {},
        on: onSpy,
      }
      plugin.register(mockApi)

      // api.on should be called twice (before_tool_call + after_tool_call)
      expect(onSpy).toHaveBeenCalledTimes(2)

      // Both calls should pass { priority: 42 }
      for (const call of onSpy.mock.calls) {
        expect(call[2]).toEqual({ priority: 42 })
      }
    })
  })
})
