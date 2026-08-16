/**
 * Shared rejection fixture runner — validates the TS loader against the
 * cross-SDK rejection corpus maintained in edictum-schemas.
 *
 * Fixture discovery (first match wins):
 *   1. EDICTUM_SCHEMAS_DIR env var (root of edictum-schemas repo). A relative
 *      value is resolved against cwd and then the repo root, so
 *      a relative edictum-schemas value still works when core tests run
 *      with cwd packages/core.
 *   2. <repo-root>/edictum-schemas/ (monorepo / vendored checkout)
 *   3. <repo-root>/../edictum-schemas/ (sibling checkout)
 *
 * EDICTUM_FIXTURES_DIR is no longer read: it once meant the fixtures root
 * here and the rejection/ subdirectory in other runners, so one name
 * silently selected different directories per SDK.
 *
 * Missing-fixture behavior — gated on the LOADED fixture list, not on the
 * directory existing:
 *   - EDICTUM_CONFORMANCE_REQUIRED=1 with zero loadable fixtures (missing
 *     directory, empty directory, or files carrying no fixtures) → fail
 *     the test run
 *   - Otherwise → skip the suite cleanly (a named skip, never a pass)
 *
 * Each fixture provides a bundle that must be rejected by the loader, plus
 * an `error_contains` substring that the error message must include. A
 * fixture entry whose `expected.rejected` is absent or not a boolean is a
 * hard failure at load time: a missing or misspelled expectation must
 * never silently invert into "must load successfully".
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

const FALLBACK_REJECTION_DIRS = [
  join(REPO_ROOT, 'edictum-schemas', REJECTION_SUBPATH),
  resolve(REPO_ROOT, '..', 'edictum-schemas', REJECTION_SUBPATH),
]

function firstExisting(paths: readonly string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return null
}

function envRejectionCandidates(schemasEnv: string): string[] {
  const fromCwd = resolve(process.cwd(), schemasEnv, REJECTION_SUBPATH)
  const fromRoot = resolve(REPO_ROOT, schemasEnv, REJECTION_SUBPATH)
  return fromCwd === fromRoot ? [fromCwd] : [fromCwd, fromRoot]
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

function normalizeFixtureBundle(bundle: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>
  if (cloned.kind === 'ContractBundle') {
    cloned.kind = 'Ruleset'
  }
  if ('contracts' in cloned && !('rules' in cloned)) {
    cloned.rules = normalizeRules(cloned.contracts)
    delete cloned.contracts
  } else if ('rules' in cloned) {
    cloned.rules = normalizeRules(cloned.rules)
  }
  return cloned
}

function normalizeRules(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value
  }
  return value.map((rule) => normalizeRule(rule))
}

function normalizeRule(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }
  const rule = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  if (rule.then != null && typeof rule.then === 'object' && !Array.isArray(rule.then)) {
    const then = rule.then as Record<string, unknown>
    if ('effect' in then && !('action' in then)) {
      const effect = then.effect
      then.action = effect === 'deny' ? 'block' : effect === 'approve' ? 'ask' : effect
      delete then.effect
    }
  }
  return rule
}

function normalizeExpectedErrorSubstring(value: string): string {
  if (value === 'contracts') {
    return 'rules'
  }
  if (value === 'effect') {
    return 'action'
  }
  return value
}

function loadFixtureSuites(dir: string): FixtureSuite[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.rejection.yaml'))
    .sort()

  // An empty directory is returned as zero suites — the required-mode gate
  // below rejects on the loaded fixture count, so an empty checkout fails
  // instead of silently skipping.
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

    const suite = parsed as FixtureSuite
    for (const fixture of suite.fixtures) {
      const expected = fixture?.expected as { rejected?: unknown } | undefined
      if (expected == null || typeof expected.rejected !== 'boolean') {
        throw new Error(
          `Fixture file ${file}: fixture ${fixture?.id ?? '(missing id)'} is missing a boolean ` +
            `expected.rejected — a missing or misspelled expectation must fail the suite, ` +
            `not silently invert the assertion into "must load successfully"`,
        )
      }
    }
    return suite
  })
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const schemasEnv = process.env.EDICTUM_SCHEMAS_DIR
const envCandidates = schemasEnv ? envRejectionCandidates(schemasEnv) : []
const envHit = firstExisting(envCandidates)
const fallbackHit = firstExisting(FALLBACK_REJECTION_DIRS)
const triedPaths = [...envCandidates, ...FALLBACK_REJECTION_DIRS]
const conformanceRequired = process.env.EDICTUM_CONFORMANCE_REQUIRED === '1'

// An explicitly-set EDICTUM_SCHEMAS_DIR that does not resolve is never
// silently stepped over (contract C5): a wrong pin or truncated checkout
// must fail in required mode rather than quietly load whatever
// nested/sibling directory happens to exist. Relative values are tried
// from cwd and from the repo root before this refusal.
if (schemasEnv && !envHit) {
  if (conformanceRequired) {
    throw new Error(
      'EDICTUM_SCHEMAS_DIR is set to "' +
        schemasEnv +
      '" but none of the resolved ' +
        REJECTION_SUBPATH +
      ' directories exist — refusing to fall through to ' +
      'repo-relative discovery. Tried: ' +
      envCandidates.join(', ') +
      '. Fix the schemas checkout or unset the variable.',
    )
  }
  console.warn(
    '[edictum] EDICTUM_SCHEMAS_DIR="' +
      schemasEnv +
      '" has no ' +
      REJECTION_SUBPATH +
      ' at tried paths [' +
      envCandidates.join(', ') +
      ']; falling back to repo-relative discovery.',
  )
}

const fixturesDir = envHit ?? fallbackHit
const suites = fixturesDir ? loadFixtureSuites(fixturesDir) : null
const loadedFixtures = suites?.reduce((count, suite) => count + suite.fixtures.length, 0) ?? 0

// Required-mode gate on the loaded fixture list, not on the directory: a
// resolved-but-empty directory (truncated checkout, wrong ref, moved
// corpus) is a hard failure, never a green skip.
if (conformanceRequired && loadedFixtures === 0) {
  const alreadySet = schemasEnv
    ? 'EDICTUM_SCHEMAS_DIR is already set to "' + schemasEnv + '"'
    : 'Set EDICTUM_SCHEMAS_DIR or check out edictum-schemas as a sibling'
  throw new Error(
    'EDICTUM_CONFORMANCE_REQUIRED=1 but zero rejection fixtures were loaded' +
      (fixturesDir ? ' from ' + fixturesDir : ' — no rejection fixtures directory was found') +
      '. Tried: ' + triedPaths.join(', ') + '. ' + alreadySet + '.',
  )
}

if (suites && loadedFixtures > 0) {
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
            const bundleYaml = yaml.dump(normalizeFixtureBundle(fixture.bundle), { lineWidth: -1 })

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
              const expectedErrorSubstring = normalizeExpectedErrorSubstring(
                fixture.expected.error_contains,
              )
              expect(
                errorMessage.toLowerCase(),
                `Fixture ${fixture.id}: error "${errorMessage}" must contain "${fixture.expected.error_contains}"`,
              ).toContain(expectedErrorSubstring.toLowerCase())
            }
          })
        }
      })
    }
  })
} else {
  it.skip('shared rejection fixtures — edictum-schemas not found or empty (optional mode)', () => {})
}
