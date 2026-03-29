import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'vitest'

import { loadWorkflow, loadWorkflowString } from '../../src/index.js'

describe('WorkflowLoad', () => {
  test('parses workflow document', () => {
    const definition = loadWorkflowString(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: core-dev-process
stages:
  - id: read-context
    tools: [Read]
    exit:
      - condition: file_read("specs/008.md")
        message: Read the workflow spec first
`)

    expect(definition.kind).toBe('Workflow')
    expect(definition.stages).toHaveLength(1)
    expect(definition.stages[0]?.id).toBe('read-context')
  })

  test('rejects ruleset kind', () => {
    expect(() =>
      loadWorkflowString(`apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: wrong
stages:
  - id: read-context
`),
    ).toThrow(/kind must be "Workflow"/)
  })

  test('rejects invalid regexes', () => {
    expect(() =>
      loadWorkflowString(`apiVersion: edictum/v1
kind: Workflow
metadata:
  name: invalid-regex
stages:
  - id: verify
    tools: [Bash]
    checks:
      - command_matches: "("
        message: broken
    exit:
      - condition: command_matches("(")
        message: broken gate
`),
    ).toThrow(/invalid regex/)
  })

  test('resolves workflow file paths through realpath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edictum-workflow-'))
    const targetPath = join(dir, 'workflow.yaml')
    const linkPath = join(dir, 'workflow-link.yaml')
    writeFileSync(
      targetPath,
      `apiVersion: edictum/v1
kind: Workflow
metadata:
  name: linked-workflow
stages:
  - id: review
    tools: [Read]
`,
      'utf8',
    )
    symlinkSync(targetPath, linkPath)

    const definition = loadWorkflow(linkPath)
    expect(definition.metadata.name).toBe('linked-workflow')
  })
})
