/** Tests for GovernancePipeline.postExecute — post-execution governance flows. */

import { describe, expect, test } from 'vitest'

import { Verdict } from '../../src/contracts.js'
import type { Precondition, Postcondition, SessionContract } from '../../src/contracts.js'
import { createEnvelope } from '../../src/envelope.js'
import type { ToolEnvelope } from '../../src/envelope.js'
import { Edictum } from '../../src/guard.js'
import type { OperationLimits } from '../../src/limits.js'
import { GovernancePipeline } from '../../src/pipeline.js'
import { MemoryBackend } from '../../src/storage.js'
import type { HookRegistration } from '../../src/types.js'
import { NullAuditSink } from '../helpers.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface MakeGuardOptions {
  environment?: string
  mode?: 'enforce' | 'observe'
  limits?: OperationLimits
  contracts?: (Precondition | Postcondition | SessionContract)[]
  hooks?: HookRegistration[]
  backend?: MemoryBackend
  tools?: Record<string, { side_effect?: string; idempotent?: boolean }>
}

function makeGuard(opts: MakeGuardOptions = {}): Edictum {
  return new Edictum({
    environment: opts.environment ?? 'test',
    mode: opts.mode,
    auditSink: new NullAuditSink(),
    backend: opts.backend ?? new MemoryBackend(),
    contracts: opts.contracts,
    hooks: opts.hooks,
    limits: opts.limits,
    tools: opts.tools,
  })
}

/**
 * Create an internal observe-mode postcondition using _edictum_* metadata.
 * This exercises the real _classifyInternal constructor path.
 */
function makeObservePostcondition(
  name: string,
  checkFn: (envelope: ToolEnvelope, response: unknown) => Verdict,
) {
  return {
    _edictum_type: 'postcondition',
    _edictum_observe: true,
    name,
    tool: '*',
    source: 'yaml_postcondition',
    check: checkFn,
  }
}

// ---------------------------------------------------------------------------
// TestPostExecute
// ---------------------------------------------------------------------------

describe('TestPostExecute', () => {
  test('success_no_postconditions', async () => {
    const backend = new MemoryBackend()
    const guard = makeGuard({ backend })
    const pipeline = new GovernancePipeline(guard)
    const envelope = createEnvelope('TestTool', {})

    const decision = await pipeline.postExecute(envelope, 'ok', true)
    expect(decision.toolSuccess).toBe(true)
    expect(decision.postconditionsPassed).toBe(true)
    expect(decision.warnings).toEqual([])
  })

  test('postcondition_failure_pure_tool', async () => {
    const backend = new MemoryBackend()
    const checkResult: Postcondition = {
      contractType: 'post',
      tool: 'TestTool',
      check: (_envelope, result) => {
        if (result !== 'expected') {
          return Verdict.fail('Unexpected result')
        }
        return Verdict.pass_()
      },
    }

    const guard = makeGuard({
      contracts: [checkResult],
      backend,
      tools: { TestTool: { side_effect: 'pure' } },
    })
    const pipeline = new GovernancePipeline(guard)
    const envelope = createEnvelope(
      'TestTool',
      {},
      {
        registry: guard.toolRegistry,
      },
    )

    const decision = await pipeline.postExecute(envelope, 'wrong', true)
    expect(decision.postconditionsPassed).toBe(false)
    expect(decision.warnings).toHaveLength(1)
    expect(decision.warnings[0]!.toLowerCase()).toContain('consider retrying')
  })

  test('postcondition_failure_write_tool', async () => {
    const backend = new MemoryBackend()
    const checkWrite: Postcondition = {
      contractType: 'post',
      tool: 'WriteTool',
      check: (_envelope, _result) => {
        return Verdict.fail('Write verification failed')
      },
    }

    const guard = makeGuard({ contracts: [checkWrite], backend })
    const pipeline = new GovernancePipeline(guard)
    const envelope = createEnvelope('WriteTool', {})

    const decision = await pipeline.postExecute(envelope, 'result', true)
    expect(decision.postconditionsPassed).toBe(false)
    expect(decision.warnings[0]!.toLowerCase()).toContain('assess before proceeding')
  })

  test('after_hooks_called', async () => {
    const backend = new MemoryBackend()
    const called: unknown[] = []

    function afterHook(_envelope: ToolEnvelope, result: unknown): void {
      called.push(result)
    }

    const hook: HookRegistration = {
      phase: 'after',
      tool: '*',
      callback: afterHook,
    }
    const guard = makeGuard({ hooks: [hook], backend })
    const pipeline = new GovernancePipeline(guard)
    const envelope = createEnvelope('TestTool', {})

    await pipeline.postExecute(envelope, 'the_result', true)
    expect(called).toEqual(['the_result'])
  })

  test('tool_failure_reported', async () => {
    const backend = new MemoryBackend()
    const guard = makeGuard({ backend })
    const pipeline = new GovernancePipeline(guard)
    const envelope = createEnvelope('TestTool', {})

    const decision = await pipeline.postExecute(envelope, 'Error: failed', false)
    expect(decision.toolSuccess).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Observe-alongside postconditions (injected via _edictum_* constructor path)
// ---------------------------------------------------------------------------

describe('TestObserveAlongsidePostconditions', () => {
  test('observe_postconditions_evaluated_in_post_execute', async () => {
    const backend = new MemoryBackend()
    const observePost = makeObservePostcondition(
      'observe-pii-check',
      (_envelope: ToolEnvelope, response: unknown) => {
        if (String(response).includes('SSN')) {
          return Verdict.fail('PII detected in output')
        }
        return Verdict.pass_()
      },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ backend, contracts: [observePost as any] })
    const pipeline = new GovernancePipeline(guard)
    const envelope = createEnvelope('TestTool', {})

    const decision = await pipeline.postExecute(envelope, 'Patient SSN: 123-45-6789', true)

    expect(decision.warnings.some((w: string) => w.includes('[observe]'))).toBe(true)
    expect(decision.warnings.some((w: string) => w.includes('PII detected'))).toBe(true)
    expect(decision.postconditionsPassed).toBe(true)

    const observeRecord = decision.contractsEvaluated.find(
      (c: Record<string, unknown>) => c['name'] === 'observe-pii-check',
    )
    expect(observeRecord).toBeDefined()
    expect(observeRecord!['observed']).toBe(true)
    expect(observeRecord!['passed']).toBe(false)
  })

  test('observe_postconditions_pass_does_not_warn', async () => {
    const backend = new MemoryBackend()
    const observePost = makeObservePostcondition(
      'observe-check',
      (_envelope: ToolEnvelope, _response: unknown) => Verdict.pass_(),
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ backend, contracts: [observePost as any] })
    const pipeline = new GovernancePipeline(guard)
    const envelope = createEnvelope('TestTool', {})

    const decision = await pipeline.postExecute(envelope, 'safe output', true)

    expect(decision.warnings.length).toBe(0)
    expect(decision.postconditionsPassed).toBe(true)
  })

  test('observe_postcondition_error_does_not_crash', async () => {
    const backend = new MemoryBackend()
    const observePost = makeObservePostcondition('observe-broken', () => {
      throw new Error('boom')
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ backend, contracts: [observePost as any] })
    const pipeline = new GovernancePipeline(guard)
    const envelope = createEnvelope('TestTool', {})

    const decision = await pipeline.postExecute(envelope, 'output', true)

    expect(decision.warnings.some((w: string) => w.includes('[observe]'))).toBe(true)
    expect(decision.postconditionsPassed).toBe(true)
  })
})
