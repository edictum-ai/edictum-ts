/** Selector resolution — map YAML selector paths to ToolEnvelope values. */

import type { ToolEnvelope } from "../envelope.js";
import type { CustomSelector } from "./evaluator.js";

// ---------------------------------------------------------------------------
// Sentinel for "field not found"
// ---------------------------------------------------------------------------

const _MISSING: unique symbol = Symbol("MISSING");
export type Missing = typeof _MISSING;
export { _MISSING };

// ---------------------------------------------------------------------------
// Built-in selector prefixes — custom selectors must not use these
// ---------------------------------------------------------------------------

export const BUILTIN_SELECTOR_PREFIXES: ReadonlySet<string> = new Set([
  "environment",
  "tool",
  "args",
  "principal",
  "output",
  "env",
  "metadata",
]);

// ---------------------------------------------------------------------------
// Selector resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted selector path to a value from the envelope.
 * Returns `_MISSING` if the field is not found at any level.
 *
 * NOTE: ToolEnvelope uses camelCase (toolName, userId, serviceId, orgId,
 * ticketRef) but YAML selectors use snake_case (tool.name, principal.user_id).
 * This function maps between the two.
 */
export function resolveSelector(
  selector: string,
  envelope: ToolEnvelope,
  outputText?: string | null,
  customSelectors?: Readonly<Record<string, CustomSelector>> | null,
): unknown {
  if (selector === "environment") return envelope.environment;
  if (selector === "tool.name") return envelope.toolName;

  if (selector.startsWith("args.")) {
    return resolveNested(selector.slice(5), envelope.args as Record<string, unknown>);
  }

  if (selector.startsWith("principal.")) {
    if (envelope.principal == null) return _MISSING;
    const rest = selector.slice(10);
    // Map YAML snake_case selectors to TS camelCase properties
    if (rest === "user_id") return envelope.principal.userId;
    if (rest === "service_id") return envelope.principal.serviceId;
    if (rest === "org_id") return envelope.principal.orgId;
    if (rest === "role") return envelope.principal.role;
    if (rest === "ticket_ref") return envelope.principal.ticketRef;
    if (rest.startsWith("claims.")) {
      return resolveNested(
        rest.slice(7),
        envelope.principal.claims as Record<string, unknown>,
      );
    }
    return _MISSING;
  }

  if (selector === "output.text") {
    return outputText == null ? _MISSING : outputText;
  }

  // SECURITY NOTE (Python parity): env.* selector intentionally reads from
  // process.env, matching Python's os.environ.get(). This is by design — YAML
  // contracts use env.* to gate behavior on environment variables (e.g.,
  // env.EDICTUM_MODE). The message template expansion layer handles secret
  // redaction. Bundle authors control which env vars are referenced; untrusted
  // YAML bundles should not be loaded without review.
  if (selector.startsWith("env.")) {
    const varName = selector.slice(4);
    const raw = process.env[varName];
    if (raw == null) return _MISSING;
    return coerceEnvValue(raw);
  }

  if (selector.startsWith("metadata.")) {
    return resolveNested(
      selector.slice(9),
      envelope.metadata as Record<string, unknown>,
    );
  }

  // Custom selectors: match prefix before first dot
  if (customSelectors) {
    const dotPos = selector.indexOf(".");
    if (dotPos > 0) {
      const prefix = selector.slice(0, dotPos);
      if (Object.hasOwn(customSelectors, prefix)) {
        const resolver = customSelectors[prefix] as CustomSelector;
        const data = resolver(envelope);
        const rest = selector.slice(dotPos + 1);
        return resolveNested(rest, data);
      }
    }
  }

  return _MISSING;
}

// ---------------------------------------------------------------------------
// Nested path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted path through nested dicts.
 * Returns `_MISSING` if any intermediate key is absent or not a dict.
 */
export function resolveNested(path: string, data: unknown): unknown {
  const parts = path.split(".");
  let current = data;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return _MISSING;
    const obj = current as Record<string, unknown>;
    if (!Object.hasOwn(obj, part)) return _MISSING;
    current = obj[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Env value coercion
// ---------------------------------------------------------------------------

/** Coerce an env var string to a typed value for operator comparison. */
export function coerceEnvValue(raw: string): string | boolean | number {
  const low = raw.toLowerCase();
  if (low === "true") return true;
  if (low === "false") return false;
  const asInt = parseInt(raw, 10);
  if (!isNaN(asInt) && String(asInt) === raw) return asInt;
  const asFloat = parseFloat(raw);
  if (!isNaN(asFloat) && String(asFloat) === raw) return asFloat;
  return raw;
}
