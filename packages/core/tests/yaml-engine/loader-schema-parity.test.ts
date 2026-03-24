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

/** Valid pre contract YAML fragment. */
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

/** Build a full YAML bundle, overriding sections as needed. */
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
      'kind: ContractBundle',
      'defaults:\n  mode: enforce',
      'contracts:',
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
      'kind: ContractBundle',
      'metadata:\n  name: test',
      'contracts:',
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

  test('empty contracts array rejected', () => {
    expectReject(bundle({ contracts: '\n  []' }), /at least 1/)
  })
})

// =========================================================================
// Contract type validation
// =========================================================================

describe('contract type validation', () => {
  test('missing type rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: no-type
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "denied"`,
      }),
      /type/,
    )
  })

  test('invalid type "rule" rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: bad-type
    type: rule
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "denied"`,
      }),
      /type/,
    )
  })

  test('type: null rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: null-type
    type: null
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "denied"`,
      }),
      /type/,
    )
  })
})

// =========================================================================
// Contract id validation
// =========================================================================

describe('contract id validation', () => {
  test('missing id rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "denied"`,
      }),
      /id/,
    )
  })

  test('empty id rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: ""
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "denied"`,
      }),
      /id/,
    )
  })
})

// =========================================================================
// Pre/post contract required fields
// =========================================================================

describe('pre contract required fields', () => {
  test('missing tool rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: no-tool
    type: pre
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "denied"`,
      }),
      /tool/,
    )
  })

  test('missing when rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: no-when
    type: pre
    tool: "*"
    then:
      effect: deny
      message: "denied"`,
      }),
      /when/,
    )
  })

  test('missing then rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: no-then
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }`,
      }),
      /then/,
    )
  })

  test('then without effect rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: no-effect
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      message: "denied"`,
      }),
      /effect/,
    )
  })

  test('then without message rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: no-message
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny`,
      }),
      /message/,
    )
  })
})

describe('post contract required fields', () => {
  test('missing tool rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: post-no-tool
    type: post
    when:
      output.text: { contains: "secret" }
    then:
      effect: warn
      message: "warning"`,
      }),
      /tool/,
    )
  })

  test('missing when rejected', () => {
    expectReject(
      bundle({
        contracts: `
  - id: post-no-when
    type: post
    tool: "*"
    then:
      effect: warn
      message: "warning"`,
      }),
      /when/,
    )
  })

  test('missing then rejected', () => {
    expectReject(
      bundle({
        contracts: `
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

describe('effect enum validation', () => {
  test('pre with effect "warn" rejected (post-only)', () => {
    expectReject(
      bundle({
        contracts: `
  - id: pre-warn
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: warn
      message: "bad"`,
      }),
      /effect/,
    )
  })

  test('pre with effect "redact" rejected (post-only)', () => {
    expectReject(
      bundle({
        contracts: `
  - id: pre-redact
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: redact
      message: "bad"`,
      }),
      /effect/,
    )
  })

  test('pre with effect "allow" rejected (not valid)', () => {
    expectReject(
      bundle({
        contracts: `
  - id: pre-allow
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: allow
      message: "bad"`,
      }),
      /effect/,
    )
  })

  test('post with effect "approve" rejected (pre-only)', () => {
    expectReject(
      bundle({
        contracts: `
  - id: post-approve
    type: post
    tool: "*"
    when:
      output.text: { contains: "secret" }
    then:
      effect: approve
      message: "bad"`,
      }),
      /effect/,
    )
  })

  test('post with effect "deny" accepted (valid)', () => {
    expect(() =>
      loadBundleString(
        bundle({
          contracts: `
  - id: post-deny
    type: post
    tool: "*"
    when:
      output.text: { contains: "secret" }
    then:
      effect: deny
      message: "blocked"`,
        }),
      ),
    ).not.toThrow()
  })

  test('pre with effect "approve" accepted (valid)', () => {
    expect(() =>
      loadBundleString(
        bundle({
          contracts: `
  - id: pre-approve
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: approve
      message: "approved"`,
        }),
      ),
    ).not.toThrow()
  })
})
