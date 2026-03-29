/** Tests for Edictum.evaluate() and Edictum.evaluateBatch() — dry-run evaluation. */

import { describe, expect, test } from 'vitest'

import { Decision } from '../../src/rules.js'
import type { Precondition, Postcondition } from '../../src/rules.js'
import { Edictum } from '../../src/guard.js'
import { MemoryBackend } from '../../src/storage.js'
import { NullAuditSink } from '../helpers.js'
import { createPrincipal } from '../../src/tool-call.js'
import { WorkflowRuntime, loadWorkflowString } from '../../src/workflow/index.js'

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
// evaluate() — basic verdicts
// ---------------------------------------------------------------------------

describe('EvaluateBasicVerdicts', () => {
  test('no_matching_contracts_returns_allow', async () => {
    const guard = makeGuard()
    const result = await guard.evaluate('UnknownTool', { x: 1 })

    expect(result.decision).toBe('allow')
    expect(result.contractsEvaluated).toBe(0)
    expect(result.rules).toEqual([])
    expect(result.denyReasons).toEqual([])
    expect(result.warnReasons).toEqual([])
  })

  test('precondition_deny_returns_deny_with_reasons', async () => {
    const denyAll: Precondition = {
      name: 'block-all',
      tool: '*',
      check: () => Decision.fail('not allowed'),
    }
    const guard = makeGuard({ rules: [denyAll] })
    const result = await guard.evaluate('TestTool', {})

    expect(result.decision).toBe('deny')
    expect(result.denyReasons.length).toBe(1)
    expect(result.denyReasons[0]).toContain('not allowed')
    expect(result.rules[0]!.ruleId).toBe('block-all')
    expect(result.rules[0]!.contractType).toBe('precondition')
    expect(result.rules[0]!.passed).toBe(false)
  })

  test('precondition_pass_returns_allow', async () => {
    const passAll: Precondition = {
      tool: '*',
      check: () => Decision.pass_(),
    }
    const guard = makeGuard({ rules: [passAll] })
    const result = await guard.evaluate('TestTool', {})

    expect(result.decision).toBe('allow')
    expect(result.denyReasons).toEqual([])
  })

  test('workflow_runtime_is_reported_as_skipped_in_dry_run', async () => {
    const workflowRuntime = new WorkflowRuntime(
      loadWorkflowString(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: dry-run-skip
stages:
  - id: read-context
    tools: [Read]
`),
    )
    const guard = new Edictum({
      environment: 'test',
      auditSink: new NullAuditSink(),
      backend: new MemoryBackend(),
      workflowRuntime,
    })

    const result = await guard.evaluate('Edit', { path: 'src/app.ts' })
    expect(result.workflowSkipped).toBe(true)
    expect(result.workflowReason).toContain('runtime session state')
  })
})

// ---------------------------------------------------------------------------
// evaluate() — postconditions
// ---------------------------------------------------------------------------

describe('EvaluatePostconditions', () => {
  test('postcondition_warn_when_output_provided', async () => {
    const warnPost: Postcondition = {
      contractType: 'post',
      name: 'pii-check',
      tool: '*',
      check: (_envelope, response) => {
        if (String(response).includes('SSN')) {
          return Decision.fail('PII detected')
        }
        return Decision.pass_()
      },
    }
    const guard = makeGuard({ rules: [warnPost] })
    const result = await guard.evaluate(
      'TestTool',
      {},
      {
        output: 'SSN: 123-45-6789',
      },
    )

    expect(result.decision).toBe('warn')
    expect(result.warnReasons.length).toBeGreaterThanOrEqual(1)
    expect(result.rules[0]!.contractType).toBe('postcondition')
    expect(result.rules[0]!.passed).toBe(false)
  })

  test('postcondition_skipped_when_no_output', async () => {
    const warnPost: Postcondition = {
      contractType: 'post',
      tool: '*',
      check: () => Decision.fail('should not fire'),
    }
    const guard = makeGuard({ rules: [warnPost] })
    const result = await guard.evaluate('TestTool', {})

    expect(result.decision).toBe('allow')
    expect(result.contractsEvaluated).toBe(0)
  })

  test('postcondition_pass_with_output_returns_allow', async () => {
    const passPost: Postcondition = {
      contractType: 'post',
      tool: '*',
      check: () => Decision.pass_(),
    }
    const guard = makeGuard({ rules: [passPost] })
    const result = await guard.evaluate('TestTool', {}, { output: 'safe' })

    expect(result.decision).toBe('allow')
    expect(result.warnReasons).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// evaluate() — postcondition effect: deny → decision "deny"
// ---------------------------------------------------------------------------

describe('EvaluatePostconditionDenyEffect', () => {
  test('postcondition_effect_deny_returns_deny_verdict', async () => {
    // Simulate a YAML-compiled postcondition with effect: deny
    const denyPost = {
      _edictum_type: 'postcondition',
      name: 'block-pii',
      tool: '*',
      effect: 'deny',
      check: (_envelope: unknown, _response: unknown) => Decision.fail('PII detected'),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ rules: [denyPost as any] })
    const result = await guard.evaluate(
      'TestTool',
      {},
      {
        output: 'SSN: 123-45-6789',
      },
    )

    expect(result.decision).toBe('deny')
    expect(result.denyReasons.length).toBe(1)
    expect(result.denyReasons[0]).toContain('PII detected')
  })

  test('postcondition_effect_warn_returns_warn_verdict', async () => {
    const warnPost = {
      _edictum_type: 'postcondition',
      name: 'warn-pii',
      tool: '*',
      action: 'warn',
      check: (_envelope: unknown, _response: unknown) => Decision.fail('PII detected'),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ rules: [warnPost as any] })
    const result = await guard.evaluate(
      'TestTool',
      {},
      {
        output: 'SSN: 123-45-6789',
      },
    )

    expect(result.decision).toBe('warn')
    expect(result.warnReasons.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// evaluate() — exhaustive evaluation (no short-circuit)
// ---------------------------------------------------------------------------

describe('EvaluateExhaustive', () => {
  test('multiple_contracts_evaluated_exhaustively', async () => {
    const contractA: Precondition = {
      name: 'rule-a',
      tool: '*',
      check: () => Decision.fail('Rule A denied'),
    }
    const contractB: Precondition = {
      name: 'rule-b',
      tool: '*',
      check: () => Decision.fail('Rule B denied'),
    }
    const guard = makeGuard({ rules: [contractA, contractB] })
    const result = await guard.evaluate('TestTool', {})

    expect(result.contractsEvaluated).toBe(2)
    expect(result.rules[0]!.passed).toBe(false)
    expect(result.rules[1]!.passed).toBe(false)
    expect(result.denyReasons.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// evaluate() — observe mode
// ---------------------------------------------------------------------------

describe('EvaluateObserveMode', () => {
  test('observe_mode_contract_failure_excluded_from_deny_reasons', async () => {
    // Per-rule observe mode: stays in enforce list but has mode: "observe".
    // _edictum_observe=false keeps it in getPreconditions(); mode="observe"
    // makes evaluate() mark it as observed and exclude from deny_reasons.
    const observePre = {
      _edictum_type: 'precondition',
      _edictum_observe: false,
      name: 'observe-rule',
      tool: '*',
      mode: 'observe',
      check: () => Decision.fail('would deny'),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ rules: [observePre as any] })
    const result = await guard.evaluate('TestTool', {})

    expect(result.decision).toBe('allow')
    expect(result.denyReasons).toEqual([])
    expect(result.rules.length).toBe(1)
    expect(result.rules[0]!.observed).toBe(true)
    expect(result.rules[0]!.passed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// evaluate() — rule exception
// ---------------------------------------------------------------------------

describe('EvaluateContractException', () => {
  test('contract_exception_sets_policy_error', async () => {
    const broken: Precondition = {
      name: 'broken',
      tool: '*',
      check: () => {
        throw new Error('boom')
      },
    }
    const guard = makeGuard({ rules: [broken] })
    const result = await guard.evaluate('TestTool', {})

    expect(result.policyError).toBe(true)
    expect(result.decision).toBe('deny')
    expect(result.rules[0]!.policyError).toBe(true)
    expect(result.rules[0]!.passed).toBe(false)
    expect(result.rules[0]!.message).toContain('boom')
  })
})

// ---------------------------------------------------------------------------
// evaluate() — RuleResult fields
// ---------------------------------------------------------------------------

describe('EvaluateRuleResultFields', () => {
  test('contract_result_has_correct_fields', async () => {
    const tagged: Precondition = {
      name: 'tagged-rule',
      tool: '*',
      check: () => Decision.fail('denied', { tags: ['safety', 'security'] }),
    }
    const guard = makeGuard({ rules: [tagged] })
    const result = await guard.evaluate('TestTool', {})

    const cr = result.rules[0]!
    expect(cr.ruleId).toBe('tagged-rule')
    expect(cr.contractType).toBe('precondition')
    expect(cr.passed).toBe(false)
    expect(cr.message).toContain('denied')
    expect(cr.tags).toEqual(['safety', 'security'])
    // Default effect for precondition result in evaluate
    expect(cr.effect).toBe('warn')
    expect(typeof cr.policyError).toBe('boolean')
    expect(typeof cr.observed).toBe('boolean')
  })

  test('postcondition_effect_field_populated', async () => {
    const warnPost: Postcondition = {
      contractType: 'post',
      name: 'warn-post',
      tool: '*',
      check: () => Decision.fail('warned'),
    }
    const guard = makeGuard({ rules: [warnPost] })
    const result = await guard.evaluate('TestTool', {}, { output: 'text' })

    const cr = result.rules[0]!
    expect(cr.effect).toBe('warn')
    expect(cr.contractType).toBe('postcondition')
  })
})

// ---------------------------------------------------------------------------
// evaluate() — frozen results
// ---------------------------------------------------------------------------

describe('EvaluateFrozenResults', () => {
  test('evaluation_result_is_frozen', async () => {
    const guard = makeGuard()
    const result = await guard.evaluate('TestTool', {})

    expect(Object.isFrozen(result)).toBe(true)
  })

  test('contracts_array_is_frozen', async () => {
    const pre: Precondition = {
      tool: '*',
      check: () => Decision.fail('x'),
    }
    const guard = makeGuard({ rules: [pre] })
    const result = await guard.evaluate('TestTool', {})

    expect(Object.isFrozen(result.rules)).toBe(true)
  })

  test('deny_reasons_array_is_frozen', async () => {
    const guard = makeGuard()
    const result = await guard.evaluate('TestTool', {})

    expect(Object.isFrozen(result.denyReasons)).toBe(true)
    expect(Object.isFrozen(result.warnReasons)).toBe(true)
  })

  test('individual_contract_result_is_frozen', async () => {
    const pre: Precondition = {
      tool: '*',
      check: () => Decision.fail('x'),
    }
    const guard = makeGuard({ rules: [pre] })
    const result = await guard.evaluate('TestTool', {})

    expect(Object.isFrozen(result.rules[0])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// evaluate() — toolName in result
// ---------------------------------------------------------------------------

describe('EvaluateResultToolName', () => {
  test('result_contains_correct_toolName', async () => {
    const guard = makeGuard()
    const result = await guard.evaluate('SpecificTool', {})

    expect(result.toolName).toBe('SpecificTool')
  })
})
