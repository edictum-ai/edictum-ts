/**
 * @edictum/otel — OpenTelemetry integration for edictum.
 *
 * Emits governance-specific spans for every contract evaluation
 * and counters for denied/allowed tool calls.
 *
 * Install: npm install @edictum/otel @opentelemetry/api
 *
 * Quick start:
 * ```ts
 * import { GovernanceTelemetry } from "@edictum/otel";
 * const telemetry = new GovernanceTelemetry();
 * const span = telemetry.startToolSpan(envelope);
 * // ... run pipeline ...
 * telemetry.setSpanOk(span); // or setSpanError(span, reason)
 * ```
 *
 * For automatic no-op fallback when OTel isn't installed:
 * ```ts
 * import { createTelemetry } from "@edictum/otel";
 * const telemetry = await createTelemetry();
 * ```
 */

// Real implementation (requires @opentelemetry/api at runtime)
export { GovernanceTelemetry } from "./telemetry.js";

// No-op fallback
export { NoOpSpan, NoOpTelemetry } from "./noop.js";

// Runtime detection + factory
export { createTelemetry, hasOtel } from "./detect.js";

// Setup helper
export { configureOtel } from "./configure.js";
export type { ConfigureOtelOptions } from "./configure.js";

// Shared types
export type {
  GovernanceTelemetryLike,
  TelemetryEnvelope,
  TelemetrySpan,
} from "./types.js";
