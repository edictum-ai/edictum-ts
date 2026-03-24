/**
 * Shared rejection fixture runner — validates the TS loader against the
 * cross-SDK rejection corpus maintained in edictum-schemas.
 *
 * Fixture discovery (first match wins):
 *   1. EDICTUM_FIXTURES_DIR env var (direct path to rejection/ directory)
 *   2. EDICTUM_SCHEMAS_DIR env var (root of edictum-schemas repo)
 *   3. <repo-root>/edictum-schemas/ (monorepo / vendored checkout)
 *   4. <repo-root>/../edictum-schemas/ (sibling checkout)
 *
 * Missing-fixture behavior:
 *   - EDICTUM_CONFORMANCE_REQUIRED=1 → fail the test run
 *   - Otherwise → skip the suite cleanly
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
// Fixture discovery
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
const REJECTION_SUBPATH = join('fixtures', 'rejection')

/** Resolve the rejection fixtures directory using the discovery order. */
function resolveFixturesDir(): string | null {
  // 1. Direct path via env var
  const fixturesEnv = process.env.EDICTUM_FIXTURES_DIR
  if (fixturesEnv && existsSync(fixturesEnv)) return fixturesEnv

  // 2. Schemas repo root via env var
  const schemasEnv = process.env.EDICTUM_SCHEMAS_DIR
  if (schemasEnv) {
    const candidate = join(schemasEnv, REJECTION_SUBPATH)
    if (existsSync(candidate)) return candidate
  }

  // 3. Nested inside repo root (monorepo / vendored)
  const nested = join(REPO_ROOT, 'edictum-schemas', REJECTION_SUBPATH)
  if (existsSync(nested)) return nested

  // 4. Sibling checkout
  const sibling = resolve(REPO_ROOT, '..', 'edictum-schemas', REJECTION_SUBPATH)
  if (existsSync(sibling)) return sibling

  return null
}

// ---------------------------------------------------------------------------
// Fixture types and loader
// ---------------------------------------------------------------------------

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

function loadFixtureSuites(dir: string): FixtureSuite[] | null {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.rejection.yaml'))
    .sort()

  if (files.length === 0) return null

  return files.map((file) => {
    const content = readFileSync(join(dir, file), 'utf-8')

    // CORE_SCHEMA blocks unsafe JS tags (!!js/function, !!js/regexp)
    // while supporting all standard YAML types needed by fixtures.
    let parsed: unknown
    try {
      parsed = yaml.load(content, { schema: yaml.CORE_SCHEMA })
    } catch (e) {
      throw new Error(`Failed to parse fixture file ${file}: ${String(e)}`)
    }

    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as Record<string, unknown>).fixtures)
    ) {
      throw new Error(`Fixture file ${file} is missing a 'fixtures' array`)
    }

    return parsed as FixtureSuite
  })
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const fixturesDir = resolveFixturesDir()
const conformanceRequired = process.env.EDICTUM_CONFORMANCE_REQUIRED === '1'

if (!fixturesDir && conformanceRequired) {
  throw new Error(
    'EDICTUM_CONFORMANCE_REQUIRED=1 but no rejection fixtures found. ' +
      'Set EDICTUM_FIXTURES_DIR or EDICTUM_SCHEMAS_DIR, or check out edictum-schemas as a sibling.',
  )
}

const suites = fixturesDir ? loadFixtureSuites(fixturesDir) : null

if (suites) {
  describe('shared rejection fixtures (edictum-schemas)', () => {
    for (const suite of suites) {
      if (!Array.isArray(suite.fixtures)) {
        it(`${suite.suite ?? '(unnamed)'} — malformed fixture file`, () => {
          throw new Error(`Suite "${suite.suite}" has no iterable fixtures array`)
        })
        continue
      }

      describe(suite.suite, () => {
        for (const fixture of suite.fixtures) {
          it(`${fixture.id}: ${fixture.description}`, () => {
            const bundleYaml = yaml.dump(fixture.bundle, { lineWidth: -1 })

            if (!fixture.expected.rejected) {
              expect(() => loadBundleString(bundleYaml)).not.toThrow()
              return
            }

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

            // Empty string means no message constraint — skip substring check.
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
} else {
  it.skip('shared rejection fixtures — edictum-schemas not found', () => {})
}
