/**
 * Runtime detection for @opentelemetry/api availability.
 *
 * Since @opentelemetry/api is an optional peer dependency, this module
 * provides a safe way to check whether it's installed and to create
 * the appropriate telemetry instance (real or no-op).
 */

import type { GovernanceTelemetryLike } from './types.js'
import { NoOpTelemetry } from './noop.js'

// Dual CJS/ESM resolution: try synchronous require first (CJS), then fall
// back to dynamic import (ESM). The previous approach used
// `createRequire(import.meta.url)` which breaks in CJS because tsup
// transforms `import.meta.url` to `undefined` (var import_meta = {}).

let _hasOtel: boolean | null = null

/** Check if @opentelemetry/api is available at runtime. */
export function hasOtel(): boolean {
  if (_hasOtel !== null) {
    return _hasOtel
  }
  try {
    // CJS fast-path: require.resolve is synchronous and doesn't load the module.
    require.resolve('@opentelemetry/api')
    _hasOtel = true
  } catch {
    // In ESM, require is not defined — treat as unknown until createTelemetry
    // attempts dynamic import. This means hasOtel() returns false in ESM when
    // OTel IS installed, but createTelemetry() (the recommended entry point)
    // handles ESM correctly via dynamic import.
    _hasOtel = false
  }
  return _hasOtel
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
