/** Tests for the YAML rule compiler — ports Python test_compiler.py. */

import { describe, expect, test } from 'vitest'

import { createEnvelope, createPrincipal } from '../../src/tool-call.js'
import type { ToolCall } from '../../src/tool-call.js'
import type { Decision } from '../../src/rules.js'
import {
  compileContracts,
  expandMessage,
  mergeSessionLimits,
  validateOperators,
} from '../../src/yaml-engine/index.js'
import { EdictumConfigError } from '../../src/errors.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _envelope(
  toolName = 'read_file',
  args: Record<string, unknown> = {},
  environment = 'production',
  principal?: ReturnType<typeof createPrincipal> | null,
): ToolCall {
  return createEnvelope(toolName, args, {
    environment,
    principal: principal ?? null,
  })
}

function _makeBundle(rules: Record<string, unknown>[], mode = 'enforce'): Record<string, unknown> {
  return {
    apiVersion: 'edictum/v1',
    kind: 'Ruleset',
    metadata: { name: 'test' },
    defaults: { mode },
    rules,
  }
}

// ---------------------------------------------------------------------------
// Pre-rule compilation
// ---------------------------------------------------------------------------

describe('CompilePreConditions', () => {
  const bundle = _makeBundle([
    {
      id: 'block-sensitive-reads',
      type: 'pre',
      tool: 'read_file',
      when: { 'args.path': { contains_any: ['.env', '.secret'] } },
      then: {
        action: 'block',
        message: "Sensitive file '{args.path}' denied.",
        tags: ['secrets', 'dlp'],
      },
    },
  ])

  test('pre rules compiled', () => {
    const compiled = compileContracts(bundle)
    expect(compiled.preconditions.length).toBe(1)
  })

  test('pre rule metadata', () => {
    const compiled = compileContracts(bundle)
    const fn = compiled.preconditions[0] as Record<string, unknown>
    expect(fn._edictum_type).toBe('precondition')
    expect(fn._edictum_tool).toBe('read_file')
    expect(fn._edictum_id).toBe('block-sensitive-reads')
  })

  test('pre rule denies matching', () => {
    const compiled = compileContracts(bundle)
    const fn = compiled.preconditions[0] as Record<string, unknown>
    const check = fn.check as (env: ToolCall) => Decision
    const env = _envelope('read_file', { path: '/home/user/.env' })
    const decision = check(env)
    expect(decision.passed).toBe(false)
  })

  test('pre rule passes non-matching', () => {
    const compiled = compileContracts(bundle)
    const fn = compiled.preconditions[0] as Record<string, unknown>
    const check = fn.check as (env: ToolCall) => Decision
    const env = _envelope('read_file', { path: '/home/user/readme.md' })
    const decision = check(env)
    expect(decision.passed).toBe(true)
  })

  test('pre rule tags in metadata', () => {
    const compiled = compileContracts(bundle)
    const fn = compiled.preconditions[0] as Record<string, unknown>
    const check = fn.check as (env: ToolCall) => Decision
    const env = _envelope('read_file', { path: '.env' })
    const decision = check(env)
    expect(decision.metadata.tags).toEqual(['secrets', 'dlp'])
  })

  test('pre rule passes when field missing', () => {
    const compiled = compileContracts(bundle)
    const fn = compiled.preconditions[0] as Record<string, unknown>
    const check = fn.check as (env: ToolCall) => Decision
    const env = _envelope('read_file', {})
    const decision = check(env)
    expect(decision.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Post-rule compilation
// ---------------------------------------------------------------------------

describe('CompilePostConditions', () => {
  const bundle = _makeBundle([
    {
      id: 'pii-in-output',
      type: 'post',
      tool: '*',
      when: { 'output.text': { matches: '\\d{3}-\\d{2}-\\d{4}' } },
      then: { action: 'warn', message: 'PII detected.', tags: ['pii'] },
    },
  ])

  test('post rules compiled', () => {
    const compiled = compileContracts(bundle)
    expect(compiled.postconditions.length).toBe(1)
  })

  test('post rule metadata', () => {
    const compiled = compileContracts(bundle)
    const fn = compiled.postconditions[0] as Record<string, unknown>
    expect(fn._edictum_type).toBe('postcondition')
    expect(fn._edictum_tool).toBe('*')
  })

  test('post rule warns on match', () => {
    const compiled = compileContracts(bundle)
    const fn = compiled.postconditions[0] as Record<string, unknown>
    const check = fn.check as (env: ToolCall, output: unknown) => Decision
    const decision = check(_envelope(), 'SSN: 123-45-6789')
    expect(decision.passed).toBe(false)
    expect(decision.metadata.tags).toEqual(['pii'])
  })

  test('post rule passes no match', () => {
    const compiled = compileContracts(bundle)
    const fn = compiled.postconditions[0] as Record<string, unknown>
    const check = fn.check as (env: ToolCall, output: unknown) => Decision
    const decision = check(_envelope(), 'No PII here')
    expect(decision.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Session rules
// ---------------------------------------------------------------------------

describe('CompileSessionContracts', () => {
  test('session rules compiled', () => {
    const bundle = _makeBundle([
      {
        id: 'session-limit',
        type: 'session',
        limits: { max_tool_calls: 50, max_attempts: 120 },
        then: { action: 'block', message: 'Session limit exceeded.' },
      },
    ])
    const compiled = compileContracts(bundle)
    expect(compiled.sessionContracts.length).toBe(1)
  })

  test('session limits merged', () => {
    const bundle = _makeBundle([
      {
        id: 'session-limit',
        type: 'session',
        limits: { max_tool_calls: 50, max_attempts: 120 },
        then: { action: 'block', message: 'Session limit exceeded.' },
      },
    ])
    const compiled = compileContracts(bundle)
    expect(compiled.limits.maxToolCalls).toBe(50)
    expect(compiled.limits.maxAttempts).toBe(120)
  })
})

// ---------------------------------------------------------------------------
// Disabled rules
// ---------------------------------------------------------------------------

describe('DisabledContracts', () => {
  test('disabled rule skipped', () => {
    const bundle = _makeBundle([
      {
        id: 'disabled-rule',
        type: 'pre',
        enabled: false,
        tool: 'read_file',
        when: { 'args.path': { contains: '.env' } },
        then: { action: 'block', message: 'denied' },
      },
    ])
    const compiled = compileContracts(bundle)
    expect(compiled.preconditions.length).toBe(0)
  })

  test('enabled rule included', () => {
    const bundle = _makeBundle([
      {
        id: 'enabled-rule',
        type: 'pre',
        enabled: true,
        tool: 'read_file',
        when: { 'args.path': { contains: '.env' } },
        then: { action: 'block', message: 'denied' },
      },
    ])
    const compiled = compileContracts(bundle)
    expect(compiled.preconditions.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Mode override
// ---------------------------------------------------------------------------

describe('ModeOverride', () => {
  test('default mode used', () => {
    const bundle = _makeBundle([
      {
        id: 'rule',
        type: 'pre',
        tool: 'read_file',
        when: { 'args.path': { contains: '.env' } },
        then: { action: 'block', message: 'denied' },
      },
    ])
    const compiled = compileContracts(bundle)
    expect(compiled.defaultMode).toBe('enforce')
    const fn = compiled.preconditions[0] as Record<string, unknown>
    expect(fn._edictum_mode).toBe('enforce')
  })

  test('per rule mode override', () => {
    const bundle = _makeBundle([
      {
        id: 'observe-rule',
        type: 'pre',
        mode: 'observe',
        tool: 'read_file',
        when: { 'args.path': { contains: '.env' } },
        then: { action: 'block', message: 'denied' },
      },
    ])
    const compiled = compileContracts(bundle)
    const fn = compiled.preconditions[0] as Record<string, unknown>
    expect(fn._edictum_mode).toBe('observe')
  })
})

// ---------------------------------------------------------------------------
// Message templating
// ---------------------------------------------------------------------------

describe('MessageTemplating', () => {
  test('simple placeholder', () => {
    const env = _envelope('read_file', { path: '/etc/passwd' })
    expect(expandMessage("File '{args.path}' denied.", env)).toBe("File '/etc/passwd' denied.")
  })

  test('tool name placeholder', () => {
    const env = _envelope('bash')
    expect(expandMessage('Tool {tool.name} denied.', env)).toBe('Tool bash denied.')
  })

  test('missing placeholder kept', () => {
    const env = _envelope('read_file', {})
    expect(expandMessage("File '{args.path}' denied.", env)).toBe("File '{args.path}' denied.")
  })

  test('placeholder capped at 200', () => {
    const longPath = 'x'.repeat(300)
    const env = _envelope('read_file', { path: longPath })
    const msg = expandMessage('{args.path}', env)
    expect(msg.length).toBe(200)
    expect(msg.endsWith('...')).toBe(true)
  })

  test('multiple placeholders', () => {
    const env = _envelope('read_file', { path: '/tmp' })
    expect(expandMessage('{tool.name}: {args.path}', env)).toBe('read_file: /tmp')
  })

  test('environment placeholder', () => {
    const env = _envelope('read_file', {}, 'staging')
    expect(expandMessage('Env: {environment}', env)).toBe('Env: staging')
  })

  test('principal placeholder', () => {
    const env = _envelope('read_file', {}, 'production', createPrincipal({ userId: 'alice' }))
    expect(expandMessage('User: {principal.user_id}', env)).toBe('User: alice')
  })
})

// ---------------------------------------------------------------------------
// Then metadata
// ---------------------------------------------------------------------------

describe('ThenMetadata', () => {
  test('then metadata in decision', () => {
    const bundle = _makeBundle([
      {
        id: 'meta-rule',
        type: 'pre',
        tool: 'read_file',
        when: { 'args.path': { contains: '.env' } },
        then: {
          action: 'block',
          message: 'denied',
          tags: ['secrets'],
          metadata: { severity: 'high', category: 'dlp' },
        },
      },
    ])
    const compiled = compileContracts(bundle)
    const fn = compiled.preconditions[0] as Record<string, unknown>
    const check = fn.check as (env: ToolCall) => Decision
    const decision = check(_envelope('read_file', { path: '.env' }))
    expect(decision.passed).toBe(false)
    expect(decision.metadata.tags).toEqual(['secrets'])
    expect(decision.metadata.severity).toBe('high')
    expect(decision.metadata.category).toBe('dlp')
  })
})

// ---------------------------------------------------------------------------
// PolicyError in compiled rules
// ---------------------------------------------------------------------------

describe('PolicyError', () => {
  test('type mismatch sets policyError', () => {
    const bundle = _makeBundle([
      {
        id: 'type-mismatch',
        type: 'pre',
        tool: '*',
        when: { 'args.count': { gt: 5 } },
        then: { action: 'block', message: 'Count too high.' },
      },
    ])
    const compiled = compileContracts(bundle)
    const fn = compiled.preconditions[0] as Record<string, unknown>
    const check = fn.check as (env: ToolCall) => Decision
    const decision = check(_envelope('read_file', { count: 'not_a_number' }))
    expect(decision.passed).toBe(false)
    expect(decision.metadata.policyError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Postcondition effect metadata
// ---------------------------------------------------------------------------

describe('PostconditionEffectMetadata', () => {
  test('effect stamped on post function', () => {
    const bundle = _makeBundle([
      {
        id: 'redact-secrets',
        type: 'post',
        tool: '*',
        when: { 'output.text': { matches_any: ['sk-[a-z0-9]+'] } },
        then: { action: 'redact', message: 'Secrets found.' },
      },
    ])
    const compiled = compileContracts(bundle)
    const fn = compiled.postconditions[0] as Record<string, unknown>
    expect(fn._edictum_effect).toBe('redact')
  })

  test('default effect is warn', () => {
    const bundle = _makeBundle([
      {
        id: 'pii-check',
        type: 'post',
        tool: '*',
        when: { 'output.text': { matches: '\\d{3}-\\d{2}-\\d{4}' } },
        then: { message: 'PII detected.' },
      },
    ])
    const compiled = compileContracts(bundle)
    const fn = compiled.postconditions[0] as Record<string, unknown>
    expect(fn._edictum_effect).toBe('warn')
  })

  test('redact patterns extracted', () => {
    const bundle = _makeBundle([
      {
        id: 'redact-keys',
        type: 'post',
        tool: '*',
        when: { 'output.text': { matches_any: ['sk-prod-[a-z0-9]{8}', 'AKIA-PROD-[A-Z]{12}'] } },
        then: { action: 'redact', message: 'Keys found.' },
      },
    ])
    const compiled = compileContracts(bundle)
    const fn = compiled.postconditions[0] as Record<string, unknown>
    const patterns = fn._edictum_redact_patterns as RegExp[]
    expect(patterns.length).toBe(2)
    expect(patterns.every((p) => p instanceof RegExp)).toBe(true)
    expect(patterns[0]!.test('sk-prod-abcd1234')).toBe(true)
    expect(patterns[1]!.test('AKIA-PROD-ABCDEFGHIJKL')).toBe(true)
  })

  test('no patterns for contains operator', () => {
    const bundle = _makeBundle([
      {
        id: 'contains-check',
        type: 'post',
        tool: '*',
        when: { 'output.text': { contains: 'secret' } },
        then: { action: 'redact', message: 'Secret found.' },
      },
    ])
    const compiled = compileContracts(bundle)
    const fn = compiled.postconditions[0] as Record<string, unknown>
    expect(fn._edictum_redact_patterns).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Session limits merging
// ---------------------------------------------------------------------------

describe('SessionLimitsMerging', () => {
  test('multiple session rules merge restrictive', () => {
    const bundle = _makeBundle([
      {
        id: 'limits-1',
        type: 'session',
        limits: { max_tool_calls: 100, max_attempts: 200 },
        then: { action: 'block', message: 'limit 1' },
      },
      {
        id: 'limits-2',
        type: 'session',
        limits: { max_tool_calls: 50, max_calls_per_tool: { bash: 10 } },
        then: { action: 'block', message: 'limit 2' },
      },
    ])
    const compiled = compileContracts(bundle)
    expect(compiled.limits.maxToolCalls).toBe(50)
    expect(compiled.limits.maxAttempts).toBe(200)
    expect(compiled.limits.maxCallsPerTool).toEqual({ bash: 10 })
  })

  test('mergeSessionLimits takes lower value', () => {
    const rule = { limits: { max_tool_calls: 30 } }
    const result = mergeSessionLimits(rule, { ...DEFAULT_LIMITS, maxToolCalls: 100 })
    expect(result.maxToolCalls).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// Security: adversarial compiler inputs
// ---------------------------------------------------------------------------

describe('security', () => {
  test('missing defaults section throws EdictumConfigError', () => {
    const bundle = {
      apiVersion: 'edictum/v1',
      kind: 'Ruleset',
      metadata: { name: 'test' },
      rules: [
        {
          id: 'rule',
          type: 'pre',
          tool: '*',
          when: { 'args.x': { equals: 1 } },
          then: { action: 'block', message: 'denied' },
        },
      ],
    }
    expect(() => compileContracts(bundle)).toThrow(EdictumConfigError)
  })

  test('defaults: null throws EdictumConfigError', () => {
    const bundle = {
      apiVersion: 'edictum/v1',
      kind: 'Ruleset',
      metadata: { name: 'test' },
      defaults: null,
      rules: [],
    }
    expect(() => compileContracts(bundle as unknown as Record<string, unknown>)).toThrow(
      EdictumConfigError,
    )
  })

  test('rule with unknown type throws EdictumConfigError', () => {
    const bundle = _makeBundle([
      {
        id: 'weird-type',
        type: 'unknown_type',
        tool: '*',
        when: { 'args.x': { equals: 1 } },
        then: { action: 'block', message: 'denied' },
      },
    ])
    expect(() => compileContracts(bundle)).toThrow(EdictumConfigError)
    expect(() => compileContracts(bundle)).toThrow(/Unknown rule type "unknown_type"/)
  })
})

// ---------------------------------------------------------------------------
// Operator validation
// ---------------------------------------------------------------------------

describe('OperatorValidation', () => {
  test('unknown operator throws', () => {
    const bundle = _makeBundle([
      {
        id: 'bad-op',
        type: 'pre',
        tool: '*',
        when: { 'args.x': { foobar: 42 } },
        then: { action: 'block', message: 'bad' },
      },
    ])
    expect(() => compileContracts(bundle)).toThrow(EdictumConfigError)
  })

  test('custom operator accepted', () => {
    const bundle = _makeBundle([
      {
        id: 'custom-op',
        type: 'pre',
        tool: '*',
        when: { 'args.x': { is_even: true } },
        then: { action: 'block', message: 'even' },
      },
    ])
    // Should not throw when custom operator is provided
    expect(() =>
      compileContracts(bundle, {
        customOperators: { is_even: (v) => (v as number) % 2 === 0 },
      }),
    ).not.toThrow()
  })
})
