import { describe, expect, test, vi } from 'vitest'

import { Edictum } from '../../src/guard.js'
import { AuditAction, StdoutAuditSink, createAuditEvent } from '../../src/audit.js'
import { MemoryBackend } from '../../src/storage.js'

describe('AuditLineageBehavior', () => {
  test('sessionId changes stdout payload', async () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })

    try {
      const sink = new StdoutAuditSink()
      await sink.emit(
        createAuditEvent({
          action: AuditAction.CALL_ALLOWED,
          toolName: 'Read',
          sessionId: 'session-123',
        }),
      )
    } finally {
      spy.mockRestore()
    }

    const payload = JSON.parse(writes[0] ?? '{}')
    expect(payload['sessionId']).toBe('session-123')
  })

  test('parentSessionId changes stdout payload', async () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })

    try {
      const sink = new StdoutAuditSink()
      await sink.emit(
        createAuditEvent({
          action: AuditAction.CALL_ALLOWED,
          toolName: 'Read',
          parentSessionId: 'parent-456',
        }),
      )
    } finally {
      spy.mockRestore()
    }

    const payload = JSON.parse(writes[0] ?? '{}')
    expect(payload['parentSessionId']).toBe('parent-456')
  })

  test('run emits audit events with sessionId', async () => {
    const guard = new Edictum({ backend: new MemoryBackend() })

    await guard.run('Read', { path: 'spec.md' }, async () => 'ok', { sessionId: 'session-789' })

    expect(guard.localSink.events.length).toBeGreaterThanOrEqual(2)
    expect(new Set(guard.localSink.events.map((event) => event.sessionId))).toEqual(
      new Set(['session-789']),
    )
  })
})
