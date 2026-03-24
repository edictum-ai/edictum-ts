/**
 * Schema constraint tests — session/sandbox structure, metadata.name pattern,
 * contract ID pattern, message length, expression shapes, operator types,
 * additionalProperties, tool side_effect enum.
 *
 * See also: loader-schema-parity.test.ts for required fields, type/id
 * validation, and effect enum tests.
 */

import { describe, expect, test } from 'vitest'

import { loadBundleString, validateContractFields } from '../../src/yaml-engine/index.js'
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
      effect: deny
      message: "denied"
`

function bundle(
  opts: {
    metadata?: string
    defaults?: string
    contracts?: string
    extra?: string
  } = {},
): string {
  return [
    'apiVersion: edictum/v1',
    'kind: ContractBundle',
    opts.metadata ?? 'metadata:\n  name: test-bundle',
    opts.defaults ?? 'defaults:\n  mode: enforce',
    'contracts:',
    opts.contracts ?? VALID_PRE,
    opts.extra ?? '',
  ].join('\n')
}

function expectReject(yaml: string, pattern?: RegExp): void {
  expect(() => loadBundleString(yaml)).toThrow(EdictumConfigError)
  if (pattern) expect(() => loadBundleString(yaml)).toThrow(pattern)
}

// =========================================================================
// Session contract required fields
// =========================================================================

describe('session contract validation', () => {
  test('missing limits rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: sess-no-limits
    type: session
    then:
      effect: deny
      message: "limit exceeded"`,
      }),
      /limits/,
    )
  })

  test('empty limits object rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: sess-empty-limits
    type: session
    limits: {}
    then:
      effect: deny
      message: "limit exceeded"`,
      }),
      /limits/,
    )
  })

  test('missing then rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: sess-no-then
    type: session
    limits:
      max_tool_calls: 10`,
      }),
      /then/,
    )
  })

  test('effect "warn" rejected (session must be deny)', () => {
    expectReject(
      bundle({
        contracts: `
  - id: sess-warn
    type: session
    limits:
      max_tool_calls: 10
    then:
      effect: warn
      message: "limit exceeded"`,
      }),
      /effect/,
    )
  })

  test('missing then.message rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: sess-no-msg
    type: session
    limits:
      max_tool_calls: 10
    then:
      effect: deny`,
      }),
      /message/,
    )
  })

  test('valid session contract accepted', () => {
    expect(() =>
      loadBundleString(
        bundle({
          contracts: `
  - id: sess-ok
    type: session
    limits:
      max_tool_calls: 10
    then:
      effect: deny
      message: "limit exceeded"`,
        }),
      ),
    ).not.toThrow()
  })
})

// =========================================================================
// Sandbox contract structure
// =========================================================================

describe('sandbox contract structure', () => {
  test('missing both tool and tools rejected', () => {
    expectReject(
      bundle({
        contracts: `
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
        contracts: `
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
        contracts: `
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
          contracts: `
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
          contracts: `
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

describe('contract id pattern', () => {
  test('uppercase contract id rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: UPPER-CASE
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "denied"`,
      }),
      /Contract id/i,
    )
  })

  test('contract id with dots rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: has.dot
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "denied"`,
      }),
      /Contract id/i,
    )
  })
})

describe('message constraints', () => {
  test('message longer than 500 chars rejected', () => {
    const longMsg = 'x'.repeat(501)
    expectReject(
      bundle({
        contracts: `
  - id: long-msg
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
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
        contracts: `
  - id: empty-all
    type: pre
    tool: "*"
    when:
      all: []
    then:
      effect: deny
      message: "denied"`,
      }),
      /all/,
    )
  })

  test('empty any array rejected (minItems: 1)', () => {
    expectReject(
      bundle({
        contracts: `
  - id: empty-any
    type: pre
    tool: "*"
    when:
      any: []
    then:
      effect: deny
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
        contracts: `
  - id: gt-string
    type: pre
    tool: "*"
    when:
      args.count: { gt: "five" }
    then:
      effect: deny
      message: "denied"`,
      }),
      /number/,
    )
  })

  test('contains with number value rejected (must be string)', () => {
    expectReject(
      bundle({
        contracts: `
  - id: contains-num
    type: pre
    tool: "*"
    when:
      args.path: { contains: 42 }
    then:
      effect: deny
      message: "denied"`,
      }),
      /string/,
    )
  })

  test('in with empty array rejected (minItems: 1)', () => {
    expectReject(
      bundle({
        contracts: `
  - id: in-empty
    type: pre
    tool: "*"
    when:
      args.x: { in: [] }
    then:
      effect: deny
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
// Adversarial: null/non-object contract elements
// =========================================================================

describe('null contract elements', () => {
  test('null contract element throws EdictumConfigError', () => {
    expectReject(
      bundle({
        contracts: `
  -
  - id: c1
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "denied"`,
      }),
      /contract must be an object/,
    )
  })
})

// =========================================================================
// Positive parity: valid bundles that both Python and TS accept
// =========================================================================

describe('valid bundle shapes accepted', () => {
  test('minimal valid pre contract', () => {
    expect(() => loadBundleString(bundle())).not.toThrow()
  })

  test('valid post contract with redact effect', () => {
    expect(() =>
      loadBundleString(
        bundle({
          contracts: `
  - id: redact-secrets
    type: post
    tool: "*"
    when:
      output.text: { matches: "[Aa][Pp][Ii].?[Kk][Ee][Yy]" }
    then:
      effect: redact
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
        kind: 'ContractBundle',
        metadata: null,
        defaults: { mode: 'enforce' },
        contracts: [
          { id: 'c1', type: 'pre', tool: '*', when: {}, then: { effect: 'deny', message: 'x' } },
        ],
      }),
    ).toThrow(EdictumConfigError)
  })

  test('rejects defaults as null', () => {
    expect(() =>
      validateContractFields({
        apiVersion: 'edictum/v1',
        kind: 'ContractBundle',
        metadata: { name: 'test' },
        defaults: null,
        contracts: [
          { id: 'c1', type: 'pre', tool: '*', when: {}, then: { effect: 'deny', message: 'x' } },
        ],
      }),
    ).toThrow(EdictumConfigError)
  })

  test('rejects non-string contract id', () => {
    expect(() =>
      validateContractFields({
        apiVersion: 'edictum/v1',
        kind: 'ContractBundle',
        metadata: { name: 'test' },
        defaults: { mode: 'enforce' },
        contracts: [
          { id: 42, type: 'pre', tool: '*', when: {}, then: { effect: 'deny', message: 'x' } },
        ],
      }),
    ).toThrow(EdictumConfigError)
  })
})
