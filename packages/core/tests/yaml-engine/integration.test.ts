/** End-to-end integration tests for YAML rule engine — ports Python test_integration.py. */

import { describe, expect, test } from 'vitest'

import { Edictum } from '../../src/guard.js'
import { EdictumDenied } from '../../src/errors.js'
import { NullAuditSink } from '../helpers.js'

// ---------------------------------------------------------------------------
// YAML fixtures
// ---------------------------------------------------------------------------

const VALID_BUNDLE = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: test-bundle
defaults:
  mode: enforce
rules:
  - id: block-sensitive-reads
    type: pre
    tool: read_file
    when:
      args.path:
        contains_any: [".env", ".secret"]
    then:
      action: block
      message: "Sensitive file '{args.path}' denied."
      tags: [secrets, dlp]
  - id: pii-in-output
    type: post
    tool: "*"
    when:
      output.text:
        matches: "\\\\d{3}-\\\\d{2}-\\\\d{4}"
    then:
      action: warn
      message: "PII detected in output."
      tags: [pii]
  - id: session-limit
    type: session
    limits:
      max_tool_calls: 50
      max_attempts: 120
    then:
      action: block
      message: "Session limit exceeded."
`

const BASIC_PRE_BUNDLE = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: test-pre
defaults:
  mode: enforce
rules:
  - id: block-env-reads
    type: pre
    tool: read_file
    when:
      args.path:
        contains_any: [".env", ".secret"]
    then:
      action: block
      message: "Sensitive file denied."
      tags: [secrets]
  - id: bash-safety
    type: pre
    tool: bash
    when:
      args.command:
        matches: '\\brm\\s+-rf\\b'
    then:
      action: block
      message: "Destructive command denied."
      tags: [safety]
`

const POST_BUNDLE = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: test-post
defaults:
  mode: enforce
rules:
  - id: pii-check
    type: post
    tool: "*"
    when:
      output.text:
        matches: '\\b\\d{3}-\\d{2}-\\d{4}\\b'
    then:
      action: warn
      message: "PII detected."
      tags: [pii]
`

const OBSERVE_BUNDLE = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: test-observe
defaults:
  mode: enforce
rules:
  - id: observed-rule
    type: pre
    tool: bash
    mode: observe
    when:
      args.command:
        contains: "rm"
    then:
      action: block
      message: "Would deny rm."
      tags: [safety]
`

const MIXED_BUNDLE = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: test-mixed
defaults:
  mode: enforce
rules:
  - id: block-env-reads
    type: pre
    tool: read_file
    when:
      args.path:
        contains_any: [".env", ".secret"]
    then:
      action: block
      message: "Sensitive file denied."
      tags: [secrets]
  - id: pii-check
    type: post
    tool: "*"
    when:
      output.text:
        matches: '\\b\\d{3}-\\d{2}-\\d{4}\\b'
    then:
      action: warn
      message: "PII detected."
      tags: [pii]
`

// ---------------------------------------------------------------------------
// fromYamlString — Guard creation
// ---------------------------------------------------------------------------

describe('FromYamlString', () => {
  test('creates guard', () => {
    const guard = Edictum.fromYamlString(VALID_BUNDLE)
    expect(guard).toBeInstanceOf(Edictum)
    expect(guard.mode).toBe('enforce')
  })

  test('policy version is SHA256 hex', () => {
    const guard = Edictum.fromYamlString(VALID_BUNDLE)
    expect(guard.policyVersion).not.toBeNull()
    expect(guard.policyVersion!.length).toBe(64)
    expect(/^[a-f0-9]{64}$/.test(guard.policyVersion!)).toBe(true)
  })

  test('mode override', () => {
    const guard = Edictum.fromYamlString(VALID_BUNDLE, { mode: 'observe' })
    expect(guard.mode).toBe('observe')
  })

  test('limits from YAML', () => {
    const guard = Edictum.fromYamlString(VALID_BUNDLE)
    expect(guard.limits.maxToolCalls).toBe(50)
    expect(guard.limits.maxAttempts).toBe(120)
  })
})

// ---------------------------------------------------------------------------
// End-to-end: run() with YAML rules
// ---------------------------------------------------------------------------

describe('EndToEndRun', () => {
  test('yaml precondition denies', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    await expect(
      guard.run('read_file', { path: '/home/.env' }, async () => 'contents'),
    ).rejects.toThrow(EdictumDenied)
  })

  test('yaml precondition allows', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.run(
      'read_file',
      { path: '/home/readme.md' },
      async () => 'readme contents',
    )
    expect(result).toBe('readme contents')
  })

  test('non-matching tool passes', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.run(
      'write_file',
      { path: '.env', content: 'test' },
      async () => 'ok',
    )
    expect(result).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// evaluate() with YAML rules
// ---------------------------------------------------------------------------

describe('Evaluate', () => {
  test('no matching rules returns allow', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.evaluate('send_email', { to: 'x' })
    expect(result.decision).toBe('allow')
    expect(result.contractsEvaluated).toBe(0)
  })

  test('precondition denies', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.evaluate('read_file', { path: '/app/.env' })
    expect(result.decision).toBe('deny')
    expect(result.denyReasons.length).toBeGreaterThanOrEqual(1)
    expect(result.rules[0]!.ruleId).toBe('block-env-reads')
  })

  test('precondition passes', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.evaluate('read_file', { path: 'README.md' })
    expect(result.decision).toBe('allow')
  })

  test('postcondition warns with output', async () => {
    const guard = Edictum.fromYamlString(POST_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.evaluate(
      'read_file',
      { path: 'x' },
      {
        output: 'SSN: 123-45-6789',
      },
    )
    expect(result.decision).toBe('warn')
    expect(result.warnReasons.length).toBeGreaterThanOrEqual(1)
  })

  test('postcondition skipped without output', async () => {
    const guard = Edictum.fromYamlString(POST_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.evaluate('read_file', { path: 'x' })
    expect(result.contractsEvaluated).toBe(0)
    expect(result.decision).toBe('allow')
  })

  test('mixed deny and warn', async () => {
    const guard = Edictum.fromYamlString(MIXED_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.evaluate(
      'read_file',
      { path: '.env' },
      {
        output: 'SSN: 123-45-6789',
      },
    )
    expect(result.decision).toBe('deny')
    expect(result.denyReasons.length).toBeGreaterThanOrEqual(1)
    expect(result.warnReasons.length).toBeGreaterThanOrEqual(1)
  })

  test('bash regex match', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.evaluate('bash', { command: 'rm -rf /tmp' })
    expect(result.decision).toBe('deny')
    expect(result.rules[0]!.ruleId).toBe('bash-safety')
  })

  test('bash regex no match', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.evaluate('bash', { command: 'ls -la' })
    expect(result.decision).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// evaluateBatch()
// ---------------------------------------------------------------------------

describe('EvaluateBatch', () => {
  test('batch correct length', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const results = await guard.evaluateBatch([
      { tool: 'read_file', args: { path: 'a.txt' } },
      { tool: 'read_file', args: { path: 'b.txt' } },
      { tool: 'bash', args: { command: 'echo hi' } },
    ])
    expect(results.length).toBe(3)
  })

  test('batch mixed results', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const results = await guard.evaluateBatch([
      { tool: 'read_file', args: { path: '/app/.env' } },
      { tool: 'read_file', args: { path: 'README.md' } },
    ])
    expect(results[0]!.decision).toBe('deny')
    expect(results[1]!.decision).toBe('allow')
  })

  test('batch empty list', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const results = await guard.evaluateBatch([])
    expect(results).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Observe mode
// ---------------------------------------------------------------------------

describe('ObserveMode', () => {
  test('observe mode rule does not block', async () => {
    const guard = Edictum.fromYamlString(OBSERVE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    // Should NOT raise even though the rule matches
    const result = await guard.run('bash', { command: 'rm file' }, async () => 'done')
    expect(result).toBe('done')
  })

  test('observe mode in evaluate returns observed flag', async () => {
    const guard = Edictum.fromYamlString(OBSERVE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    const result = await guard.evaluate('bash', { command: 'rm file' })
    expect(result.decision).toBe('allow')
    expect(result.rules.length).toBe(1)
    expect(result.rules[0]!.observed).toBe(true)
    expect(result.rules[0]!.passed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reload()
// ---------------------------------------------------------------------------

describe('Reload', () => {
  test('reload atomically replaces rules', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })

    // Before reload: .env is denied
    const before = await guard.evaluate('read_file', { path: '.env' })
    expect(before.decision).toBe('deny')

    // Reload with a bundle that has no pre rules for read_file
    const newBundle = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: relaxed
defaults:
  mode: enforce
rules:
  - id: only-bash
    type: pre
    tool: bash
    when:
      args.command:
        contains: "rm"
    then:
      action: block
      message: "No rm."
`
    guard.reload(newBundle)

    // After reload: .env is allowed (no matching rule for read_file)
    const after = await guard.evaluate('read_file', { path: '.env' })
    expect(after.decision).toBe('allow')

    // New rule is active
    const bash = await guard.evaluate('bash', { command: 'rm -rf /' })
    expect(bash.decision).toBe('deny')
  })

  test('reload updates policy version', () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE)
    const oldVersion = guard.policyVersion

    const newBundle = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: different
defaults:
  mode: enforce
rules:
  - id: placeholder
    type: pre
    tool: "*"
    when:
      args.x: { equals: "__never__" }
    then:
      action: block
      message: "placeholder"
`
    guard.reload(newBundle)
    expect(guard.policyVersion).not.toBe(oldVersion)
  })

  test('reload passes custom operators', () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
      customOperators: { is_even: (v) => (v as number) % 2 === 0 },
    })

    const newBundle = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: custom-op
defaults:
  mode: enforce
rules:
  - id: even-check
    type: pre
    tool: "*"
    when:
      args.count:
        is_even: true
    then:
      action: block
      message: "Even count denied."
`
    // Should not throw when custom operator is provided to reload
    expect(() =>
      guard.reload(newBundle, {
        customOperators: { is_even: (v) => (v as number) % 2 === 0 },
      }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Security: adversarial integration tests
// ---------------------------------------------------------------------------

describe('security', () => {
  test('fromYaml returnReport returns tuple', () => {
    const { writeFileSync, mkdtempSync } = require('node:fs')
    const { join } = require('node:path')
    const { tmpdir } = require('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'edictum-sec-'))
    const filePath = join(dir, 'bundle.yaml')
    writeFileSync(filePath, BASIC_PRE_BUNDLE, 'utf-8')

    const result = Edictum.fromYaml(filePath, { returnReport: true })
    expect(Array.isArray(result)).toBe(true)
    const [guard, report] = result as [Edictum, unknown]
    expect(guard).toBeInstanceOf(Edictum)
    expect(report).toBeDefined()
  })

  test('YAML without defaults section throws config error', () => {
    const badBundle = `
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: no-defaults
rules:
  - id: rule
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"
`
    expect(() => Edictum.fromYamlString(badBundle)).toThrow()
  })

  test('deny decision propagates end-to-end through run()', async () => {
    const guard = Edictum.fromYamlString(BASIC_PRE_BUNDLE, {
      auditSink: new NullAuditSink(),
    })
    // Verify deny is never silently converted to allow
    let toolExecuted = false
    await expect(
      guard.run('read_file', { path: '.env' }, async () => {
        toolExecuted = true
        return 'should not reach'
      }),
    ).rejects.toThrow(EdictumDenied)
    expect(toolExecuted).toBe(false)
  })
})
