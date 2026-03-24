/**
 * Shared rejection fixture runner — validates the TS loader against the
 * cross-SDK rejection corpus maintained in edictum-schemas.
 *
 * Workspace assumption: edictum-schemas is a sibling checkout at
 * ../edictum-schemas relative to the edictum-ts repo root.
 *
 * Skips entirely when the sibling repo is absent (CI, fresh clones).
 * Runs locally when both repos are checked out side-by-side.
 *
 * Each fixture provides a bundle that must be rejected by the loader, plus
 * an `error_contains` substring that the error message must include.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { loadBundleString } from '../../src/yaml-engine/loader.js'
import { EdictumConfigError } from '../../src/errors.js'

// ---------------------------------------------------------------------------
// Fixture resolution
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Sibling edictum-schemas repo relative to this test file.
 * Path: tests/yaml-engine/ → core/ → packages/ → edictum-ts/ → project/ → edictum-schemas/
 */
const SCHEMAS_REPO = resolve(HERE, '..', '..', '..', '..', '..', 'edictum-schemas')
const FIXTURES_DIR = join(SCHEMAS_REPO, 'fixtures', 'rejection')

interface Fixture {
  id: string
  description: string
  bundle: Record<string, unknown>
  expected: {
    rejected: boolean
    error_contains: string
  }
}

interface FixtureSuite {
  suite: string
  version: number
  description: string
  fixtures: Fixture[]
}

/** Load all .rejection.yaml files from the shared fixtures directory. */
function loadFixtureSuites(): FixtureSuite[] | null {
  if (!existsSync(FIXTURES_DIR)) return null

  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.rejection.yaml'))
    .sort()

  if (files.length === 0) return null

  return files.map((file) => {
    const content = readFileSync(join(FIXTURES_DIR, file), 'utf-8')
    return yaml.load(content) as FixtureSuite
  })
}

// ---------------------------------------------------------------------------
// Runner — skips entirely when edictum-schemas is not a sibling checkout
// ---------------------------------------------------------------------------

const suites = loadFixtureSuites()

describe.skipIf(suites == null)('shared rejection fixtures (edictum-schemas)', () => {
  for (const suite of suites!) {
    describe(suite.suite, () => {
      for (const fixture of suite.fixtures) {
        it(`${fixture.id}: ${fixture.description}`, () => {
          // Re-serialize the bundle to YAML so we exercise the full
          // loadBundleString path (parse + validate).
          const bundleYaml = yaml.dump(fixture.bundle, { lineWidth: -1 })

          let threw = false
          let errorMessage = ''

          try {
            loadBundleString(bundleYaml)
          } catch (err: unknown) {
            threw = true
            expect(err).toBeInstanceOf(EdictumConfigError)
            errorMessage = (err as Error).message
          }

          expect(threw, `Expected fixture ${fixture.id} to throw, but it did not`).toBe(true)

          if (fixture.expected.error_contains) {
            expect(
              errorMessage.toLowerCase(),
              `Fixture ${fixture.id}: error "${errorMessage}" must contain "${fixture.expected.error_contains}"`,
            ).toContain(fixture.expected.error_contains.toLowerCase())
          }
        })
      }
    })
  }
})
