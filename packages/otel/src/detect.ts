/**
 * Runtime detection for @opentelemetry/api availability.
 *
 * Since @opentelemetry/api is an optional peer dependency, this module
 * provides a safe way to check whether it's installed and to create
 * the appropriate telemetry instance (real or no-op).
 */

import type { GovernanceTelemetryLike } from './types.js'
import { NoOpTelemetry } from './noop.js'

// Dual CJS/ESM detection: hasOtel() tries synchronous require.resolve first
// (CJS fast-path), then falls back to hasOtelAsync() which uses dynamic
// import for ESM. createTelemetry() is the recommended entry point — it
// handles both ESM and CJS transparently.

let _hasOtel: boolean | null = null

/**
 * Check if @opentelemetry/api is available at runtime (synchronous).
 *
 * **CJS:** Returns accurate result (uses require.resolve).
 * **ESM:** Always returns false — use {@link hasOtelAsync} instead.
 *
 * For code that must work in both ESM and CJS, prefer {@link hasOtelAsync}
 * or just call {@link createTelemetry} directly.
 */
export function hasOtel(): boolean {
  if (_hasOtel !== null) {
    return _hasOtel
  }
  try {
    // CJS fast-path: require.resolve is synchronous and doesn't load the module.
    require.resolve('@opentelemetry/api')
    _hasOtel = true
  } catch {
    // In ESM, require is not defined — returns false.
    // Use hasOtelAsync() for accurate ESM detection.
    _hasOtel = false
  }
  return _hasOtel
}

/**
 * Async check if @opentelemetry/api is available — works in both ESM and CJS.
 *
 * Prefer this over {@link hasOtel} when your code runs in ESM contexts.
 */
export async function hasOtelAsync(): Promise<boolean> {
  if (_hasOtel !== null) {
    return _hasOtel
  }
  // Try CJS first
  try {
    require.resolve('@opentelemetry/api')
    _hasOtel = true
    return true
  } catch {
    // Not in CJS or not installed via CJS
  }
  // Try ESM dynamic import
  try {
    await import('@opentelemetry/api')
    _hasOtel = true
    return true
  } catch {
    _hasOtel = false
    return false
  }
}

/**
 * Reset the cached hasOtel() result. Intended for tests only.
 * @internal
 */
export function _resetHasOtelCache(): void {
  _hasOtel = null
}

/**
 * Create a GovernanceTelemetry instance — real if OTel is available,
 * no-op otherwise. This is the recommended entry point.
 *
 * Only catches module-not-found errors (OTel not installed). All other
 * errors propagate so bugs in GovernanceTelemetry are not silently
 * swallowed.
 *
 * ```ts
 * import { createTelemetry } from "@edictum/otel";
 * const telemetry = await createTelemetry();
 * const span = telemetry.startToolSpan(envelope);
 * ```
 */
export async function createTelemetry(): Promise<GovernanceTelemetryLike> {
  try {
    const { GovernanceTelemetry } = await import('./telemetry.js')
    return new GovernanceTelemetry()
  } catch (err: unknown) {
    // Only swallow module-not-found — OTel not installed.
    // All other errors (constructor bugs, etc.) propagate.
    if (
      err instanceof Error &&
      'code' in err &&
      new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']).has(
        (err as NodeJS.ErrnoException).code ?? '',
      )
    ) {
      return new NoOpTelemetry()
    }
    throw err
  }
}
