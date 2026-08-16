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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE_ROOT = resolve(HERE, '..', '..')
const RUNNER_FILE = 'tests/yaml-engine/shared-fixtures.test.ts'
const VITEST_BIN = join(CORE_ROOT, 'node_modules', '.bin', 'vitest')

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
  if (!existsSync(VITEST_BIN)) {
    throw new Error(`vitest binary not found at ${VITEST_BIN} — run pnpm install first`)
  }

  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  delete childEnv.EDICTUM_SCHEMAS_DIR
  delete childEnv.EDICTUM_FIXTURES_DIR
  delete childEnv.EDICTUM_CONFORMANCE_REQUIRED
  Object.assign(childEnv, env)

  const result = spawnSync(VITEST_BIN, ['run', RUNNER_FILE], {
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

/** Create a temp schemas root whose rejection directory exists but is empty. */
function makeEmptyRejectionDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'edictum-gate-empty-'))
  mkdirSync(join(root, 'fixtures', 'rejection'), { recursive: true })
  return root
}

/** Create a temp schemas root with no fixtures tree at all (wrong-ref checkout shape). */
function makeWrongRefRoot(): string {
  return mkdtempSync(join(tmpdir(), 'edictum-gate-wrongref-'))
}

/** Create a temp schemas root with one suite file whose fixtures lack expected.rejected. */
function makeMissingExpectationDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'edictum-gate-expect-'))
  mkdirSync(join(root, 'fixtures', 'rejection'), { recursive: true })
  writeFileSync(
    join(root, 'fixtures', 'rejection', 'sabotage.rejection.yaml'),
    [
      'suite: sabotage',
      'description: fixture entry with a misspelled expectation key',
      'fixtures:',
      '  - id: sab-001',
      '    description: expectation key misspelled as rejectd',
      '    bundle: {}',
      '    expected:',
      '      rejectd: true',
      '      error_contains: whatever',
      '',
    ].join('\n'),
  )
  return root
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
        expect(result.output).toContain('skipped')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
