/**
 * Regression tests for the fail-closed gate of the v0.18 workflow runner.
 * The gate fires at module import, so these spawn the real runner.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  makeEmptyV018Dir,
  makePartialV018Dir,
  makeUnknownVerdictDir,
  makeWrongRefRoot,
} from './v018-conformance-gate-helpers.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE_ROOT = resolve(HERE, '..', '..')
const RUNNER_FILE = 'tests/workflow/workflow-v018-conformance.test.ts'
const require = createRequire(import.meta.url)
const VITEST_ENTRY = require.resolve('vitest/vitest.mjs')

function runRunner(env: Record<string, string>): { status: number | null; output: string } {
  if (!existsSync(VITEST_ENTRY)) {
    throw new Error(`vitest CLI entry not found at ${VITEST_ENTRY}`)
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  delete childEnv.EDICTUM_SCHEMAS_DIR
  delete childEnv.EDICTUM_FIXTURES_DIR
  delete childEnv.EDICTUM_CONFORMANCE_REQUIRED
  Object.assign(childEnv, env)
  const vitestArgs = [VITEST_ENTRY, 'run', '--reporter=verbose', RUNNER_FILE]
  const result = spawnSync(process.execPath, vitestArgs, {
    cwd: CORE_ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 150_000,
  })
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

describe('workflow-v0.18 runner — fail-closed gates', () => {
  it('required mode: empty v0.18 directory fails the run', { timeout: 180_000 }, () => {
    const root = makeEmptyV018Dir()
    try {
      const result = runRunner({ EDICTUM_SCHEMAS_DIR: root, EDICTUM_CONFORMANCE_REQUIRED: '1' })
      expect(result.status, `runner output:\n${result.output}`).not.toBeNull()
      expect(result.status, `runner output:\n${result.output}`).not.toBe(0)
      expect(result.output).toContain('no workflow-v0.18 fixtures were loaded')
      expect(result.output).toContain('empty suites:')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('workflow-v0.18 runner — per-suite and verdict gates', () => {
  it(
    'required mode: one nonempty suite still fails when the other three are empty',
    { timeout: 180_000 },
    () => {
      const root = makePartialV018Dir()
      try {
        const result = runRunner({
          EDICTUM_SCHEMAS_DIR: root,
          EDICTUM_CONFORMANCE_REQUIRED: '1',
        })
        expect(result.status, `runner output:\n${result.output}`).not.toBeNull()
        expect(result.status, `runner output:\n${result.output}`).not.toBe(0)
        expect(result.output).toContain('no workflow-v0.18 fixtures were loaded')
        expect(result.output).toContain('terminal-stage')
        expect(result.output).toContain('extends-inheritance')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it('required mode: unknown extends verdict fails the run', { timeout: 180_000 }, () => {
    const root = makeUnknownVerdictDir()
    try {
      const result = runRunner({ EDICTUM_SCHEMAS_DIR: root, EDICTUM_CONFORMANCE_REQUIRED: '1' })
      expect(result.status, `runner output:\n${result.output}`).not.toBeNull()
      expect(result.status, `runner output:\n${result.output}`).not.toBe(0)
      expect(result.output).toContain('unknown expected verdict')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('required mode: wrong EDICTUM_SCHEMAS_DIR refuses fallthrough', { timeout: 180_000 }, () => {
    const root = makeWrongRefRoot()
    try {
      const result = runRunner({ EDICTUM_SCHEMAS_DIR: root, EDICTUM_CONFORMANCE_REQUIRED: '1' })
      expect(result.status, `runner output:\n${result.output}`).not.toBeNull()
      expect(result.status, `runner output:\n${result.output}`).not.toBe(0)
      expect(result.output).toContain('refusing to fall through')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('optional mode: empty v0.18 directory stays a named skip', { timeout: 180_000 }, () => {
    const root = makeEmptyV018Dir()
    try {
      const result = runRunner({ EDICTUM_SCHEMAS_DIR: root })
      expect(result.status, `runner output:\n${result.output}`).toBe(0)
      expect(result.output).toContain(
        'workflow-v0.18 conformance — edictum-schemas not found or empty',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
