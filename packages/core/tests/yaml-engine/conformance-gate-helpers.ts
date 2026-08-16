import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Temp schemas root whose rejection directory exists but is empty. */
export function makeEmptyRejectionDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'edictum-gate-empty-'))
  mkdirSync(join(root, 'fixtures', 'rejection'), { recursive: true })
  return root
}

/** Temp schemas root with no fixtures tree (wrong-ref checkout shape). */
export function makeWrongRefRoot(): string {
  return mkdtempSync(join(tmpdir(), 'edictum-gate-wrongref-'))
}

/** Create a temp schemas root with one suite file whose fixtures lack expected.rejected. */
export function makeMissingExpectationDir(): string {
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
