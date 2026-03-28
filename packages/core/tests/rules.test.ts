/** Tests for Decision and rule interfaces. */

import { describe, expect, test } from 'vitest'

import { Decision } from '../src/index.js'
import type { Postcondition, Precondition, SessionRule } from '../src/index.js'

describe('TestVerdict', () => {
  test('pass', () => {
    const v = Decision.pass_()
    expect(v.passed).toBe(true)
    expect(v.message).toBeNull()
    expect(v.metadata).toEqual({})
  })

  test('fail', () => {
    const v = Decision.fail('something went wrong')
    expect(v.passed).toBe(false)
    expect(v.message).toBe('something went wrong')
  })

  test('fail_truncation', () => {
    const longMsg = 'x'.repeat(600)
    const v = Decision.fail(longMsg)
    expect(v.message!.length).toBe(500)
    expect(v.message!.endsWith('...')).toBe(true)
  })

  test('fail_exact_500', () => {
    const msg = 'x'.repeat(500)
    const v = Decision.fail(msg)
    expect(v.message).toBe(msg)
  })

  test('fail_with_metadata', () => {
    const v = Decision.fail('err', { key1: 'val1', key2: 42 })
    expect(v.metadata).toEqual({ key1: 'val1', key2: 42 })
  })
})

describe('TestPrecondition', () => {
  test('plain_object_sets_attributes', () => {
    const myCheck: Precondition = {
      tool: 'Bash',
      check: () => Decision.pass_(),
    }

    expect(myCheck.tool).toBe('Bash')
    expect(myCheck.when).toBeUndefined()
  })

  test('plain_object_with_when', () => {
    const whenFn = (e: { toolName: string }) => e.toolName === 'Bash'

    const myCheck: Precondition = {
      tool: 'Bash',
      check: () => Decision.pass_(),
      when: whenFn,
    }

    expect(myCheck.when).toBe(whenFn)
  })

  test('wildcard_tool', () => {
    const checkAll: Precondition = {
      tool: '*',
      check: () => Decision.pass_(),
    }

    expect(checkAll.tool).toBe('*')
  })
})

describe('TestPostcondition', () => {
  test('plain_object_sets_attributes', () => {
    const verifyOutput: Postcondition = {
      contractType: 'post',
      tool: 'Write',
      check: () => Decision.pass_(),
    }

    expect(verifyOutput.tool).toBe('Write')
  })
})

describe('TestSessionRule', () => {
  test('plain_object_sets_attributes', () => {
    const maxOps: SessionRule = {
      check: async () => Decision.pass_(),
    }

    expect(maxOps.check).toBeTypeOf('function')
  })
})
