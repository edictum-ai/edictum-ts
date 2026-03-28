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

// Separate caches to prevent hasOtel() (sync, CJS-only) from poisoning
// hasOtelAsync() (async, works in both). In ESM, hasOtel() sets
// _hasOtelSync = false because require is unavailable — but OTel may still
// be installed and detectable via dynamic import.
let _hasOtelSync: boolean | null = null
let _hasOtelAsyncResult: boolean | null = null

/**
 * Check if @opentelemetry/api is available at runtime (synchronous).
 *
 * **CJS:** Returns accurate result (uses require.resolve).
 * **ESM:** Always returns false — this is a known limitation because
 * `require.resolve` is not available in ESM. The return value does NOT
 * mean OTel is absent; it means this function cannot detect it.
 *
 * @deprecated Use {@link hasOtelAsync} for accurate detection in both ESM
 * and CJS, or call {@link createTelemetry} directly (recommended — it
 * returns a real or no-op instance transparently).
 */
export function hasOtel(): boolean {
  if (_hasOtelSync !== null) {
    return _hasOtelSync
  }

  // Check ESM banner cache — populated by top-level await in the ESM build.
  // Consume-and-delete: read once, remove from globalThis to close the
  // injection window where a dependency could suppress telemetry detection.
  const raw = (globalThis as Record<string, unknown>).__edictum_has_otel
  if (raw !== undefined) {
    delete (globalThis as Record<string, unknown>).__edictum_has_otel
    if (typeof raw === 'boolean') {
      _hasOtelSync = raw
      return _hasOtelSync
    }
    // Non-boolean — fall through to CJS path.
  }

  // CJS fast-path: require.resolve is synchronous and doesn't load the module.
  try {
    require.resolve('@opentelemetry/api')
    _hasOtelSync = true
  } catch {
    _hasOtelSync = false
  }
  return _hasOtelSync
}

/**
 * Async check if @opentelemetry/api is available — works in both ESM and CJS.
 *
 * Uses its own cache, independent of {@link hasOtel}. Safe to call after
 * hasOtel() — the async path will still attempt dynamic import even if
 * hasOtel() returned false (which it always does in ESM).
 */
export async function hasOtelAsync(): Promise<boolean> {
  if (_hasOtelAsyncResult !== null) {
    return _hasOtelAsyncResult
  }
  // Try CJS first
  try {
    require.resolve('@opentelemetry/api')
    _hasOtelAsyncResult = true
    return true
  } catch {
    // Not in CJS or not installed via CJS
  }
  // Try ESM dynamic import
  try {
    await import('@opentelemetry/api')
    _hasOtelAsyncResult = true
    return true
  } catch {
    _hasOtelAsyncResult = false
    return false
  }
}

/**
 * Reset the cached hasOtel() result. Intended for tests only.
 * @internal
 */
export function _resetHasOtelCache(): void {
  _hasOtelSync = null
  _hasOtelAsyncResult = null
  delete (globalThis as Record<string, unknown>).__edictum_has_otel
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
 * const span = telemetry.startToolSpan(toolCall);
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
