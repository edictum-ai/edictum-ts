import { describe, expect, test } from 'vitest'

import { loadWorkflowString } from '../../src/index.js'

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
})
