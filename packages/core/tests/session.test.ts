/** Tests for Session async counter operations — ported from test_session.py. */

import { describe, test, expect } from 'vitest'
import { EdictumConfigError, MemoryBackend, Session } from '../src/index.js'

describe('TestSession', () => {
  test('incrementAttempts', async () => {
    const session = new Session('test-sess', new MemoryBackend())
    let count = await session.incrementAttempts()
    expect(count).toBe(1)
    count = await session.incrementAttempts()
    expect(count).toBe(2)
  })

  test('attemptCount starts at zero', async () => {
    const session = new Session('test-sess', new MemoryBackend())
    const count = await session.attemptCount()
    expect(count).toBe(0)
  })

  test('attemptCount after increments', async () => {
    const session = new Session('test-sess', new MemoryBackend())
    await session.incrementAttempts()
    await session.incrementAttempts()
    const count = await session.attemptCount()
    expect(count).toBe(2)
  })

  test('recordExecution increments counts', async () => {
    const session = new Session('test-sess', new MemoryBackend())
    await session.recordExecution('Bash', true)
    expect(await session.executionCount()).toBe(1)
    expect(await session.toolExecutionCount('Bash')).toBe(1)
  })

  test('per-tool counts independent', async () => {
    const session = new Session('test-sess', new MemoryBackend())
    await session.recordExecution('Bash', true)
    await session.recordExecution('Read', true)
    await session.recordExecution('Bash', true)
    expect(await session.toolExecutionCount('Bash')).toBe(2)
    expect(await session.toolExecutionCount('Read')).toBe(1)
    expect(await session.executionCount()).toBe(3)
  })

  test('consecutiveFailures increments', async () => {
    const session = new Session('test-sess', new MemoryBackend())
    await session.recordExecution('Bash', false)
    expect(await session.consecutiveFailures()).toBe(1)
    await session.recordExecution('Bash', false)
    expect(await session.consecutiveFailures()).toBe(2)
  })

  test('consecutiveFailures resets on success', async () => {
    const session = new Session('test-sess', new MemoryBackend())
    await session.recordExecution('Bash', false)
    await session.recordExecution('Bash', false)
    expect(await session.consecutiveFailures()).toBe(2)
    await session.recordExecution('Bash', true)
    expect(await session.consecutiveFailures()).toBe(0)
  })

  test('consecutiveFailures reset then fail (regression)', async () => {
    // Regression: fail-fail-success-fail must return 1, not stale 0
    const session = new Session('test-sess', new MemoryBackend())
    await session.recordExecution('Bash', false)
    await session.recordExecution('Bash', false)
    expect(await session.consecutiveFailures()).toBe(2)
    await session.recordExecution('Bash', true)
    expect(await session.consecutiveFailures()).toBe(0)
    await session.recordExecution('Bash', false)
    expect(await session.consecutiveFailures()).toBe(1)
  })

  test('sessionId property', async () => {
    const session = new Session('test-sess', new MemoryBackend())
    expect(session.sessionId).toBe('test-sess')
  })

  test('key scheme validation', async () => {
    const backend = new MemoryBackend()
    const session = new Session('test-sess', backend)

    await session.incrementAttempts()
    // Verify the key exists in counters
    expect((backend as any)._counters.get('s:test-sess:attempts')).toBe(1)

    await session.recordExecution('Bash', true)
    expect((backend as any)._counters.get('s:test-sess:execs')).toBe(1)
    expect((backend as any)._counters.get('s:test-sess:tool:Bash')).toBe(1)
  })

  test('session values round-trip', async () => {
    const backend = new MemoryBackend()
    const session = new Session('test-sess', backend)

    await session.setValue('workflow:test:state', '{"activeStage":"read-context"}')
    expect(await session.getValue('workflow:test:state')).toBe('{"activeStage":"read-context"}')

    await session.deleteValue('workflow:test:state')
    expect(await session.getValue('workflow:test:state')).toBeNull()
  })
})

describe('security', () => {
  describe('SessionIdValidation', () => {
    test('empty session ID rejected', () => {
      expect(() => new Session('', new MemoryBackend())).toThrow(EdictumConfigError)
    })

    test('null byte in session ID rejected', () => {
      expect(() => new Session('sess\x00ion', new MemoryBackend())).toThrow(EdictumConfigError)
    })

    test('newline in session ID rejected', () => {
      expect(() => new Session('sess\nion', new MemoryBackend())).toThrow(EdictumConfigError)
    })

    test('control char in session ID rejected', () => {
      expect(() => new Session('sess\x01ion', new MemoryBackend())).toThrow(EdictumConfigError)
    })

    test('C1 control char NEL in session ID rejected', () => {
      expect(() => new Session('sess\u0085ion', new MemoryBackend())).toThrow(EdictumConfigError)
      expect(() => new Session('sess\u0085ion', new MemoryBackend())).toThrow(/Invalid session_id/)
    })

    test('C1 control char DCS in session ID rejected', () => {
      expect(() => new Session('sess\u0090ion', new MemoryBackend())).toThrow(EdictumConfigError)
      expect(() => new Session('sess\u0090ion', new MemoryBackend())).toThrow(/Invalid session_id/)
    })

    test('line separator U+2028 in session ID rejected', () => {
      expect(() => new Session('sess\u2028ion', new MemoryBackend())).toThrow(EdictumConfigError)
      expect(() => new Session('sess\u2028ion', new MemoryBackend())).toThrow(/Invalid session_id/)
    })

    test('paragraph separator U+2029 in session ID rejected', () => {
      expect(() => new Session('sess\u2029ion', new MemoryBackend())).toThrow(EdictumConfigError)
      expect(() => new Session('sess\u2029ion', new MemoryBackend())).toThrow(/Invalid session_id/)
    })

    test('colon in session ID rejected', () => {
      expect(() => new Session('victim:workflow:myworkflow', new MemoryBackend())).toThrow(
        /colon is not allowed/,
      )
    })

    test('valid session IDs accepted', () => {
      expect(() => new Session('test-session', new MemoryBackend())).not.toThrow()
      expect(() => new Session('user-abc-123', new MemoryBackend())).not.toThrow()
      expect(() => new Session('sess_v2', new MemoryBackend())).not.toThrow()
    })
  })

  describe('ToolNameValidationInSession', () => {
    test('null byte in tool name rejected in recordExecution', async () => {
      const session = new Session('test', new MemoryBackend())
      await expect(session.recordExecution('tool\x00name', true)).rejects.toThrow(
        EdictumConfigError,
      )
    })

    test('null byte in tool name rejected in toolExecutionCount', async () => {
      const session = new Session('test', new MemoryBackend())
      await expect(session.toolExecutionCount('tool\x00name')).rejects.toThrow(EdictumConfigError)
    })
  })
})
