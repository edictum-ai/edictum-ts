/** Bundle Composer — merge multiple parsed YAML bundles into one. */

import { EdictumConfigError } from '../errors.js'

/** Records a rule that was replaced during composition. */
export interface CompositionOverride {
  readonly ruleId: string
  readonly overriddenBy: string
  readonly originalSource: string
}

/** Records a rule added as an observe-mode copy (observe_alongside). */
export interface ObserveContract {
  readonly ruleId: string
  readonly enforcedSource: string
  readonly observedSource: string
}

/** Report of what happened during composition. */
export interface CompositionReport {
  readonly overriddenContracts: readonly CompositionOverride[]
  readonly observeContracts: readonly ObserveContract[]
}

/** Result of composing multiple bundles. */
export interface ComposedBundle {
  readonly bundle: Record<string, unknown>
  readonly report: CompositionReport
}

function deepCopyBundle(data: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(data)
}

/**
 * Merge multiple parsed bundle dicts left to right.
 *
 * Each entry is a tuple of [bundleData, sourceLabel]. Later layers
 * have higher priority.
 */
export function composeBundles(...bundles: [Record<string, unknown>, string][]): ComposedBundle {
  if (bundles.length === 0) {
    throw new Error('composeBundles() requires at least one bundle')
  }

  if (bundles.length === 1) {
    const entry = bundles[0] as [Record<string, unknown>, string]
    return {
      bundle: deepCopyBundle(entry[0]),
      report: { overriddenContracts: [], observeContracts: [] },
    }
  }

  const overrides: CompositionOverride[] = []
  const observes: ObserveContract[] = []

  const first = bundles[0] as [Record<string, unknown>, string]
  const merged = deepCopyBundle(first[0])
  const firstLabel = first[1]

  const contractSources = new Map<string, string>()
  for (const c of (merged.rules ?? []) as Record<string, unknown>[]) {
    contractSources.set(c.id as string, firstLabel)
  }

  for (let i = 1; i < bundles.length; i++) {
    const entry = bundles[i] as [Record<string, unknown>, string]
    const [data, label] = entry
    const isObserveAlongside = Boolean(data.observe_alongside)

    if (isObserveAlongside) {
      mergeObserveAlongside(merged, data, label, contractSources, observes)
    } else {
      mergeStandard(merged, data, label, contractSources, overrides)
    }
  }

  return {
    bundle: merged,
    report: { overriddenContracts: overrides, observeContracts: observes },
  }
}

function mergeStandard(
  merged: Record<string, unknown>,
  layer: Record<string, unknown>,
  label: string,
  contractSources: Map<string, string>,
  overrides: CompositionOverride[],
): void {
  if ('defaults' in layer) {
    const ld = layer.defaults as Record<string, unknown>
    const md = (merged.defaults ?? {}) as Record<string, unknown>
    if ('mode' in ld) md.mode = ld.mode
    if ('environment' in ld) md.environment = ld.environment
    merged.defaults = md
  }

  if ('limits' in layer) merged.limits = deepCopyBundle(layer.limits as Record<string, unknown>)

  if ('tools' in layer) {
    const mt = (merged.tools ?? {}) as Record<string, unknown>
    for (const [name, cfg] of Object.entries(layer.tools as Record<string, unknown>)) {
      mt[name] = { ...(cfg as Record<string, unknown>) }
    }
    merged.tools = mt
  }

  if ('metadata' in layer) {
    const mm = (merged.metadata ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(layer.metadata as Record<string, unknown>)) mm[k] = v
    merged.metadata = mm
  }

  if ('observability' in layer) {
    merged.observability = deepCopyBundle(layer.observability as Record<string, unknown>)
  }

  if ('rules' in layer) {
    const existingById = new Map<string, number>()
    const mc = (merged.rules ?? []) as Record<string, unknown>[]
    for (let j = 0; j < mc.length; j++) {
      const c = mc[j] as Record<string, unknown>
      existingById.set(c.id as string, j)
    }

    for (const rule of (layer.rules ?? []) as Record<string, unknown>[]) {
      const cid = rule.id as string
      const newContract = deepCopyBundle(rule)

      if (existingById.has(cid)) {
        const idx = existingById.get(cid) as number
        overrides.push({
          ruleId: cid,
          overriddenBy: label,
          originalSource: contractSources.get(cid) ?? 'unknown',
        })
        mc[idx] = newContract
      } else {
        mc.push(newContract)
        existingById.set(cid, mc.length - 1)
      }
      contractSources.set(cid, label)
    }
    merged.rules = mc
  }
}

function mergeObserveAlongside(
  merged: Record<string, unknown>,
  layer: Record<string, unknown>,
  label: string,
  contractSources: Map<string, string>,
  observes: ObserveContract[],
): void {
  const mc = (merged.rules ?? []) as Record<string, unknown>[]

  for (const rule of (layer.rules ?? []) as Record<string, unknown>[]) {
    const cid = rule.id as string
    const observeId = `${cid}:candidate`

    // Check for ID collisions — the generated observe ID must not clash
    // with any existing rule in the merged bundle.
    const existingIds = new Set((mc as Record<string, unknown>[]).map((c) => c.id as string))
    if (existingIds.has(observeId)) {
      throw new EdictumConfigError(
        `observe_alongside collision: generated ID "${observeId}" already exists in the bundle. ` +
          `Rename the conflicting rule or use a different ID for "${cid}".`,
      )
    }

    const observeContract = deepCopyBundle(rule)
    observeContract.id = observeId
    observeContract.mode = 'observe'
    observeContract._observe = true

    mc.push(observeContract)
    observes.push({
      ruleId: cid,
      enforcedSource: contractSources.get(cid) ?? '',
      observedSource: label,
    })
  }
  merged.rules = mc

  if ('tools' in layer) {
    const mt = (merged.tools ?? {}) as Record<string, unknown>
    for (const [name, cfg] of Object.entries(layer.tools as Record<string, unknown>)) {
      mt[name] = { ...(cfg as Record<string, unknown>) }
    }
    merged.tools = mt
  }

  if ('metadata' in layer) {
    const mm = (merged.metadata ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(layer.metadata as Record<string, unknown>)) mm[k] = v
    merged.metadata = mm
  }
}
