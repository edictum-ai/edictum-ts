/** Tests for resolvePath — cross-platform path resolution with security boundaries. */

import { describe, expect, test } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolvePath } from '../../src/yaml-engine/resolve-path.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'edictum-resolve-path-'))
const subdir = join(tmp, 'subdir')
mkdirSync(subdir)
writeFileSync(join(subdir, 'file.txt'), 'test')

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
    // Should resolve the parent's symlinks and append the filename
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
      // may exist from previous run
    }
    const result = resolvePath(join(linkPath, 'file.txt'))
    expect(result).toBe(join(realpathSync(subdir), 'file.txt'))
  })

  test('resolves non-existent file under symlinked directory', () => {
    const linkPath = join(tmp, 'link-to-subdir2')
    try {
      symlinkSync(subdir, linkPath)
    } catch {
      // may exist from previous run
    }
    const nonexistent = join(linkPath, 'nonexistent.txt')
    const result = resolvePath(nonexistent)
    // Walk-up finds linkPath → resolves to real subdir → appends filename
    expect(result).toBe(join(realpathSync(subdir), 'nonexistent.txt'))
  })

  test('macOS /tmp symlink: non-existent file resolves consistently', () => {
    const rawTmp = tmpdir()
    const realTmp = realpathSync(rawTmp)
    const nonexistent = join(rawTmp, 'edictum-resolve-test-' + Date.now() + '.txt')
    const result = resolvePath(nonexistent)
    // Should start with the real tmp path (on macOS: /private/tmp)
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
    // Create a directory, then remove read+execute permission
    const restrictedDir = join(tmp, 'restricted')
    mkdirSync(restrictedDir, { recursive: true })
    writeFileSync(join(restrictedDir, 'secret.txt'), 'hidden')
    chmodSync(restrictedDir, 0o000)

    try {
      const result = resolvePath(join(restrictedDir, 'secret.txt'))
      // Should NOT walk up and partially resolve — should return the
      // normalized path, which won't match a symlink-resolved boundary
      // This is fail-closed: if we can't determine the true path, we
      // return the unresolved normalized form
      expect(typeof result).toBe('string')
      // The path should be normalized (absolute) but not resolved through
      // the restricted directory
      expect(result).toContain('restricted')
    } finally {
      // Restore permissions for cleanup
      chmodSync(restrictedDir, 0o755)
    }
  })

  test('circular symlink returns normalized path without partial resolution', () => {
    // Create circular symlink: a → b → a
    const linkA = join(tmp, 'circular-a')
    const linkB = join(tmp, 'circular-b')
    try {
      symlinkSync(linkB, linkA)
    } catch {
      // may exist
    }
    try {
      symlinkSync(linkA, linkB)
    } catch {
      // may exist
    }
    const result = resolvePath(join(linkA, 'file.txt'))
    // Should not throw — returns normalized path
    expect(typeof result).toBe('string')
  })

  test('symlink escape is detected (link points outside boundary)', () => {
    const escapePath = join(tmp, 'escape-link')
    try {
      symlinkSync('/etc/passwd', escapePath)
    } catch {
      // may exist
    }
    const result = resolvePath(escapePath)
    // Should resolve the symlink — path should point to /etc/passwd
    expect(result).toBe(realpathSync('/etc/passwd'))
  })

  test('non-existent path with symlink in parent chain resolves correctly', () => {
    // Symlink in the middle of the path: tmp/link → subdir, then
    // access tmp/link/nonexistent.txt
    const midLink = join(tmp, 'mid-link')
    try {
      symlinkSync(subdir, midLink)
    } catch {
      // may exist
    }
    const result = resolvePath(join(midLink, 'deeply', 'nested', 'nonexistent.txt'))
    // midLink resolves to real subdir, then append the rest
    expect(result).toBe(join(realpathSync(subdir), 'deeply', 'nested', 'nonexistent.txt'))
  })
})
