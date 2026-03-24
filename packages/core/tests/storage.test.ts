/** Tests for MemoryBackend — ported from test_storage.py. */

import { describe, test, expect } from 'vitest'
import { MemoryBackend } from '../src/index.js'

describe('TestMemoryBackend', () => {
  test('get missing key returns null', async () => {
    const backend = new MemoryBackend()
    const result = await backend.get('nonexistent')
    expect(result).toBeNull()
  })

  test('set and get', async () => {
    const backend = new MemoryBackend()
    await backend.set('key1', 'value1')
    const result = await backend.get('key1')
    expect(result).toBe('value1')
  })

  test('set overwrites', async () => {
    const backend = new MemoryBackend()
    await backend.set('key1', 'v1')
    await backend.set('key1', 'v2')
    expect(await backend.get('key1')).toBe('v2')
  })

  test('delete existing', async () => {
    const backend = new MemoryBackend()
    await backend.set('key1', 'value1')
    await backend.delete('key1')
    expect(await backend.get('key1')).toBeNull()
  })

  test('delete nonexistent does not throw', async () => {
    const backend = new MemoryBackend()
    await backend.delete('nonexistent') // should not throw
  })

  test('delete removes counter', async () => {
    const backend = new MemoryBackend()
    await backend.increment('counter1')
    await backend.delete('counter1')
    // After delete, counter should be gone — starts fresh
    const result = await backend.increment('counter1')
    expect(result).toBe(1)
  })

  test('increment new key', async () => {
    const backend = new MemoryBackend()
    const result = await backend.increment('counter1')
    expect(result).toBe(1)
  })

  test('increment existing', async () => {
    const backend = new MemoryBackend()
    await backend.increment('counter1')
    const result = await backend.increment('counter1')
    expect(result).toBe(2)
  })

  test('increment custom amount', async () => {
    const backend = new MemoryBackend()
    let result = await backend.increment('counter1', 5)
    expect(result).toBe(5)
    result = await backend.increment('counter1', 3)
    expect(result).toBe(8)
  })

  test('counters separate from data', async () => {
    const backend = new MemoryBackend()
    await backend.set('key1', 'value1')
    await backend.increment('key1', 10)
    // Data store still has the string
    expect(await backend.get('key1')).toBe('value1')
    // Counter store has the number
    expect((backend as any)._counters.get('key1')).toBe(10)
  })

  test('set does not accept ttl', () => {
    const backend = new MemoryBackend()
    // Verify the set method signature: only key and value, no ttl parameter.
    // In TypeScript, this is enforced at compile time by the interface.
    // At runtime, we verify set exists and has the expected arity (2 params).
    expect(typeof backend.set).toBe('function')
    expect(backend.set.length).toBe(2)
  })
})
