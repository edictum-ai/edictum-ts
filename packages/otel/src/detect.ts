/**
 * Runtime detection for @opentelemetry/api availability.
 *
 * Since @opentelemetry/api is an optional peer dependency, this module
 * provides a safe way to check whether it's installed and to create
 * the appropriate telemetry instance (real or no-op).
 */

import { createRequire } from 'node:module'

import type { GovernanceTelemetryLike } from './types.js'
import { NoOpTelemetry } from './noop.js'

// createRequire works in both ESM and CJS (tsup transforms import.meta.url
// for CJS output). This avoids the ESM ReferenceError on bare `require`.
const _require = createRequire(import.meta.url)

let _hasOtel: boolean | null = null

/** Check if @opentelemetry/api is available at runtime. */
export function hasOtel(): boolean {
  if (_hasOtel !== null) {
    return _hasOtel
  }
  try {
    _require.resolve('@opentelemetry/api')
    _hasOtel = true
  } catch {
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
      (err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return new NoOpTelemetry()
    }
    throw err
  }
}
