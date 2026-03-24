/**
 * Runtime detection for @opentelemetry/api availability.
 *
 * Since @opentelemetry/api is an optional peer dependency, this module
 * provides a safe way to check whether it's installed and to create
 * the appropriate telemetry instance (real or no-op).
 */

import type { GovernanceTelemetryLike } from "./types.js";
import { NoOpTelemetry } from "./noop.js";

let _hasOtel: boolean | null = null;

/** Check if @opentelemetry/api is available at runtime. */
export function hasOtel(): boolean {
  if (_hasOtel !== null) {
    return _hasOtel;
  }
  try {
    require.resolve("@opentelemetry/api");
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
