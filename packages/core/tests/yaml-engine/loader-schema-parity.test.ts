/**
 * Schema parity tests — required fields, type/id validation, effect enums.
 *
 * Malformed YAML bundles that Python rejects (via JSON Schema validation
 * against edictum-v1.schema.json) and TS must also reject.
 *
 * All checks are handwritten validators (no AJV) to stay aligned with Go's
 * validation approach. Cross-SDK parity is proven via shared conformance
 * fixtures in edictum-schemas, not by embedding different validation stacks.
 *
 * See also: loader-schema-constraints.test.ts for session, sandbox,
 * expression shape, and value constraint tests.
 */

import { describe, expect, test } from 'vitest'

import { loadBundleString } from '../../src/yaml-engine/index.js'
import { EdictumConfigError } from '../../src/errors.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Valid pre rule YAML fragment. */
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

/** Build a full YAML bundle, overriding sections as needed. */
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

/** Expect loadBundleString to throw EdictumConfigError matching pattern. */
function expectReject(yaml: string, pattern?: RegExp): void {
  expect(() => loadBundleString(yaml)).toThrow(EdictumConfigError)
  if (pattern) expect(() => loadBundleString(yaml)).toThrow(pattern)
}

// =========================================================================
// Required top-level fields
// =========================================================================

describe('required top-level fields (parity with JSON Schema)', () => {
  test('missing metadata rejected', () => {
    const yaml = [
      'apiVersion: edictum/v1',
      'kind: Ruleset',
      'defaults:\n  mode: enforce',
      'rules:',
      VALID_PRE,
    ].join('\n')
    expectReject(yaml, /metadata/)
  })

  test('metadata as string rejected', () => {
    expectReject(bundle({ metadata: 'metadata: not-an-object' }), /metadata/)
  })

  test('metadata as array rejected', () => {
    expectReject(bundle({ metadata: 'metadata:\n  - item' }), /metadata/)
  })

  test('missing defaults rejected', () => {
    const yaml = [
      'apiVersion: edictum/v1',
      'kind: Ruleset',
      'metadata:\n  name: test',
      'rules:',
      VALID_PRE,
    ].join('\n')
    expectReject(yaml, /defaults/)
  })

  test('defaults without mode rejected', () => {
    expectReject(bundle({ defaults: 'defaults:\n  other: true' }), /mode/)
  })

  test('defaults.mode invalid value rejected', () => {
    expectReject(bundle({ defaults: 'defaults:\n  mode: permissive' }), /mode/)
  })

  test('empty rules array rejected', () => {
    expectReject(bundle({ rules: '\n  []' }), /at least 1/)
  })
})

// =========================================================================
// Rule type validation
// =========================================================================

describe('rule type validation', () => {
  test('missing type rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: no-type
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"`,
      }),
      /type/,
    )
  })

  test('invalid type "rule" rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: bad-type
    type: rule
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"`,
      }),
      /type/,
    )
  })

  test('type: null rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: null-type
    type: null
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"`,
      }),
      /type/,
    )
  })
})

// =========================================================================
// Rule id validation
// =========================================================================

describe('rule id validation', () => {
  test('missing id rejected', () => {
    expectReject(
      bundle({
        rules: `
  - type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"`,
      }),
      /id/,
    )
  })

  test('empty id rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: ""
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"`,
      }),
      /id/,
    )
  })
})

// =========================================================================
// Pre/post rule required fields
// =========================================================================

describe('pre rule required fields', () => {
  test('missing tool rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: no-tool
    type: pre
    when:
      args.x: { equals: 1 }
    then:
      action: block
      message: "denied"`,
      }),
      /tool/,
    )
  })

  test('missing when rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: no-when
    type: pre
    tool: "*"
    then:
      action: block
      message: "denied"`,
      }),
      /when/,
    )
  })

  test('missing then rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: no-then
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }`,
      }),
      /then/,
    )
  })

  test('then without action rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: no-effect
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      message: "denied"`,
      }),
      /action/,
    )
  })

  test('then without message rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: no-message
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: block`,
      }),
      /message/,
    )
  })
})

describe('pre rule when field type', () => {
  test('when as plain string rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: string-when
    type: pre
    tool: "*"
    when: "invalid"
    then:
      action: block
      message: "denied"`,
      }),
      /when/,
    )
  })
})

describe('post rule required fields', () => {
  test('missing tool rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: post-no-tool
    type: post
    when:
      output.text: { contains: "secret" }
    then:
      action: warn
      message: "warning"`,
      }),
      /tool/,
    )
  })

  test('missing when rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: post-no-when
    type: post
    tool: "*"
    then:
      action: warn
      message: "warning"`,
      }),
      /when/,
    )
  })

  test('missing then rejected', () => {
    expectReject(
      bundle({
        rules: `
  - id: post-no-then
    type: post
    tool: "*"
    when:
      output.text: { contains: "secret" }`,
      }),
      /then/,
    )
  })
})

// =========================================================================
// Effect enum validation
// =========================================================================

describe('action enum validation', () => {
  test('pre with action "warn" rejected (post-only)', () => {
    expectReject(
      bundle({
        rules: `
  - id: pre-warn
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: warn
      message: "bad"`,
      }),
      /action/,
    )
  })

  test('pre with action "redact" rejected (post-only)', () => {
    expectReject(
      bundle({
        rules: `
  - id: pre-redact
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: redact
      message: "bad"`,
      }),
      /action/,
    )
  })

  test('pre with action "allow" rejected (not valid)', () => {
    expectReject(
      bundle({
        rules: `
  - id: pre-allow
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: allow
      message: "bad"`,
      }),
      /action/,
    )
  })

  test('post with action "ask" rejected (pre-only)', () => {
    expectReject(
      bundle({
        rules: `
  - id: post-approve
    type: post
    tool: "*"
    when:
      output.text: { contains: "secret" }
    then:
      action: ask
      message: "bad"`,
      }),
      /action/,
    )
  })

  test('post with action "block" accepted (valid)', () => {
    expect(() =>
      loadBundleString(
        bundle({
          rules: `
  - id: post-deny
    type: post
    tool: "*"
    when:
      output.text: { contains: "secret" }
    then:
      action: block
      message: "blocked"`,
        }),
      ),
    ).not.toThrow()
  })

  test('pre with action "ask" accepted (valid)', () => {
    expect(() =>
      loadBundleString(
        bundle({
          rules: `
  - id: pre-approve
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      action: ask
      message: "approved"`,
        }),
      ),
    ).not.toThrow()
  })
})
