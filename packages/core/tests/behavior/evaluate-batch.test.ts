/** Tests for Edictum.evaluateBatch() and evaluate() security edge cases. */

import { describe, expect, test } from 'vitest'

import { Decision } from '../../src/rules.js'
import type { Precondition, Postcondition } from '../../src/rules.js'
import { Edictum } from '../../src/guard.js'
import { MemoryBackend } from '../../src/storage.js'
import { NullAuditSink } from '../helpers.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeGuard(
  opts: {
    rules?: (Precondition | Postcondition)[]
    mode?: 'enforce' | 'observe'
  } = {},
): Edictum {
  return new Edictum({
    environment: 'test',
    mode: opts.mode,
    auditSink: new NullAuditSink(),
    backend: new MemoryBackend(),
    rules: opts.rules,
  })
}

// ---------------------------------------------------------------------------
// evaluateBatch()
// ---------------------------------------------------------------------------

describe('EvaluateBatch', () => {
  test('batch_correct_length', async () => {
    const guard = makeGuard()
    const results = await guard.evaluateBatch([
      { tool: 'ToolA', args: { a: 1 } },
      { tool: 'ToolB', args: { b: 2 } },
      { tool: 'ToolC', args: { c: 3 } },
    ])

    expect(results.length).toBe(3)
  })

  test('batch_mixed_results', async () => {
    const denyBash: Precondition = {
      name: 'deny-bash',
      tool: 'Bash',
      check: () => Decision.fail('bash denied'),
    }
    const guard = makeGuard({ rules: [denyBash] })
    const results = await guard.evaluateBatch([
      { tool: 'Bash', args: { command: 'ls' } },
      { tool: 'Read', args: { path: 'x' } },
    ])

    expect(results.length).toBe(2)
    expect(results[0]!.decision).toBe('deny')
    expect(results[1]!.decision).toBe('allow')
  })

  test('batch_principal_dict_conversion', async () => {
    const requireTicket: Precondition = {
      name: 'require-ticket',
      tool: '*',
      check: (toolCall) => {
        if (toolCall.principal?.ticketRef == null) {
          return Decision.fail('Ticket required')
        }
        return Decision.pass_()
      },
    }
    const guard = makeGuard({ rules: [requireTicket] })
    const results = await guard.evaluateBatch([
      {
        tool: 'Deploy',
        args: {},
        principal: { ticketRef: 'JIRA-42' },
      },
    ])

    expect(results.length).toBe(1)
    expect(results[0]!.decision).toBe('allow')
  })

  test('batch_output_dict_serialized_to_json', async () => {
    const checkOutput: Postcondition = {
      contractType: 'post',
      tool: '*',
      check: (_envelope, response) => {
        if (typeof response === 'string' && response.includes('secret')) {
          return Decision.fail('secret found')
        }
        return Decision.pass_()
      },
    }
    const guard = makeGuard({ rules: [checkOutput] })
    const results = await guard.evaluateBatch([
      {
        tool: 'Search',
        args: {},
        output: { text: 'contains secret data' },
      },
    ])

    expect(results.length).toBe(1)
    expect(results[0]!.decision).toBe('warn')
  })

  test('batch_empty_list', async () => {
    const guard = makeGuard()
    const results = await guard.evaluateBatch([])

    expect(results).toEqual([])
  })

  test('batch_string_output_passed_as_is', async () => {
    const checkOutput: Postcondition = {
      contractType: 'post',
      tool: '*',
      check: (_envelope, response) => {
        if (String(response).includes('PII')) {
          return Decision.fail('PII detected')
        }
        return Decision.pass_()
      },
    }
    const guard = makeGuard({ rules: [checkOutput] })
    const results = await guard.evaluateBatch([
      { tool: 'Read', args: {}, output: 'contains PII data' },
    ])

    expect(results.length).toBe(1)
    expect(results[0]!.decision).toBe('warn')
  })
})

// ---------------------------------------------------------------------------
// Security: postcondition deny-effect exception must produce deny decision
// ---------------------------------------------------------------------------

describe('security', () => {
  test('postcondition_deny_effect_exception_produces_deny_verdict', async () => {
    const throwingDeny = {
      _edictum_type: 'postcondition',
      name: 'deny-on-pii',
      tool: '*',
      effect: 'deny',
      check: () => {
        throw new Error('check crashed')
      },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ rules: [throwingDeny as any] })
    const result = await guard.evaluate(
      'TestTool',
      {},
      {
        output: 'some output',
      },
    )

    expect(result.decision).toBe('deny')
    expect(result.denyReasons.length).toBe(1)
    expect(result.policyError).toBe(true)
  })

  test('postcondition_warn_effect_exception_produces_warn_verdict', async () => {
    const throwingWarn = {
      _edictum_type: 'postcondition',
      name: 'warn-on-pii',
      tool: '*',
      action: 'warn',
      check: () => {
        throw new Error('check crashed')
      },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ rules: [throwingWarn as any] })
    const result = await guard.evaluate(
      'TestTool',
      {},
      {
        output: 'some output',
      },
    )

    expect(result.decision).toBe('warn')
    expect(result.warnReasons.length).toBe(1)
  })
})
