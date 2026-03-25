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

let tmp: string
let subdir: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'edictum-resolve-path-'))
  subdir = join(tmp, 'subdir')
  mkdirSync(subdir)
  writeFileSync(join(subdir, 'file.txt'), 'test')
})

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

describe('resolvePath', () => {
  test('resolves existing file to its realpath', () => {
    expect(resolvePath(join(subdir, 'file.txt'))).toBe(realpathSync(join(subdir, 'file.txt')))
  })

  test('resolves existing directory to its realpath', () => {
    expect(resolvePath(subdir)).toBe(realpathSync(subdir))
  })

  test('resolves non-existent file under existing directory', () => {
    const nonexistent = join(subdir, 'does-not-exist.txt')
    expect(resolvePath(nonexistent)).toBe(join(realpathSync(subdir), 'does-not-exist.txt'))
  })

  test('resolves non-existent nested path under existing directory', () => {
    const deep = join(subdir, 'a', 'b', 'c', 'file.txt')
    expect(resolvePath(deep)).toBe(join(realpathSync(subdir), 'a', 'b', 'c', 'file.txt'))
  })

  test('resolves symlinked directory correctly', () => {
    const linkPath = join(tmp, 'link-to-subdir')
    try {
      symlinkSync(subdir, linkPath)
    } catch {
      /* may exist */
    }
    expect(resolvePath(join(linkPath, 'file.txt'))).toBe(join(realpathSync(subdir), 'file.txt'))
  })

  test('resolves non-existent file under symlinked directory', () => {
    const linkPath = join(tmp, 'link-to-subdir2')
    try {
      symlinkSync(subdir, linkPath)
    } catch {
      /* may exist */
    }
    expect(resolvePath(join(linkPath, 'nonexistent.txt'))).toBe(
      join(realpathSync(subdir), 'nonexistent.txt'),
    )
  })

  test('macOS /tmp symlink: non-existent file resolves consistently', () => {
    const rawTmp = tmpdir()
    const realTmp = realpathSync(rawTmp)
    const nonexistent = join(rawTmp, 'edictum-resolve-test-' + Date.now() + '.txt')
    expect(resolvePath(nonexistent).startsWith(realTmp)).toBe(true)
  })

  test('empty string resolves to cwd', () => {
    expect(resolvePath('')).toBe(realpathSync(process.cwd()))
  })

  test('root path resolves to root', () => {
    expect(resolvePath('/')).toBe(realpathSync('/'))
  })

  test('EACCES on ancestor symlink target returns normalized path (fail closed)', () => {
    // If an ancestor in the walk-up is a symlink whose target is EACCES-
    // protected, bail out and return the normalized path rather than
    // skipping to a higher ancestor (which could mask a symlink escape).
    const restrictedTarget = join(tmp, 'restricted-target')
    mkdirSync(restrictedTarget, { recursive: true })
    chmodSync(restrictedTarget, 0o000)
    const ancestorLink = join(tmp, 'ancestor-link')
    try {
      symlinkSync(restrictedTarget, ancestorLink)
    } catch {
      /* may exist */
    }
    try {
      const input = join(ancestorLink, 'nonexistent.txt')
      const result = resolvePath(input)
      // Should return normalized path (fail closed), not walk past the EACCES
      expect(result).toBe(pathResolve(input))
    } finally {
      chmodSync(restrictedTarget, 0o755)
    }
  })
})

describe('security', () => {
  test('EACCES returns normalized path without partial resolution', () => {
    const restrictedDir = join(tmp, 'restricted')
    mkdirSync(restrictedDir, { recursive: true })
    writeFileSync(join(restrictedDir, 'secret.txt'), 'hidden')
    chmodSync(restrictedDir, 0o000)
    try {
      const input = join(restrictedDir, 'secret.txt')
      expect(resolvePath(input)).toBe(pathResolve(input))
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
    // ELOOP on outer realpathSync → returns pathResolve(input), not a walk-up
    expect(resolvePath(input)).toBe(pathResolve(input))
  })

  test('symlink escape is detected (link points outside boundary)', () => {
    const escapePath = join(tmp, 'escape-link')
    try {
      symlinkSync('/etc/passwd', escapePath)
    } catch {
      /* may exist */
    }
    expect(resolvePath(escapePath)).toBe(realpathSync('/etc/passwd'))
  })

  test('non-existent path with symlink in parent chain resolves correctly', () => {
    const midLink = join(tmp, 'mid-link')
    try {
      symlinkSync(subdir, midLink)
    } catch {
      /* may exist */
    }
    expect(resolvePath(join(midLink, 'deeply', 'nested', 'nonexistent.txt'))).toBe(
      join(realpathSync(subdir), 'deeply', 'nested', 'nonexistent.txt'),
    )
  })
})

describe('security — null byte stripping', () => {
  test('null bytes are stripped before resolution', () => {
    const result = resolvePath('/allowed/path\x00')
    // Null byte must not survive into the resolved path
    expect(result).not.toContain('\x00')
    expect(result).toBe('/allowed/path')
  })

  test('null byte sandbox escape is prevented', () => {
    // Attack: "/allowed\x00/../etc/shadow" — C tools truncate at \0
    // reading "/allowed" while sandbox sees "/allowed/../etc/shadow"
    // After stripping \0, path becomes "/allowed/../etc/shadow"
    // which resolves to "/etc/shadow" — now the sandbox correctly
    // evaluates the TRUE target and denies it.
    const result = resolvePath('/allowed\x00/../etc/shadow')
    expect(result).not.toContain('\x00')
    // The resolved path should point to /etc/shadow (the actual target),
    // NOT /allowed (what a C tool would read with the null byte).
    // On macOS, /etc resolves to /private/etc via symlink.
    expect(result.endsWith('/etc/shadow')).toBe(true)
  })

  test('path with only null bytes resolves to cwd', () => {
    const result = resolvePath('\x00\x00\x00')
    expect(result).not.toContain('\x00')
  })
})

describe('sandbox integration — issue #114', () => {
  test('non-existent file under symlinked within path is allowed', () => {
    const rawTmp = tmpdir()
    const sb = _sandbox({ within: [rawTmp] })
    const nonexistent = join(rawTmp, 'edictum-does-not-exist-' + Date.now() + '.txt')
    expect(_checkResult(sb, _fileEnvelope('Read', nonexistent)).passed).toBe(true)
  })

  test('non-existent file outside symlinked within path is denied', () => {
    const rawTmp = tmpdir()
    const sb = _sandbox({ within: [join(rawTmp, 'allowed-subdir')] })
    const nonexistent = join(rawTmp, 'forbidden-subdir', 'file.txt')
    expect(_checkResult(sb, _fileEnvelope('Read', nonexistent)).passed).toBe(false)
  })
})
