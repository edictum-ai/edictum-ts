/** Sandbox contract compiler — extract/classify tool call resources and compile sandbox contracts. */

import { realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import type { ToolEnvelope } from "../envelope.js";
import { fnmatch } from "../fnmatch.js";

// ---------------------------------------------------------------------------
// Shell tokenization
// ---------------------------------------------------------------------------

/** Pattern for shell redirection operators at token start. */
const _REDIRECT_PREFIX_RE = /^(?:\d*>>|>>|\d*>|>|<<|<)/;

/**
 * Shell command separators and metacharacters that allow chaining
 * multiple commands. If any of these appear in a raw command string,
 * the command is unsafe — the shell would execute multiple commands.
 *
 * Covers: ;  |  &&  ||  \n  \r  $()  backtick  ${}  <()
 */
const _SHELL_SEPARATOR_RE = /[;|&\n\r`]|\$\(|\$\{|<\(/;

/**
 * Shell-aware tokenization of a command string.
 *
 * Handles single/double quotes. Strips shell redirection operators from
 * token prefixes so paths after redirects (e.g. >/etc/passwd) are exposed.
 * Falls back to basic split with quote stripping on parse error.
 */
export function tokenizeCommand(cmd: string): string[] {
  const rawTokens = _shlexSplit(cmd);

  const tokens: string[] = [];
  for (const t of rawTokens) {
    const stripped = t.replace(_REDIRECT_PREFIX_RE, "");
    if (stripped) tokens.push(stripped);
  }
  return tokens;
}

/** Minimal shlex.split() port — handle single/double quotes. */
function _shlexSplit(s: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  try {
    while (i < s.length) {
      const ch = s.charAt(i);
      if (inSingle) {
        if (ch === "'") { inSingle = false; } else { current += ch; }
      } else if (inDouble) {
        if (ch === '"') { inDouble = false; } else { current += ch; }
      } else if (ch === "'") {
        inSingle = true;
      } else if (ch === '"') {
        inDouble = true;
      } else if (ch === " " || ch === "\t") {
        if (current) { tokens.push(current); current = ""; }
      } else {
        current += ch;
      }
      i++;
    }
    // Unclosed quotes — fall back
    if (inSingle || inDouble) {
      return s.split(/\s+/).filter(Boolean).map((t) => t.replace(/^['"]|['"]$/g, ""));
    }
    if (current) tokens.push(current);
    return tokens;
  } catch {
    return s.split(/\s+/).filter(Boolean).map((t) => t.replace(/^['"]|['"]$/g, ""));
  }
}

// ---------------------------------------------------------------------------
// Path-like argument keys
// ---------------------------------------------------------------------------

const _PATH_ARG_KEYS = new Set([
  "path", "file_path", "filePath", "directory", "dir",
  "folder", "target", "destination", "source", "src", "dst",
]);

/** Resolve a path via realpathSync, falling back to path.resolve for non-existent paths. */
function _realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return pathResolve(p);
  }
}

// ---------------------------------------------------------------------------
// Resource extraction
// ---------------------------------------------------------------------------

/** Extract file paths from an envelope for sandbox evaluation. */
export function extractPaths(envelope: ToolEnvelope): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  function add(p: string): void {
    if (!p) return;
    const resolved = _realpath(p);
    if (!seen.has(resolved)) { seen.add(resolved); paths.push(resolved); }
  }

  if (envelope.filePath) add(envelope.filePath);

  const args = envelope.args as Record<string, unknown>;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && _PATH_ARG_KEYS.has(key)) add(value);
  }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.startsWith("/") && !_PATH_ARG_KEYS.has(key)) add(value);
  }

  const cmd = envelope.bashCommand ?? (args.command as string | undefined) ?? "";
  if (cmd) {
    for (const token of tokenizeCommand(cmd)) {
      if (token.startsWith("/")) add(token);
    }
  }
  return paths;
}

/** Extract the first command token from an envelope (shell-aware). */
export function extractCommand(envelope: ToolEnvelope): string | null {
  const cmd = envelope.bashCommand ?? (envelope.args as Record<string, unknown>).command;
  if (!cmd || typeof cmd !== "string") return null;
  const stripped = cmd.trim();
  if (!stripped) return null;

  // Check for shell command separators/metacharacters BEFORE extracting.
  // If any are present, the shell would execute multiple commands — return
  // sentinel value that never matches any allowlist.
  if (_SHELL_SEPARATOR_RE.test(stripped)) return "\x00";

  const rawFirst = stripped.split(/\s/)[0] ?? "";
  if (_REDIRECT_PREFIX_RE.test(rawFirst)) return "\x00";

  const tokens = tokenizeCommand(stripped);
  return tokens.length > 0 ? (tokens[0] ?? null) : null;
}

/** Extract URL strings from envelope args (shell-aware). */
export function extractUrls(envelope: ToolEnvelope): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  function addUrl(u: string): void {
    if (!seen.has(u)) { seen.add(u); urls.push(u); }
  }

  for (const value of Object.values(envelope.args)) {
    if (typeof value !== "string" || !value.includes("://")) continue;
    if (extractHostname(value) !== null) {
      addUrl(value);
    } else {
      for (const token of tokenizeCommand(value)) {
        if (token.includes("://") && extractHostname(token) !== null) addUrl(token);
      }
    }
  }
  return urls;
}

/** Extract hostname from a URL string. */
export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Check if hostname matches any domain pattern (supports wildcards). */
export function domainMatches(hostname: string, patterns: string[]): boolean {
  return patterns.some((p) => fnmatch(hostname, p));
}
