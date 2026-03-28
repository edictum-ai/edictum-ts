/** Tests for postcondition violations interface. */

import { describe, expect, test } from 'vitest'

import {
  buildViolations,
  classifyViolation,
  createViolation,
  createPostCallResult,
} from '../src/index.js'
import type { Violation, PostCallResult, PostDecisionLike } from '../src/index.js'

describe('TestFinding', () => {
  test('creation', () => {
    const f = createViolation({
      type: 'pii_detected',
      ruleId: 'pii-in-output',
      field: 'output.text',
      message: 'SSN pattern found',
    })
    expect(f.type).toBe('pii_detected')
    expect(f.ruleId).toBe('pii-in-output')
    expect(f.field).toBe('output.text')
    expect(f.message).toBe('SSN pattern found')
    expect(f.metadata).toEqual({})
  })

  test('frozen', () => {
    const f = createViolation({
      type: 'pii',
      ruleId: 'x',
      field: 'y',
      message: 'z',
    })
    expect(() => {
      ;(f as any).type = 'other'
    }).toThrow(TypeError)
  })

  test('with_metadata', () => {
    const f = createViolation({
      type: 'pii_detected',
      ruleId: 'pii-check',
      field: 'output.text',
      message: 'SSN found',
      metadata: { pattern: '\\d{3}-\\d{2}-\\d{4}', match_count: 2 },
    })
    expect(f.metadata['match_count']).toBe(2)
  })

  test('equality', () => {
    const f1 = createViolation({
      type: 'pii',
      ruleId: 'c1',
      field: 'output',
      message: 'm',
    })
    const f2 = createViolation({
      type: 'pii',
      ruleId: 'c1',
      field: 'output',
      message: 'm',
    })
    expect(f1).toEqual(f2)
  })
})

describe('TestPostCallResult', () => {
  test('default_passed', () => {
    const r = createPostCallResult({ result: 'hello' })
    expect(r.postconditionsPassed).toBe(true)
    expect(r.violations).toEqual([])
  })

  test('with_findings', () => {
    const violations: Violation[] = [
      createViolation({
        type: 'pii_detected',
        ruleId: 'c1',
        field: 'output',
        message: 'SSN',
      }),
      createViolation({
        type: 'secret_detected',
        ruleId: 'c2',
        field: 'output',
        message: 'API key',
      }),
    ]
    const r = createPostCallResult({
      result: 'raw output',
      postconditionsPassed: false,
      violations,
    })
    expect(r.postconditionsPassed).toBe(false)
    expect(r.violations).toHaveLength(2)
    expect(r.violations[0]!.type).toBe('pii_detected')
  })

  test('result_preserved', () => {
    const obj = { data: [1, 2, 3] }
    const r = createPostCallResult({ result: obj })
    expect(r.result).toBe(obj)
  })
})

describe('TestClassifyFinding', () => {
  test('pii', () => {
    expect(classifyViolation('pii-in-output', 'SSN detected')).toBe('pii_detected')
    expect(classifyViolation('check-patient-data', 'found patient ID')).toBe('pii_detected')
  })

  test('secret', () => {
    expect(classifyViolation('no-secrets', 'API key in output')).toBe('secret_detected')
    expect(classifyViolation('credential-check', '')).toBe('secret_detected')
  })

  test('limit', () => {
    expect(classifyViolation('session-limit', 'max calls exceeded')).toBe('limit_exceeded')
  })

  test('default', () => {
    expect(classifyViolation('some-rule', 'something happened')).toBe('policy_violation')
  })

  test('case_insensitive', () => {
    expect(classifyViolation('PII-Check', 'Found SSN')).toBe('pii_detected')
    expect(classifyViolation('SECRET-SCAN', 'Token found')).toBe('secret_detected')
  })
})

describe('TestBuildFindings', () => {
  test('field_defaults_to_output', () => {
    const decision: PostDecisionLike = {
      contractsEvaluated: [{ name: 'pii-check', passed: false, message: 'SSN found' }],
    }
    const violations = buildViolations(decision)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.field).toBe('output')
  })

  test('field_extracted_from_metadata', () => {
    const decision: PostDecisionLike = {
      contractsEvaluated: [
        {
          name: 'pii-check',
          passed: false,
          message: 'SSN found',
          metadata: { field: 'output.text' },
        },
      ],
    }
    const violations = buildViolations(decision)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.field).toBe('output.text')
  })

  test('skips_passed_contracts', () => {
    const decision: PostDecisionLike = {
      contractsEvaluated: [{ name: 'ok-check', passed: true, message: undefined }],
    }
    const violations = buildViolations(decision)
    expect(violations).toEqual([])
  })

  test('metadata_preserved_in_finding', () => {
    const decision: PostDecisionLike = {
      contractsEvaluated: [
        {
          name: 'pii-check',
          passed: false,
          message: 'SSN found',
          metadata: { field: 'output.text', match_count: 3 },
        },
      ],
    }
    const violations = buildViolations(decision)
    expect(violations[0]!.metadata['match_count']).toBe(3)
    expect(violations[0]!.metadata['field']).toBe('output.text')
  })
})
