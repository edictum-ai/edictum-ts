/**
 * Schema constraint tests — session/sandbox structure, metadata.name pattern,
 * rule ID pattern, message length, expression shapes, operator types,
 * additionalProperties, tool side_effect enum.
 *
 * See also: loader-schema-parity.test.ts for required fields, type/id
 * validation, and effect enum tests.
 */

import { describe, expect, test } from 'vitest'

import {
  loadBundleString,
  validateContractFields,
  validateExpressionShapes,
} from '../../src/yaml-engine/index.js'
import { EdictumConfigError } from '../../src/errors.js'

// ---------------------------------------------------------------------------
// Helpers (same as loader-schema-parity.test.ts)
// ---------------------------------------------------------------------------

const VALID_PRE = `
  - id: c1
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"
`

function bundle(
  opts: {
    metadata?: string
    defaults?: string
    rules?: string
    extra?: string
  } = {},
): string {
  return [
    'apiVersion: edictum/v1',
    'kind: Ruleset',
    opts.metadata ?? 'metadata:\n  name: test-bundle',
    opts.defaults ?? 'defaults:\n  mode: enforce',
    'rules:',
    opts.rules ?? VALID_PRE,
    opts.extra ?? '',
  ].join('\n')
}

function expectReject(yaml: string, pattern?: RegExp): void {
  expect(() => loadBundleString(yaml)).toThrow(EdictumConfigError)
  if (pattern) expect(() => loadBundleString(yaml)).toThrow(pattern)
}

// =========================================================================
// Session rule required fields
// =========================================================================

describe('session rule validation', () => {
  test('missing limits rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: sess-no-limits
    type: session
    then:
      action: block
      message: "limit exceeded"`,
      }),
      /limits/,
    )
  })

  test('empty limits object rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: sess-empty-limits
    type: session
    limits: {}
    then:
      action: block
      message: "limit exceeded"`,
      }),
      /limits/,
    )
  })

  test('missing then rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: sess-no-then
    type: session
    limits:
      max_tool_calls: 10`,
      }),
      /then/,
    )
  })

  test('action "warn" rejected (session must be block)', () => {
    expectReject(
      bundle({
        rules: `
  - id: sess-warn
    type: session
    limits:
      max_tool_calls: 10
    then:
      action: warn
      message: "limit exceeded"`,
      }),
      /action/,
    )
  })

  test('missing then.message rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: sess-no-msg
    type: session
    limits:
      max_tool_calls: 10
    then:
      action: block`,
      }),
      /message/,
    )
  })

  test('valid session rule accepted', () => {
    expect(() =>
      loadBundleString(
        bundle({
          rules: `
  - id: sess-ok
    type: session
    limits:
      max_tool_calls: 10
    then:
      action: block
      message: "limit exceeded"`,
        }),
      ),
    ).not.toThrow()
  })
})

// =========================================================================
// Sandbox rule structure
// =========================================================================

describe('sandbox rule structure', () => {
  test('missing both tool and tools rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: sb-no-tool
    type: sandbox
    within: ["/tmp"]
    message: "sandbox denied"`,
      }),
      /tool/,
    )
  })

  test('missing both within and allows rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: sb-no-boundary
    type: sandbox
    tool: "Bash"
    message: "sandbox denied"`,
      }),
      /within.*allows|allows.*within/,
    )
  })

  test('missing message rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: sb-no-msg
    type: sandbox
    tool: "Bash"
    within: ["/tmp"]`,
      }),
      /message/,
    )
  })

  test('valid sandbox with tool + within accepted', () => {
    expect(() =>
      loadBundleString(
        bundle({
          rules: `
  - id: sb-ok
    type: sandbox
    tool: "Bash"
    within: ["/tmp"]
    message: "sandbox denied"`,
        }),
      ),
    ).not.toThrow()
  })

  test('valid sandbox with tools + allows accepted', () => {
    expect(() =>
      loadBundleString(
        bundle({
          rules: `
  - id: sb-ok-2
    type: sandbox
    tools: ["Bash", "Execute"]
    allows:
      commands: ["ls", "cat"]
    message: "sandbox denied"`,
        }),
      ),
    ).not.toThrow()
  })

  test('sandbox with tools: [] rejected (minItems: 1)', () => {
    expectReject(
      bundle({
        rules: `
  - id: sb-empty-tools
    type: sandbox
    tools: []
    within: ["/tmp"]
    message: "sandbox denied"`,
      }),
      /non-empty array/,
    )
  })

  test('sandbox with non-string tool rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: sb-num-tool
    type: sandbox
    tool: 42
    within: ["/tmp"]
    message: "sandbox denied"`,
      }),
      /tool.*string/,
    )
  })

  test('sandbox with within: [] rejected (minItems: 1)', () => {
    expectReject(
      bundle({
        rules: `
  - id: sb-empty-within
    type: sandbox
    tool: "Bash"
    within: []
    message: "sandbox denied"`,
      }),
      /non-empty array/,
    )
  })
})

// =========================================================================
// Value constraints (handwritten, matching Go approach)
// =========================================================================

describe('metadata.name pattern', () => {
  test('uppercase metadata name rejected', () => {
    expectReject(bundle({ metadata: 'metadata:\n  name: INVALID-NAME' }), /metadata\.name/)
  })

  test('metadata name with spaces rejected', () => {
    expectReject(bundle({ metadata: 'metadata:\n  name: "has space"' }), /metadata\.name/)
  })

  test('missing metadata.name rejected', () => {
    expectReject(bundle({ metadata: 'metadata:\n  description: "no name"' }), /metadata\.name/)
  })
})

describe('rule id pattern', () => {
  test('uppercase rule id rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: UPPER-CASE
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"`,
      }),
      /Rule id/i,
    )
  })

  test('rule id with dots rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: has.dot
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"`,
      }),
      /Rule id/i,
    )
  })
})

describe('message constraints', () => {
  test('message longer than 500 chars rejected', () => {
    const longMsg = 'x'.repeat(501)
    expectReject(
      bundle({
        rules: `
  - id: long-msg
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "${longMsg}"`,
      }),
      /500/,
    )
  })
})

describe('expression shape constraints', () => {
  test('empty all array rejected (minItems: 1)', () => {
    expectReject(
      bundle({
        rules: `
  - id: empty-all
    type: pre
    tool: "*"
    when:
      all: []
    then:
      action: block
      message: "denied"`,
      }),
      /all/,
    )
  })

  test('empty any array rejected (minItems: 1)', () => {
    expectReject(
      bundle({
        rules: `
  - id: empty-any
    type: pre
    tool: "*"
    when:
      any: []
    then:
      action: block
      message: "denied"`,
      }),
      /any/,
    )
  })
})

describe('operator type constraints', () => {
  test('gt with string value rejected (must be number)', () => {
    expectReject(
      bundle({
        rules: `
  - id: gt-string
    type: pre
    tool: "*"
    when:
      args.count: { gt: "five" }
    then:
      action: block
      message: "denied"`,
      }),
      /number/,
    )
  })

  test('contains with number value rejected (must be string)', () => {
    expectReject(
      bundle({
        rules: `
  - id: contains-num
    type: pre
    tool: "*"
    when:
      args.path: { contains: 42 }
    then:
      action: block
      message: "denied"`,
      }),
      /string/,
    )
  })

  test('in with empty array rejected (minItems: 1)', () => {
    expectReject(
      bundle({
        rules: `
  - id: in-empty
    type: pre
    tool: "*"
    when:
      args.x: { in: [] }
    then:
      action: block
      message: "denied"`,
      }),
      /non-empty array/,
    )
  })
})

describe('additionalProperties false', () => {
  test('unknown top-level field rejected', () => {
    expectReject(bundle({ extra: 'unknown_field: true' }), /unknown top-level field/)
  })
})

describe('tool side_effect enum', () => {
  test('invalid side_effect value rejected', () => {
    expectReject(
      bundle({
        extra: `tools:\n  my_tool:\n    side_effect: dangerous`,
      }),
      /side_effect/,
    )
  })

  test('tool entry without side_effect rejected', () => {
    expectReject(bundle({ extra: 'tools:\n  my_tool: {}' }), /side_effect/)
  })
})

// =========================================================================
// Adversarial: null/non-object rule elements
// =========================================================================

describe('null rule elements', () => {
  test('null rule element throws EdictumConfigError', () => {
    expectReject(
      bundle({
        rules: `
  -
  - id: c1
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"`,
      }),
      /rule must be an object/,
    )
  })
})

describe('message type validation', () => {
  test('non-string message (number) rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: num-msg
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: 42`,
      }),
      /message must be a string/,
    )
  })
})

describe('null tool entry', () => {
  test('null tool entry rejected', () => {
    expectReject(bundle({ extra: 'tools:\n  my_tool:' }), /tools\.my_tool/)
  })
})

describe('tools as array rejected', () => {
  test('tools as YAML sequence rejected', () => {
    expectReject(bundle({ extra: 'tools:\n  - side_effect: read' }), /tools.*mapping|tools.*array/)
  })
})

describe('expression not: null/array rejected', () => {
  test('not: null rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: not-null
    type: pre
    tool: "*"
    when:
      not: null
    then:
      action: block
      message: "denied"`,
      }),
      /not/,
    )
  })

  test('not: [] rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: not-array
    type: pre
    tool: "*"
    when:
      not: []
    then:
      action: block
      message: "denied"`,
      }),
      /not/,
    )
  })
})

describe('expression depth limit', () => {
  test('deeply nested expression throws EdictumConfigError', () => {
    // Build a deeply nested expression object programmatically
    // (YAML flow syntax may not reliably parse at extreme depths)
    let expr: Record<string, unknown> = { 'args.x': { equals: 'x' } }
    for (let i = 0; i < 60; i++) expr = { not: expr }
    const data = {
      rules: [
        { id: 'deep', type: 'pre', tool: '*', when: expr, then: { action: 'block', message: 'x' } },
      ],
    }
    expect(() => validateExpressionShapes(data)).toThrow(EdictumConfigError)
    expect(() => validateExpressionShapes(data)).toThrow(/depth/)
  })
})

// =========================================================================
// Positive parity: valid bundles that both Python and TS accept
// =========================================================================

describe('valid bundle shapes accepted', () => {
  test('minimal valid pre rule', () => {
    expect(() => loadBundleString(bundle())).not.toThrow()
  })

  test('valid post rule with redact effect', () => {
    expect(() =>
      loadBundleString(
        bundle({
          rules: `
  - id: redact-secrets
    type: post
    tool: "*"
    when:
      output.text: { matches: "[Aa][Pp][Ii].?[Kk][Ee][Yy]" }
    then:
      action: redact
      message: "Redacted sensitive output"`,
        }),
      ),
    ).not.toThrow()
  })

  test('valid bundle with observe mode default', () => {
    expect(() =>
      loadBundleString(
        bundle({
          defaults: 'defaults:\n  mode: observe',
        }),
      ),
    ).not.toThrow()
  })

  test('valid bundle with tools section', () => {
    expect(() =>
      loadBundleString(
        bundle({
          extra: 'tools:\n  my_tool:\n    side_effect: write',
        }),
      ),
    ).not.toThrow()
  })
})

// =========================================================================
// validateContractFields direct unit tests
// =========================================================================

describe('validateContractFields direct', () => {
  test('rejects metadata as null', () => {
    expect(() =>
      validateContractFields({
        apiVersion: 'edictum/v1',
        kind: 'Ruleset',
        metadata: null,
        defaults: { mode: 'enforce' },
        rules: [
          { id: 'c1', type: 'pre', tool: '*', when: {}, then: { action: 'block', message: 'x' } },
        ],
      }),
    ).toThrow(EdictumConfigError)
  })

  test('rejects defaults as null', () => {
    expect(() =>
      validateContractFields({
        apiVersion: 'edictum/v1',
        kind: 'Ruleset',
        metadata: { name: 'test' },
        defaults: null,
        rules: [
          { id: 'c1', type: 'pre', tool: '*', when: {}, then: { action: 'block', message: 'x' } },
        ],
      }),
    ).toThrow(EdictumConfigError)
  })

  test('rejects non-string rule id', () => {
    expect(() =>
      validateContractFields({
        apiVersion: 'edictum/v1',
        kind: 'Ruleset',
        metadata: { name: 'test' },
        defaults: { mode: 'enforce' },
        rules: [
          { id: 42, type: 'pre', tool: '*', when: {}, then: { action: 'block', message: 'x' } },
        ],
      }),
    ).toThrow(EdictumConfigError)
  })
})
