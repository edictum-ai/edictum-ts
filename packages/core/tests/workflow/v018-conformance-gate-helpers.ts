import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const V018 = join('fixtures', 'workflow-v0.18')

const MINIMAL_SUITE = [
  'suite: placeholder',
  'fixtures:',
  '  - id: present',
  '    description: nonempty so this named suite is loaded',
  '    workflow: unused',
  '    contract: unused',
  '    envelope:',
  '      tool_name: unused',
  '    expected:',
  '      verdict: allowed',
  '    initial_state: {}',
  '    steps: []',
  '',
].join('\n')

function writeSuite(root: string, filename: string, body: string): void {
  writeFileSync(join(root, V018, filename), body)
}

/** Temp schemas root whose workflow-v0.18 directory exists but is empty. */
export function makeEmptyV018Dir(): string {
  const root = mkdtempSync(join(tmpdir(), 'edictum-v018-empty-'))
  mkdirSync(join(root, V018), { recursive: true })
  return root
}

/** Temp schemas root with no fixtures tree (wrong-ref checkout shape). */
export function makeWrongRefRoot(): string {
  return mkdtempSync(join(tmpdir(), 'edictum-v018-wrongref-'))
}

/** Only one of the four named suite files is present. */
export function makePartialV018Dir(): string {
  const root = mkdtempSync(join(tmpdir(), 'edictum-v018-partial-'))
  mkdirSync(join(root, V018), { recursive: true })
  writeSuite(root, 'wildcard-tools.workflow-v0.18.yaml', MINIMAL_SUITE)
  return root
}

/** All four named files present; extends carries an unknown verdict. */
export function makeUnknownVerdictDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'edictum-v018-verdict-'))
  mkdirSync(join(root, V018), { recursive: true })
  writeSuite(root, 'wildcard-tools.workflow-v0.18.yaml', MINIMAL_SUITE)
  writeSuite(root, 'terminal-stage.workflow-v0.18.yaml', MINIMAL_SUITE)
  writeSuite(root, 'mcp-result-evidence.workflow-v0.18.yaml', MINIMAL_SUITE)
  writeSuite(
    root,
    'extends-inheritance.workflow-v0.18.yaml',
    [
      'suite: extends-inheritance',
      'rulesets: {}',
      'fixtures:',
      '  - id: sab-unknown-verdict',
      '    description: unknown expected.verdict must fail closed',
      '    contract: unused',
      '    envelope:',
      '      tool_name: unused',
      '    expected:',
      '      verdict: not-a-real-verdict',
      '',
    ].join('\n'),
  )
  return root
}
