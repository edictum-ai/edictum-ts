/**
 * Sanitization helpers for OTel configuration and telemetry.
 *
 * Shared by configure.ts and telemetry.ts to ensure consistent
 * input validation across the package.
 */

/** Control char pattern — matches C0, DEL, C1, and Unicode line separators (non-global, for .test()). */
export const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/

/** Pre-compiled global variant for .replace() — avoids new RegExp() on every sanitize() call. */
const CONTROL_CHAR_GLOBAL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g

/** Strip control chars and cap length for resource attribute values. */
export const sanitize = (s: string, maxLen = 10_000): string =>
  s.slice(0, maxLen).replace(CONTROL_CHAR_GLOBAL, '')

/** Valid export protocols. */
export const VALID_PROTOCOLS = ['grpc', 'http', 'http/protobuf'] as const
export type OtelProtocol = (typeof VALID_PROTOCOLS)[number]
