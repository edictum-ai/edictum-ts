/**
 * Runtime detection for @opentelemetry/api availability.
 *
 * Since @opentelemetry/api is an optional peer dependency, this module
 * provides a safe way to check whether it's installed and to create
 * the appropriate telemetry instance (real or no-op).
 */

import { createRequire } from "node:module";

import type { GovernanceTelemetryLike } from "./types.js";
import { NoOpTelemetry } from "./noop.js";

// createRequire works in both ESM and CJS (tsup transforms import.meta.url
// for CJS output). This avoids the ESM ReferenceError on bare `require`.
const _require = createRequire(import.meta.url);

let _hasOtel: boolean | null = null;

/** Check if @opentelemetry/api is available at runtime. */
export function hasOtel(): boolean {
  if (_hasOtel !== null) {
    return _hasOtel;
  }
  try {
    _require.resolve("@opentelemetry/api");
    _hasOtel = true;
  } catch {
    _hasOtel = false;
  }
  return _hasOtel;
}

/**
 * Create a GovernanceTelemetry instance — real if OTel is available,
 * no-op otherwise. This is the recommended entry point.
 *
 * ```ts
 * import { createTelemetry } from "@edictum/otel";
 * const telemetry = await createTelemetry();
 * const span = telemetry.startToolSpan(envelope);
 * ```
 */
export async function createTelemetry(): Promise<GovernanceTelemetryLike> {
  try {
    // Dynamic import — fails gracefully if @opentelemetry/api is missing
    const { GovernanceTelemetry } = await import("./telemetry.js");
    return new GovernanceTelemetry();
  } catch {
    return new NoOpTelemetry();
  }
}
