/** Tests for resolvePath — cross-platform path resolution with security boundaries. */

import { describe, expect, test, beforeAll } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
  realpathSync,
} from 'node:fs'
import { join, resolve as pathResolve } from 'node:path'
import { tmpdir } from 'node:os'

import { resolvePath } from '../../src/yaml-engine/resolve-path.js'
import { createEnvelope } from '../../src/envelope.js'
import { compileSandbox } from '../../src/yaml-engine/sandbox-compile-fn.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmp: string
let subdir: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'edictum-resolve-path-'))
  subdir = join(tmp, 'subdir')
  mkdirSync(subdir)
  writeFileSync(join(subdir, 'file.txt'), 'test')
})

// ---------------------------------------------------------------------------
// Helpers (sandbox integration)
// ---------------------------------------------------------------------------

function _fileEnvelope(tool: string, filePath: string) {
  return createEnvelope(tool, { file_path: filePath }, { filePath })
}

function _sandbox(overrides: Record<string, unknown> = {}) {
  return compileSandbox({ id: 'test-sandbox', type: 'sandbox', tool: '*', ...overrides }, 'enforce')
}

function _checkResult(
  sandbox: Record<string, unknown>,
  envelope: ReturnType<typeof createEnvelope>,
) {
  const check = sandbox.check as (e: typeof envelope) => { passed: boolean; message: string | null }
  return check(envelope)
}

// ---------------------------------------------------------------------------
// Behavior tests
// ---------------------------------------------------------------------------

describe('resolvePath', () => {
  test('resolves existing file to its realpath', () => {
    const filePath = join(subdir, 'file.txt')
    const result = resolvePath(filePath)
    expect(result).toBe(realpathSync(filePath))
  })

  test('resolves existing directory to its realpath', () => {
    const result = resolvePath(subdir)
    expect(result).toBe(realpathSync(subdir))
  })

  test('resolves non-existent file under existing directory', () => {
    const nonexistent = join(subdir, 'does-not-exist.txt')
    const result = resolvePath(nonexistent)
    expect(result).toBe(join(realpathSync(subdir), 'does-not-exist.txt'))
  })

  test('resolves non-existent nested path under existing directory', () => {
    const deep = join(subdir, 'a', 'b', 'c', 'file.txt')
    const result = resolvePath(deep)
    expect(result).toBe(join(realpathSync(subdir), 'a', 'b', 'c', 'file.txt'))
  })

  test('resolves symlinked directory correctly', () => {
    const linkPath = join(tmp, 'link-to-subdir')
    try {
      symlinkSync(subdir, linkPath)
    } catch {
      /* may exist */
    }
    const result = resolvePath(join(linkPath, 'file.txt'))
    expect(result).toBe(join(realpathSync(subdir), 'file.txt'))
  })

  test('resolves non-existent file under symlinked directory', () => {
    const linkPath = join(tmp, 'link-to-subdir2')
    try {
      symlinkSync(subdir, linkPath)
    } catch {
      /* may exist */
    }
    const nonexistent = join(linkPath, 'nonexistent.txt')
    const result = resolvePath(nonexistent)
    expect(result).toBe(join(realpathSync(subdir), 'nonexistent.txt'))
  })

  test('macOS /tmp symlink: non-existent file resolves consistently', () => {
    const rawTmp = tmpdir()
    const realTmp = realpathSync(rawTmp)
    const nonexistent = join(rawTmp, 'edictum-resolve-test-' + Date.now() + '.txt')
    const result = resolvePath(nonexistent)
    expect(result.startsWith(realTmp)).toBe(true)
  })

  test('empty string resolves to cwd', () => {
    const result = resolvePath('')
    expect(result).toBe(realpathSync(process.cwd()))
  })

  test('root path resolves to root', () => {
    const result = resolvePath('/')
    expect(result).toBe(realpathSync('/'))
  })
})

// ---------------------------------------------------------------------------
// Security tests
// ---------------------------------------------------------------------------

describe('security', () => {
  test('EACCES returns normalized path without partial resolution', () => {
    const restrictedDir = join(tmp, 'restricted')
    mkdirSync(restrictedDir, { recursive: true })
    writeFileSync(join(restrictedDir, 'secret.txt'), 'hidden')
    chmodSync(restrictedDir, 0o000)

    try {
      const input = join(restrictedDir, 'secret.txt')
      const result = resolvePath(input)
      // EACCES on outer realpathSync → returns pathResolve(input)
      expect(result).toBe(pathResolve(input))
    } finally {
      chmodSync(restrictedDir, 0o755)
    }
  })

  test('circular symlink returns normalized path without partial resolution', () => {
    const linkA = join(tmp, 'circular-a')
    const linkB = join(tmp, 'circular-b')
    try {
      symlinkSync(linkB, linkA)
    } catch {
      /* may exist */
    }
    try {
      symlinkSync(linkA, linkB)
    } catch {
      /* may exist */
    }
    const input = join(linkA, 'file.txt')
    const result = resolvePath(input)
    // ELOOP on outer realpathSync → returns pathResolve(input), not a walk-up
    expect(result).toBe(pathResolve(input))
  })

  test('symlink escape is detected (link points outside boundary)', () => {
    const escapePath = join(tmp, 'escape-link')
    try {
      symlinkSync('/etc/passwd', escapePath)
    } catch {
      /* may exist */
    }
    const result = resolvePath(escapePath)
    expect(result).toBe(realpathSync('/etc/passwd'))
  })

  test('non-existent path with symlink in parent chain resolves correctly', () => {
    const midLink = join(tmp, 'mid-link')
    try {
      symlinkSync(subdir, midLink)
    } catch {
      /* may exist */
    }
    const result = resolvePath(join(midLink, 'deeply', 'nested', 'nonexistent.txt'))
    expect(result).toBe(join(realpathSync(subdir), 'deeply', 'nested', 'nonexistent.txt'))
  })
})

// ---------------------------------------------------------------------------
// Sandbox integration regression tests (issue #114)
// ---------------------------------------------------------------------------

describe('sandbox integration — issue #114', () => {
  test('non-existent file under symlinked within path is allowed', () => {
    // On macOS, /tmp → /private/tmp. Verifies that a within boundary
    // specified as /tmp/ correctly allows paths like /tmp/nonexistent.txt
    // even though the file doesn't exist on disk.
    const rawTmp = tmpdir()
    const sb = _sandbox({ within: [rawTmp] })
    const nonexistent = join(rawTmp, 'edictum-does-not-exist-' + Date.now() + '.txt')
    const env = _fileEnvelope('Read', nonexistent)
    const result = _checkResult(sb, env)
    expect(result.passed).toBe(true)
  })

  test('non-existent file outside symlinked within path is denied', () => {
    const rawTmp = tmpdir()
    const sb = _sandbox({ within: [join(rawTmp, 'allowed-subdir')] })
    const nonexistent = join(rawTmp, 'forbidden-subdir', 'file.txt')
    const env = _fileEnvelope('Read', nonexistent)
    const result = _checkResult(sb, env)
    expect(result.passed).toBe(false)
  })
})
