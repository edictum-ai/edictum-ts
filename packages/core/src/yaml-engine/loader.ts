/** YAML Bundle Loader — parse, validate, compute bundle hash. */

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'

import { EdictumConfigError } from '../errors.js'
import {
  validateSchema,
  validateUniqueIds,
  validateRegexes,
  validatePreSelectors,
  validateSandboxContracts,
} from './loader-validators.js'
import { validateContractFields } from './loader-field-validators.js'
import { validateExpressionShapes } from './loader-expression-validators.js'

// Re-export validators for direct access
export {
  validateSchema,
  validateUniqueIds,
  validateRegexes,
  validatePreSelectors,
  validateSandboxContracts,
} from './loader-validators.js'
export { validateContractFields } from './loader-field-validators.js'
export { validateExpressionShapes } from './loader-expression-validators.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bundle file size in bytes (1 MB). */
export const MAX_BUNDLE_SIZE = 1_048_576

// ---------------------------------------------------------------------------
// BundleHash
// ---------------------------------------------------------------------------

/** SHA256 hash of raw YAML bytes, used as policy_version. */
export interface BundleHash {
  readonly hex: string
}

/** Compute SHA256 hash of raw YAML bytes. */
export function computeHash(rawBytes: Uint8Array): BundleHash {
  return { hex: createHash('sha256').update(rawBytes).digest('hex') }
}

// ---------------------------------------------------------------------------
// YAML parsing helper — dual CJS/ESM with module-level caching
// ---------------------------------------------------------------------------

/** Cached js-yaml module. Set once, reused for all subsequent calls. */
let _yamlModule: { load(input: string): unknown } | null = null

/** Synchronous CJS fast-path. Returns null if not in CJS context or js-yaml not installed. */
function requireYamlSync(): { load(input: string): unknown } | null {
  if (_yamlModule) return _yamlModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _yamlModule = require('js-yaml') as { load(input: string): unknown }
    return _yamlModule
  } catch {
    return null
  }
}

/** Async ESM fallback. Throws EdictumConfigError if js-yaml is not installed. */
async function requireYamlAsync(): Promise<{ load(input: string): unknown }> {
  if (_yamlModule) return _yamlModule
  try {
    const mod = await import('js-yaml')
    _yamlModule = (mod.default ?? mod) as { load(input: string): unknown }
    return _yamlModule
  } catch {
    throw new EdictumConfigError(
      'The YAML engine requires js-yaml. Install it with: npm install js-yaml',
    )
  }
}

/** Synchronous access — works in CJS or after ensureYamlLoaded() in ESM. */
function requireYaml(): { load(input: string): unknown } {
  const sync = requireYamlSync()
  if (sync) return sync
  throw new EdictumConfigError(
    'The YAML engine requires js-yaml. Install it with: npm install js-yaml\n' +
      'If using ESM, call ensureYamlLoaded() before loadBundle/loadBundleString.',
  )
}

/**
 * Pre-load js-yaml for ESM contexts. Call once at startup.
 * In CJS contexts this is a no-op (require() works synchronously).
 */
export async function ensureYamlLoaded(): Promise<void> {
  await requireYamlAsync()
}

/**
 * Reset the cached yaml module. Intended for tests only.
 * @internal
 */
export function _resetYamlCache(): void {
  _yamlModule = null
}

/** Parse YAML content string synchronously, returning the parsed object. */
function parseYaml(content: string): Record<string, unknown> {
  const yaml = requireYaml()
  return _parseWithYaml(yaml, content)
}

/** Parse YAML content string asynchronously (ESM-safe), returning the parsed object. */
async function parseYamlAsync(content: string): Promise<Record<string, unknown>> {
  const yaml = await requireYamlAsync()
  return _parseWithYaml(yaml, content)
}

/** Shared parse implementation. */
function _parseWithYaml(
  yaml: { load(input: string): unknown },
  content: string,
): Record<string, unknown> {
  let data: unknown
  try {
    data = yaml.load(content)
  } catch (e) {
    throw new EdictumConfigError(`YAML parse error: ${String(e)}`)
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new EdictumConfigError('YAML document must be a mapping')
  }
  return data as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Validation pipeline
// ---------------------------------------------------------------------------

/** Run all bundle validations in sequence. */
function validateBundle(data: Record<string, unknown>): void {
  validateSchema(data)
  validateContractFields(data)
  validateUniqueIds(data)
  validateExpressionShapes(data)
  validateRegexes(data)
  validatePreSelectors(data)
  validateSandboxContracts(data)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate a YAML contract bundle from a file path.
 *
 * @returns Tuple of [parsed bundle dict, bundle hash].
 * @throws EdictumConfigError on validation failure.
 * @throws Error if the file does not exist.
 */
export function loadBundle(source: string): [Record<string, unknown>, BundleHash] {
  // Resolve symlinks before reading to prevent path traversal attacks.
  const resolved = realpathSync(source)
  const fileSize = statSync(resolved).size
  if (fileSize > MAX_BUNDLE_SIZE) {
    throw new EdictumConfigError(
      `Bundle file too large (${fileSize} bytes, max ${MAX_BUNDLE_SIZE})`,
    )
  }

  const rawBytes = readFileSync(resolved)
  const bundleHash = computeHash(rawBytes)
  const data = parseYaml(rawBytes.toString('utf-8'))

  validateBundle(data)
  return [data, bundleHash]
}

/**
 * Load and validate a YAML contract bundle from a string or bytes.
 *
 * Like {@link loadBundle} but accepts YAML content directly instead of
 * a file path. Useful when YAML is generated programmatically or fetched
 * from an API.
 *
 * @returns Tuple of [parsed bundle dict, bundle hash].
 * @throws EdictumConfigError on validation failure.
 */
export function loadBundleString(
  content: string | Uint8Array,
): [Record<string, unknown>, BundleHash] {
  const rawBytes = typeof content === 'string' ? new TextEncoder().encode(content) : content

  if (rawBytes.length > MAX_BUNDLE_SIZE) {
    throw new EdictumConfigError(
      `Bundle content too large (${rawBytes.length} bytes, max ${MAX_BUNDLE_SIZE})`,
    )
  }

  const bundleHash = computeHash(rawBytes)
  const text = typeof content === 'string' ? content : new TextDecoder().decode(rawBytes)
  const data = parseYaml(text)

  validateBundle(data)
  return [data, bundleHash]
}

/**
 * Async version of {@link loadBundleString} — works in both ESM and CJS.
 *
 * Use this instead of loadBundleString when importing @edictum/core as ESM.
 * The sync loadBundleString uses require('js-yaml') which is not available
 * in ESM contexts.
 */
export async function loadBundleStringAsync(
  content: string | Uint8Array,
): Promise<[Record<string, unknown>, BundleHash]> {
  const rawBytes = typeof content === 'string' ? new TextEncoder().encode(content) : content

  if (rawBytes.length > MAX_BUNDLE_SIZE) {
    throw new EdictumConfigError(
      `Bundle content too large (${rawBytes.length} bytes, max ${MAX_BUNDLE_SIZE})`,
    )
  }

  const bundleHash = computeHash(rawBytes)
  const text = typeof content === 'string' ? content : new TextDecoder().decode(rawBytes)
  const data = await parseYamlAsync(text)

  validateBundle(data)
  return [data, bundleHash]
}

/**
 * Async version of {@link loadBundle} — works in both ESM and CJS.
 *
 * Use this instead of loadBundle when importing @edictum/core as ESM.
 */
export async function loadBundleAsync(
  source: string,
): Promise<[Record<string, unknown>, BundleHash]> {
  const resolved = realpathSync(source)
  const fileSize = statSync(resolved).size
  if (fileSize > MAX_BUNDLE_SIZE) {
    throw new EdictumConfigError(
      `Bundle file too large (${fileSize} bytes, max ${MAX_BUNDLE_SIZE})`,
    )
  }

  const rawBytes = readFileSync(resolved)
  const bundleHash = computeHash(rawBytes)
  const data = await parseYamlAsync(rawBytes.toString('utf-8'))

  validateBundle(data)
  return [data, bundleHash]
}
