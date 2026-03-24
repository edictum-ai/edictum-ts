/**
 * Tests for RedactionPolicy — ported from Python test_audit.py::TestRedactionPolicy.
 *
 * Covers: key redaction, nested dicts, lists, key normalization, partial key match,
 * secret value detection (5 patterns), false positives, long string truncation,
 * detect_values toggle, bash command redaction, result redaction, payload capping,
 * custom sensitive keys.
 */

import { describe, test, expect } from 'vitest'

import { EdictumConfigError, RedactionPolicy } from '../src/index.js'

describe('TestRedactionPolicy', () => {
  test('redactSensitiveKeys', () => {
    const policy = new RedactionPolicy()
    const args = { username: 'alice', password: 'secret123', data: 'safe' }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['username']).toBe('alice')
    expect(result['password']).toBe('[REDACTED]')
    expect(result['data']).toBe('safe')
  })

  test('redactNestedDicts', () => {
    const policy = new RedactionPolicy()
    const args = { config: { api_key: 'sk-abc123', url: 'https://example.com' } }
    const result = policy.redactArgs(args) as Record<string, Record<string, unknown>>
    expect(result['config']['api_key']).toBe('[REDACTED]')
    expect(result['config']['url']).toBe('https://example.com')
  })

  test('redactLists', () => {
    const policy = new RedactionPolicy()
    const args = { items: [{ token: 'abc' }, { name: 'safe' }] }
    const result = policy.redactArgs(args) as Record<string, Record<string, unknown>[]>
    expect(result['items'][0]['token']).toBe('[REDACTED]')
    expect(result['items'][1]['name']).toBe('safe')
  })

  test('keyNormalization', () => {
    const policy = new RedactionPolicy()
    const args = { PASSWORD: 'secret', Api_Key: 'key123' }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['PASSWORD']).toBe('[REDACTED]')
    expect(result['Api_Key']).toBe('[REDACTED]')
  })

  test('partialKeyMatch', () => {
    const policy = new RedactionPolicy()
    const args = { auth_token: 'abc', my_secret_key: 'xyz', name: 'safe' }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['auth_token']).toBe('[REDACTED]')
    expect(result['my_secret_key']).toBe('[REDACTED]')
    expect(result['name']).toBe('safe')
  })

  test('secretValueDetection — OpenAI', () => {
    const policy = new RedactionPolicy()
    const args = { value: 'sk-abcdefghijklmnopqrstuvwxyz' }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['value']).toBe('[REDACTED]')
  })

  test('secretValueDetection — AWS', () => {
    const policy = new RedactionPolicy()
    const args = { value: 'AKIAIOSFODNN7EXAMPLE' }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['value']).toBe('[REDACTED]')
  })

  test('secretValueDetection — JWT', () => {
    const policy = new RedactionPolicy()
    const args = { value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload' }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['value']).toBe('[REDACTED]')
  })

  test('secretValueDetection — GitHub', () => {
    const policy = new RedactionPolicy()
    const args = { value: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['value']).toBe('[REDACTED]')
  })

  test('secretValueDetection — Slack', () => {
    const policy = new RedactionPolicy()
    const args = { value: 'xoxb-123456789-abcdefghij' }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['value']).toBe('[REDACTED]')
  })

  test('noFalsePositiveOnNormalValues', () => {
    const policy = new RedactionPolicy()
    const args = { value: 'hello world', count: 42 }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['value']).toBe('hello world')
    expect(result['count']).toBe(42)
  })

  test('longStringTruncation', () => {
    const policy = new RedactionPolicy()
    const longStr = 'x'.repeat(1500)
    const args = { data: longStr }
    const result = policy.redactArgs(args) as Record<string, string>
    expect(result['data'].length).toBe(1000)
    expect(result['data'].endsWith('...')).toBe(true)
  })

  test('detectValuesDisabled', () => {
    const policy = new RedactionPolicy(null, null, false)
    const args = { value: 'sk-abcdefghijklmnopqrstuvwxyz' }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['value']).toBe('sk-abcdefghijklmnopqrstuvwxyz')
  })

  test('redactBashCommand', () => {
    const policy = new RedactionPolicy()
    const cmd = 'export MY_SECRET_KEY=abc123'
    const result = policy.redactBashCommand(cmd)
    expect(result).toContain('[REDACTED]')
    expect(result).not.toContain('abc123')
  })

  test('redactBashPasswordFlag', () => {
    const policy = new RedactionPolicy()
    const cmd = 'mysql -p mypassword -u root'
    const result = policy.redactBashCommand(cmd)
    expect(result).toContain('[REDACTED]')
  })

  test('redactUrlCredentials', () => {
    const policy = new RedactionPolicy()
    const cmd = 'curl https://user:password123@example.com/api'
    const result = policy.redactBashCommand(cmd)
    expect(result).not.toContain('password123')
  })

  test('redactResult', () => {
    const policy = new RedactionPolicy()
    const result = policy.redactResult('short result')
    expect(result).toBe('short result')
  })

  test('redactResultTruncation', () => {
    const policy = new RedactionPolicy()
    const longResult = 'x'.repeat(600)
    const result = policy.redactResult(longResult)
    expect(result.length).toBe(500)
    expect(result.endsWith('...')).toBe(true)
  })

  test('capPayloadUnderLimit', () => {
    const policy = new RedactionPolicy()
    const data: Record<string, unknown> = { toolArgs: { key: 'value' }, toolName: 'test' }
    const result = policy.capPayload(data)
    expect('_truncated' in result).toBe(false)
  })

  test('capPayloadOverLimit', () => {
    const policy = new RedactionPolicy()
    const data: Record<string, unknown> = {
      toolArgs: { key: 'x'.repeat(40000) },
      resultSummary: 'big',
    }
    const result = policy.capPayload(data)
    expect(result['_truncated']).toBe(true)
    expect(result['toolArgs']).toEqual({ _redacted: 'payload exceeded 32KB' })
    expect('resultSummary' in result).toBe(false)
  })

  test('customSensitiveKeys', () => {
    const policy = new RedactionPolicy(new Set(['my_custom_field']))
    const args = { my_custom_field: 'secret', other: 'safe' }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['my_custom_field']).toBe('[REDACTED]')
    expect(result['other']).toBe('safe')
  })
})

describe('security', () => {
  test('custom pattern exceeding 10k chars rejected', () => {
    const longPattern = 'a'.repeat(10_001)
    expect(() => new RedactionPolicy(null, [[longPattern, '']])).toThrow(EdictumConfigError)
  })

  test('custom pattern at exactly 10k chars accepted', () => {
    const pattern = 'a'.repeat(10_000)
    expect(() => new RedactionPolicy(null, [[pattern, '']])).not.toThrow()
  })

  test('redactBashCommand caps input at 10k chars', () => {
    const policy = new RedactionPolicy()
    const longCmd = 'x'.repeat(20_000)
    const result = policy.redactBashCommand(longCmd)
    // Input is capped to 10k before regex processing
    expect(result.length).toBe(10_000)
  })

  test('redactResult caps input at 10k chars', () => {
    const policy = new RedactionPolicy()
    const longResult = 'x'.repeat(20_000)
    const result = policy.redactResult(longResult)
    expect(result.length).toBeLessThanOrEqual(500)
  })

  test('camelCase sensitive keys redacted', () => {
    const policy = new RedactionPolicy()
    const args = {
      accessToken: 'tok-123',
      clientSecret: 'sec-456',
      databaseUrl: 'postgres://...',
      dbPassword: 'pass',
      refreshToken: 'ref-789',
      normalField: 'safe',
    }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['accessToken']).toBe('[REDACTED]')
    expect(result['clientSecret']).toBe('[REDACTED]')
    expect(result['databaseUrl']).toBe('[REDACTED]')
    expect(result['dbPassword']).toBe('[REDACTED]')
    expect(result['refreshToken']).toBe('[REDACTED]')
    expect(result['normalField']).toBe('safe')
  })

  test('string values get bash redaction patterns applied', () => {
    const policy = new RedactionPolicy()

    // Password flag in shell command
    const r1 = policy.redactArgs({
      command: 'mysql --password hunter2',
    }) as Record<string, unknown>
    expect(r1['command']).toContain('[REDACTED]')
    expect(r1['command']).not.toContain('hunter2')

    // URL credentials
    const r2 = policy.redactArgs({
      url: 'https://admin:secret123@db.example.com',
    }) as Record<string, unknown>
    expect(r2['url']).not.toContain('secret123')
    expect(r2['url']).toContain('db.example.com') // structure survives partial redaction

    // Export with secret env var
    const r3 = policy.redactArgs({
      script: 'export API_KEY=sk-abc123',
    }) as Record<string, unknown>
    expect(r3['script']).toContain('[REDACTED]')
    expect(r3['script']).not.toContain('sk-abc123')
  })

  test('bare string args get bash redaction patterns applied', () => {
    const policy = new RedactionPolicy()
    const result = policy.redactArgs('mysql -p secretpass -u root') as string
    expect(result).toContain('[REDACTED]')
    expect(result).not.toContain('secretpass')
  })

  test('string values in arrays get bash redaction patterns applied', () => {
    const policy = new RedactionPolicy()
    const result = policy.redactArgs(['export MY_SECRET_KEY=abc123', 'safe value']) as string[]
    expect(result[0]).toContain('[REDACTED]')
    expect(result[0]).not.toContain('abc123')
    expect(result[1]).toBe('safe value')
  })

  test('redactArgs caps string input at MAX_REGEX_INPUT', () => {
    const policy = new RedactionPolicy()
    const longStr = 'x'.repeat(20_000)
    const result = policy.redactArgs(longStr) as string
    // After cap + 1000-char truncation, output must be ≤ 1000 chars.
    expect(result.length).toBeLessThanOrEqual(1000)
  })

  test('detectSecretValues=false bypasses bash patterns in redactArgs', () => {
    const policy = new RedactionPolicy(null, null, false)
    const result = policy.redactArgs({
      command: 'export MY_KEY=somevalue',
    }) as Record<string, unknown>
    expect(result['command']).toBe('export MY_KEY=somevalue')
  })

  test('detectSecretValues=false does NOT bypass bash patterns in redactBashCommand', () => {
    // redactBashCommand always applies patterns regardless of detectSecretValues
    const policy = new RedactionPolicy(null, null, false)
    const result = policy.redactBashCommand('mysql --password hunter2')
    expect(result).not.toContain('hunter2')
    expect(result).toContain('[REDACTED]')
  })

  test('-psecret attached form is redacted (not leaked)', () => {
    // mysql -psecret is widely used — the -p pattern must catch it even
    // though it also false-positives on -port. For a security product,
    // leaking a password is worse than garbling -port in logged output.
    const policy = new RedactionPolicy()
    const result = policy.redactArgs({
      cmd: 'mysql -pSupers3cret123 db_name',
    }) as Record<string, unknown>
    expect(result['cmd']).not.toContain('Supers3cret123')
    expect(result['cmd']).toContain('[REDACTED]')
  })

  test('camelCase does not false positive on non-sensitive', () => {
    const policy = new RedactionPolicy()
    const args = {
      monkey: 'george',
      bucket: 's3-data',
      socket: 'ws://...',
      market: 'nasdaq',
    }
    const result = policy.redactArgs(args) as Record<string, unknown>
    expect(result['monkey']).toBe('george')
    expect(result['bucket']).toBe('s3-data')
    expect(result['socket']).toBe('ws://...')
    expect(result['market']).toBe('nasdaq')
  })
})
