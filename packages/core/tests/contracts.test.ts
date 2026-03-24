/** Tests for Verdict and contract interfaces. */

import { describe, expect, test } from 'vitest'

import { Verdict } from '../src/index.js'
import type { Postcondition, Precondition, SessionContract } from '../src/index.js'

describe('TestVerdict', () => {
  test('pass', () => {
    const v = Verdict.pass_()
    expect(v.passed).toBe(true)
    expect(v.message).toBeNull()
    expect(v.metadata).toEqual({})
  })

  test('fail', () => {
    const v = Verdict.fail('something went wrong')
    expect(v.passed).toBe(false)
    expect(v.message).toBe('something went wrong')
  })

  test('fail_truncation', () => {
    const longMsg = 'x'.repeat(600)
    const v = Verdict.fail(longMsg)
    expect(v.message!.length).toBe(500)
    expect(v.message!.endsWith('...')).toBe(true)
  })

  test('fail_exact_500', () => {
    const msg = 'x'.repeat(500)
    const v = Verdict.fail(msg)
    expect(v.message).toBe(msg)
  })

  test('fail_with_metadata', () => {
    const v = Verdict.fail('err', { key1: 'val1', key2: 42 })
    expect(v.metadata).toEqual({ key1: 'val1', key2: 42 })
  })
})

describe('TestPrecondition', () => {
  test('plain_object_sets_attributes', () => {
    const myCheck: Precondition = {
      tool: 'Bash',
      check: () => Verdict.pass_(),
    }

    expect(myCheck.tool).toBe('Bash')
    expect(myCheck.when).toBeUndefined()
  })

  test('plain_object_with_when', () => {
    const whenFn = (e: { toolName: string }) => e.toolName === 'Bash'

    const myCheck: Precondition = {
      tool: 'Bash',
      check: () => Verdict.pass_(),
      when: whenFn,
    }

    expect(myCheck.when).toBe(whenFn)
  })

  test('wildcard_tool', () => {
    const checkAll: Precondition = {
      tool: '*',
      check: () => Verdict.pass_(),
    }

    expect(checkAll.tool).toBe('*')
  })
})

describe('TestPostcondition', () => {
  test('plain_object_sets_attributes', () => {
    const verifyOutput: Postcondition = {
      contractType: 'post',
      tool: 'Write',
      check: () => Verdict.pass_(),
    }

    expect(verifyOutput.tool).toBe('Write')
  })
})

describe('TestSessionContract', () => {
  test('plain_object_sets_attributes', () => {
    const maxOps: SessionContract = {
      check: async () => Verdict.pass_(),
    }

    expect(maxOps.check).toBeTypeOf('function')
  })
})
