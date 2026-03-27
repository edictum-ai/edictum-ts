/** YAML Bundle Loader — parse, validate, compute bundle hash. */

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'

import yaml from 'js-yaml'

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
// YAML parsing
// ---------------------------------------------------------------------------

/** Parse YAML content string, returning the parsed object. */
function parseYaml(content: string): Record<string, unknown> {
  let data: unknown
  try {
    data = yaml.load(content, { schema: yaml.CORE_SCHEMA })
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
