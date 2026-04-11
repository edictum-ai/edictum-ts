import { describe, expect, it } from 'vitest'

import { EdictumConfigError, resolveRulesetExtends } from '../../src/index.js'

describe('resolveRulesetExtends', () => {
  it('returns base ruleset unchanged when no extends', () => {
    const rulesets = { base: { rules: [{ id: 'r1' }] } }
    const result = resolveRulesetExtends(rulesets, 'base')
    expect(result.rules).toEqual([{ id: 'r1' }])
    expect(result.extends).toBeUndefined()
  })

  it('merges parent rules before child rules', () => {
    const rulesets = {
      parent: { rules: [{ id: 'parent-rule' }] },
      child: { extends: 'parent', rules: [{ id: 'child-rule' }] },
    }
    const result = resolveRulesetExtends(rulesets, 'child')
    expect(result.rules).toEqual([{ id: 'parent-rule' }, { id: 'child-rule' }])
  })

  it('resolves multi-level inheritance', () => {
    const rulesets = {
      grandparent: { rules: [{ id: 'gp' }] },
      parent: { extends: 'grandparent', rules: [{ id: 'p' }] },
      child: { extends: 'parent', rules: [{ id: 'c' }] },
    }
    const result = resolveRulesetExtends(rulesets, 'child')
    expect((result.rules as { id: string }[]).map((r) => r.id)).toEqual(['gp', 'p', 'c'])
  })

  it('child metadata takes precedence over parent', () => {
    const rulesets = {
      parent: { metadata: { name: 'parent-meta' }, rules: [] },
      child: { extends: 'parent', metadata: { name: 'child-meta' }, rules: [] },
    }
    const result = resolveRulesetExtends(rulesets, 'child')
    expect((result.metadata as { name: string }).name).toBe('child-meta')
  })

  it('throws on missing parent', () => {
    const rulesets = { child: { extends: 'nonexistent', rules: [] } }
    expect(() => resolveRulesetExtends(rulesets, 'child')).toThrow(EdictumConfigError)
    expect(() => resolveRulesetExtends(rulesets, 'child')).toThrow('not found')
  })

  it('throws on circular reference', () => {
    const rulesets = {
      a: { extends: 'b', rules: [] },
      b: { extends: 'a', rules: [] },
    }
    expect(() => resolveRulesetExtends(rulesets, 'a')).toThrow(EdictumConfigError)
    expect(() => resolveRulesetExtends(rulesets, 'a')).toThrow('circular reference')
  })

  it('throws on non-string extends value', () => {
    const rulesets = { child: { extends: 42, rules: [] } } as unknown as Record<
      string,
      Record<string, unknown>
    >
    expect(() => resolveRulesetExtends(rulesets, 'child')).toThrow(EdictumConfigError)
    expect(() => resolveRulesetExtends(rulesets, 'child')).toThrow('must be a string')
  })

  describe('security', () => {
    it('does not resolve __proto__ as a parent via prototype chain', () => {
      const rulesets = {
        legit: { rules: [{ id: 'allow-all' }] },
        child: { extends: '__proto__', rules: [] },
      } as unknown as Record<string, Record<string, unknown>>
      expect(() => resolveRulesetExtends(rulesets, 'child')).toThrow(EdictumConfigError)
      expect(() => resolveRulesetExtends(rulesets, 'child')).toThrow('not found')
    })

    it('does not resolve constructor as a parent', () => {
      const rulesets = {
        child: { extends: 'constructor', rules: [] },
      } as unknown as Record<string, Record<string, unknown>>
      expect(() => resolveRulesetExtends(rulesets, 'child')).toThrow(EdictumConfigError)
    })

    it('does not silently drop inherited rules via prototype confusion', () => {
      // Simulate: adversary sets extends: "__proto__" to bypass parent blocking rules.
      // With the safe hasOwnProperty check, this throws rather than silently dropping rules.
      const blockingRules = [{ id: 'block-rm-rf', action: 'block' }]
      const rulesets = {
        'base-policy': { rules: blockingRules },
        'team-policy': { extends: '__proto__', rules: [] },
      } as unknown as Record<string, Record<string, unknown>>
      expect(() => resolveRulesetExtends(rulesets, 'team-policy')).toThrow(EdictumConfigError)
    })
  })
})
