/** Tests for HookDecision and HookResult. */

import { describe, expect, test } from 'vitest'

import { HookDecision, HookResult } from '../src/index.js'

describe('TestHookDecision', () => {
  test('allow', () => {
    const d = HookDecision.allow()
    expect(d.result).toBe(HookResult.ALLOW)
    expect(d.reason).toBeNull()
  })

  test('deny', () => {
    const d = HookDecision.deny('not allowed')
    expect(d.result).toBe(HookResult.DENY)
    expect(d.reason).toBe('not allowed')
  })

  test('deny_truncation', () => {
    const longReason = 'x'.repeat(600)
    const d = HookDecision.deny(longReason)
    expect(d.reason!.length).toBe(500)
    expect(d.reason!.endsWith('...')).toBe(true)
  })

  test('deny_exact_500', () => {
    const reason = 'x'.repeat(500)
    const d = HookDecision.deny(reason)
    expect(d.reason).toBe(reason)
    expect(d.reason!.length).toBe(500)
  })

  test('deny_501', () => {
    const reason = 'x'.repeat(501)
    const d = HookDecision.deny(reason)
    expect(d.reason!.length).toBe(500)
    expect(d.reason!.endsWith('...')).toBe(true)
  })
})

describe('TestHookResult', () => {
  test('values', () => {
    expect(HookResult.ALLOW).toBe('allow')
    expect(HookResult.DENY).toBe('deny')
  })
})
