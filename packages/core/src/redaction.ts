/** Redaction policy for sensitive data in audit events. */

import { EdictumConfigError } from "./errors.js";

// ---------------------------------------------------------------------------
// RedactionPolicy
// ---------------------------------------------------------------------------

/**
 * Redact sensitive data from audit events.
 *
 * Recurses into dicts AND lists. Normalizes keys to lowercase.
 * Caps total payload size. Detects common secret patterns in values.
 */
export class RedactionPolicy {
  static readonly DEFAULT_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
    "api-key",
    "authorization",
    "auth",
    "credentials",
    "private_key",
    "privatekey",
    "access_token",
    "refresh_token",
    "client_secret",
    "connection_string",
    "database_url",
    "db_password",
    "ssh_key",
    "passphrase",
  ]);

  static readonly BASH_REDACTION_PATTERNS: ReadonlyArray<
    readonly [string, string]
  > = [
    [
      String.raw`(export\s+\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\w*=)\S+`,
      "$1[REDACTED]",
    ],
    [String.raw`(-p\s*|--password[= ])\S+`, "$1[REDACTED]"],
    [String.raw`(://\w+:)\S+(@)`, "$1[REDACTED]$2"],
  ];

  static readonly SECRET_VALUE_PATTERNS: ReadonlyArray<string> = [
    String.raw`^(sk-[a-zA-Z0-9]{20,})`,
    String.raw`^(AKIA[A-Z0-9]{16})`,
    String.raw`^(eyJ[a-zA-Z0-9_-]{20,}\.)`,
    String.raw`^(ghp_[a-zA-Z0-9]{36})`,
    String.raw`^(xox[bpas]-[a-zA-Z0-9-]{10,})`,
  ];

  static readonly MAX_PAYLOAD_SIZE = 32_768;
  static readonly MAX_REGEX_INPUT = 10_000;
  static readonly MAX_PATTERN_LENGTH = 10_000;

  private readonly _keys: ReadonlySet<string>;
  private readonly _patterns: ReadonlyArray<readonly [string, string]>;
  private readonly _compiledPatterns: ReadonlyArray<readonly [RegExp, string]>;
  private readonly _detectValues: boolean;

  constructor(
    sensitiveKeys?: ReadonlySet<string> | null,
    customPatterns?: ReadonlyArray<readonly [string, string]> | null,
    detectSecretValues: boolean = true,
  ) {
    const baseKeys = sensitiveKeys
      ? new Set([...RedactionPolicy.DEFAULT_SENSITIVE_KEYS, ...sensitiveKeys])
      : new Set(RedactionPolicy.DEFAULT_SENSITIVE_KEYS);
    this._keys = new Set([...baseKeys].map((k) => k.toLowerCase()));
    if (customPatterns) {
      for (const [pattern] of customPatterns) {
        if (pattern.length > RedactionPolicy.MAX_PATTERN_LENGTH) {
          throw new EdictumConfigError(
            `Custom redaction pattern exceeds ${RedactionPolicy.MAX_PATTERN_LENGTH} characters`,
          );
        }
      }
    }
    this._patterns = [
      ...(customPatterns ?? []),
      ...RedactionPolicy.BASH_REDACTION_PATTERNS,
    ];
    this._compiledPatterns = this._patterns.map(
      ([pattern, replacement]) => [new RegExp(pattern, "g"), replacement] as const,
    );
    this._detectValues = detectSecretValues;
  }

  /** Recursively redact sensitive data from tool arguments. */
  redactArgs(args: unknown): unknown {
    if (args !== null && typeof args === "object" && !Array.isArray(args)) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        args as Record<string, unknown>,
      )) {
        result[key] = this._isSensitiveKey(key)
          ? "[REDACTED]"
          : this.redactArgs(value);
      }
      return result;
    }
    if (Array.isArray(args)) {
      return args.map((item) => this.redactArgs(item));
    }
    if (typeof args === "string") {
      if (this._detectValues && this._looksLikeSecret(args)) {
        return "[REDACTED]";
      }
      if (args.length > 1000) {
        return args.slice(0, 997) + "...";
      }
      return args;
    }
    return args;
  }

  /** Check if a key name indicates sensitive data. */
  _isSensitiveKey(key: string): boolean {
    const k = key.toLowerCase();
    return (
      this._keys.has(k) ||
      k.includes("token") ||
      k.includes("key") ||
      k.includes("secret") ||
      k.includes("password") ||
      k.includes("credential")
    );
  }

  /** Check if a string value looks like a known secret format. */
  _looksLikeSecret(value: string): boolean {
    for (const pattern of RedactionPolicy.SECRET_VALUE_PATTERNS) {
      if (new RegExp(pattern).test(value)) {
        return true;
      }
    }
    return false;
  }

  /** Apply redaction patterns to a bash command string. */
  redactBashCommand(command: string): string {
    const capped = command.length > RedactionPolicy.MAX_REGEX_INPUT
      ? command.slice(0, RedactionPolicy.MAX_REGEX_INPUT)
      : command;
    let result = capped;
    for (const [regex, replacement] of this._compiledPatterns) {
      regex.lastIndex = 0;
      result = result.replace(regex, replacement);
    }
    return result;
  }

  /** Apply redaction patterns and truncate a result string. */
  redactResult(result: string, maxLength: number = 500): string {
    const capped = result.length > RedactionPolicy.MAX_REGEX_INPUT
      ? result.slice(0, RedactionPolicy.MAX_REGEX_INPUT)
      : result;
    let redacted = capped;
    for (const [regex, replacement] of this._compiledPatterns) {
      regex.lastIndex = 0;
      redacted = redacted.replace(regex, replacement);
    }
    if (redacted.length > maxLength) {
      redacted = redacted.slice(0, maxLength - 3) + "...";
    }
    return redacted;
  }

  /** Cap total serialized size of audit payload. */
  capPayload(data: Record<string, unknown>): Record<string, unknown> {
    const serialized = JSON.stringify(data);
    if (serialized.length > RedactionPolicy.MAX_PAYLOAD_SIZE) {
      data["_truncated"] = true;
      delete data["resultSummary"];
      delete data["toolArgs"];
      data["toolArgs"] = { _redacted: "payload exceeded 32KB" };
    }
    return data;
  }
}
