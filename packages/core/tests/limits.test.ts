/** Tests for OperationLimits. */

import { describe, expect, test } from 'vitest'

import { DEFAULT_LIMITS } from '../src/index.js'
import type { OperationLimits } from '../src/index.js'

describe('TestOperationLimits', () => {
  test('defaults', () => {
    const limits = DEFAULT_LIMITS
    expect(limits.maxAttempts).toBe(500)
    expect(limits.maxToolCalls).toBe(200)
    expect(limits.maxCallsPerTool).toEqual({})
  })

  test('custom_values', () => {
    const limits: OperationLimits = {
      maxAttempts: 100,
      maxToolCalls: 50,
      maxCallsPerTool: { Bash: 10, Write: 5 },
    }
    expect(limits.maxAttempts).toBe(100)
    expect(limits.maxToolCalls).toBe(50)
    expect(limits.maxCallsPerTool).toEqual({ Bash: 10, Write: 5 })
  })

  test('per_tool_empty_by_default', () => {
    const limits = DEFAULT_LIMITS
    expect('Bash' in limits.maxCallsPerTool).toBe(false)
  })
})
