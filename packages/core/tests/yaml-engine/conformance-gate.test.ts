/**
 * Regression tests for the fail-closed behavior of the shared rejection
 * fixture runner (shared-fixtures.test.ts).
 *
 * The runner's discovery and required-mode gate execute at module import,
 * so these checks cannot live inside the runner itself. Each test spawns
 * the real test runner as a child process against a temporary fixtures
 * tree and asserts on the exit status AND the specific rejection reason in
 * the output — a non-zero exit alone would also pass on any unrelated
 * crash.
 *
 * With the fail-closed behavior reverted (empty directory → silent skip;
 * missing expected.rejected → inverted assertion), the children exit 0 and
 * these tests go red.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  makeEmptyRejectionDir,
  makeMissingExpectationDir,
  makeWrongRefRoot,
} from './conformance-gate-helpers.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE_ROOT = resolve(HERE, '..', '..')
const RUNNER_FILE = 'tests/yaml-engine/shared-fixtures.test.ts'
const REPO_ROOT = resolve(CORE_ROOT, '..', '..')
const VITEST_ENTRY = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'))

interface RunnerResult {
  status: number | null
  output: string
}

/**
 * Run the real runner file under vitest with the conformance environment
 * fully controlled by the caller — inherited EDICTUM_* variables are
 * stripped so a parent conformance run cannot leak into the child.
 */
function runRunner(env: Record<string, string>): RunnerResult {
  if (!existsSync(VITEST_ENTRY)) {
    throw new Error(`vitest CLI entry not found at ${VITEST_ENTRY} — run pnpm install first`)
  }

  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  delete childEnv.EDICTUM_SCHEMAS_DIR
  delete childEnv.EDICTUM_FIXTURES_DIR
  delete childEnv.EDICTUM_CONFORMANCE_REQUIRED
  Object.assign(childEnv, env)

  const result = spawnSync(process.execPath, [VITEST_ENTRY, 'run', RUNNER_FILE], {
    cwd: CORE_ROOT,
    env: childEnv,
    encoding: 'utf8',
    // Headroom inside the 180 s vitest test timeout: a child killed at its
    // own deadline reports status null, which must fail every assertion
    // below rather than satisfy `not.toBe(0)`.
    timeout: 150_000,
  })

  return {
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  }
}

describe('shared rejection runner — fail-closed gates', () => {
  it(
    'required mode: empty rejection directory fails the run (not a silent skip)',
    { timeout: 180_000 },
    () => {
      const root = makeEmptyRejectionDir()
      try {
        const result = runRunner({
          EDICTUM_SCHEMAS_DIR: root,
          EDICTUM_CONFORMANCE_REQUIRED: '1',
        })
        expect(result.status, `runner output:\n${result.output}`).not.toBeNull()
        expect(result.status, `runner output:\n${result.output}`).not.toBe(0)
        expect(result.output).toContain('zero rejection fixtures were loaded')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it(
    'required mode: EDICTUM_SCHEMAS_DIR set but wrong fails instead of falling through to other discoveries',
    { timeout: 180_000 },
    () => {
      const root = makeWrongRefRoot()
      try {
        const result = runRunner({
          EDICTUM_SCHEMAS_DIR: root,
          EDICTUM_CONFORMANCE_REQUIRED: '1',
        })
        expect(result.status, `runner output:\n${result.output}`).not.toBeNull()
        expect(result.status, `runner output:\n${result.output}`).not.toBe(0)
        expect(result.output).toContain('refusing to fall through')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it(
    'required mode: fixture missing expected.rejected fails the run (not an inverted assertion)',
    { timeout: 180_000 },
    () => {
      const root = makeMissingExpectationDir()
      try {
        const result = runRunner({
          EDICTUM_SCHEMAS_DIR: root,
          EDICTUM_CONFORMANCE_REQUIRED: '1',
        })
        expect(result.status, `runner output:\n${result.output}`).not.toBeNull()
        expect(result.status, `runner output:\n${result.output}`).not.toBe(0)
        expect(result.output).toContain('missing a boolean expected.rejected')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it(
    'optional mode: empty rejection directory stays a named skip, not a failure',
    { timeout: 180_000 },
    () => {
      const root = makeEmptyRejectionDir()
      try {
        const result = runRunner({ EDICTUM_SCHEMAS_DIR: root })
        expect(result.status, `runner output:\n${result.output}`).toBe(0)
        expect(result.output).toContain('edictum-schemas not found or empty (optional mode)')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it(
    'required mode: relative EDICTUM_SCHEMAS_DIR resolves from repo root, not only cwd',
    { timeout: 180_000 },
    () => {
      const root = makeEmptyRejectionDir()
      try {
        const rel = relative(REPO_ROOT, root)
        const result = runRunner({
          EDICTUM_SCHEMAS_DIR: rel,
          EDICTUM_CONFORMANCE_REQUIRED: '1',
        })
        expect(result.status, `runner output:\n${result.output}`).not.toBeNull()
        expect(result.status, `runner output:\n${result.output}`).not.toBe(0)
        expect(result.output).toContain('zero rejection fixtures were loaded')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it(
    'required mode: relative EDICTUM_SCHEMAS_DIR that misses cwd and repo root refuses fallthrough',
    { timeout: 180_000 },
    () => {
      const result = runRunner({
        EDICTUM_SCHEMAS_DIR: 'definitely-not-a-schemas-checkout-xyz',
        EDICTUM_CONFORMANCE_REQUIRED: '1',
      })
      expect(result.status, `runner output:\n${result.output}`).not.toBeNull()
      expect(result.status, `runner output:\n${result.output}`).not.toBe(0)
      expect(result.output).toContain('refusing to fall through')
      expect(result.output).toContain('Tried:')
    },
  )

  it(
    'optional mode: wrong EDICTUM_SCHEMAS_DIR warns and falls back instead of failing',
    { timeout: 180_000 },
    () => {
      const root = makeWrongRefRoot()
      try {
        const result = runRunner({ EDICTUM_SCHEMAS_DIR: root })
        expect(result.status, `runner output:\n${result.output}`).toBe(0)
        expect(result.output).toContain('falling back to repo-relative discovery')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
