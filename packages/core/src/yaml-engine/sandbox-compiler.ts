/** Sandbox contract compiler — extract/classify tool call resources and compile sandbox contracts. */

import { realpathSync } from 'node:fs'
import { resolve as pathResolve, sep as pathSep, join as pathJoin } from 'node:path'

import type { ToolEnvelope } from '../envelope.js'
import { fnmatch } from '../fnmatch.js'

// ---------------------------------------------------------------------------
// Shell tokenization
// ---------------------------------------------------------------------------

/** Pattern for shell redirection operators at token start. */
const _REDIRECT_PREFIX_RE = /^(?:\d*>>|>>|\d*>|>|<<|<)/

/**
 * Shell command separators and metacharacters that allow chaining
 * multiple commands. If any of these appear in a raw command string,
 * the command is unsafe — the shell would execute multiple commands.
 *
 * Covers: ;  |  &&  ||  \n  \r  $()  backtick  ${}  <()
 */
const _SHELL_SEPARATOR_RE = /[;|&\n\r`]|\$\(|\$\{|<\(/

/**
 * Shell-aware tokenization of a command string.
 *
 * Handles single/double quotes. Strips shell redirection operators from
 * token prefixes so paths after redirects (e.g. >/etc/passwd) are exposed.
 * Falls back to basic split with quote stripping on parse error.
 */
export function tokenizeCommand(cmd: string): string[] {
  const rawTokens = _shlexSplit(cmd)

  const tokens: string[] = []
  for (const t of rawTokens) {
    const stripped = t.replace(_REDIRECT_PREFIX_RE, '')
    if (stripped) tokens.push(stripped)
  }
  return tokens
}

/** Minimal shlex.split() port — handle single/double quotes. */
function _shlexSplit(s: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let i = 0

  try {
    while (i < s.length) {
      const ch = s.charAt(i)
      if (inSingle) {
        if (ch === "'") {
          inSingle = false
        } else {
          current += ch
        }
      } else if (inDouble) {
        if (ch === '\\' && i + 1 < s.length) {
          // Backslash escaping inside double quotes: \", \\, \$, \`, \newline
          const next = s.charAt(i + 1)
          if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
            current += next
            i++
          } else {
            // Literal backslash for other characters (POSIX behavior)
            current += ch
          }
        } else if (ch === '"') {
          inDouble = false
        } else {
          current += ch
        }
      } else if (ch === "'") {
        inSingle = true
      } else if (ch === '"') {
        inDouble = true
      } else if (ch === ' ' || ch === '\t') {
        if (current) {
          tokens.push(current)
          current = ''
        }
      } else {
        current += ch
      }
      i++
    }
    // Unclosed quotes — fall back
    if (inSingle || inDouble) {
      return s
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => t.replace(/^['"]|['"]$/g, ''))
    }
    if (current) tokens.push(current)
    return tokens
  } catch {
    return s
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.replace(/^['"]|['"]$/g, ''))
  }
}

// ---------------------------------------------------------------------------
// Path-like argument keys
// ---------------------------------------------------------------------------

const _PATH_ARG_KEYS = new Set([
  'path',
  'file_path',
  'filePath',
  'directory',
  'dir',
  'folder',
  'target',
  'destination',
  'source',
  'src',
  'dst',
])

/**
 * Resolve a path like Python's os.path.realpath() — resolve symlinks on
 * existing path components even when the full path doesn't exist.
 *
 * Node's fs.realpathSync() throws ENOENT if the path doesn't exist,
 * whereas Python's os.path.realpath() resolves as much as it can.
 * This matters on macOS where /home/ → /System/Volumes/Data/home/:
 * - Python: realpath("/home/user/file.txt") → "/System/Volumes/Data/home/user/file.txt"
 * - Node:  realpathSync("/home/user/file.txt") → throws → fallback loses symlink info
 *
 * This function walks up the directory tree to find the deepest existing
 * ancestor, resolves its symlinks, then appends the remaining components.
 */
function _realpath(p: string): string {
  const resolved = pathResolve(p)
  try {
    return realpathSync(resolved)
  } catch {
    // Walk up to find deepest existing ancestor and resolve its symlinks
    const parts = resolved.split(pathSep)
    for (let i = parts.length - 1; i > 0; i--) {
      const prefix = parts.slice(0, i).join(pathSep) || '/'
      try {
        const realPrefix = realpathSync(prefix)
        const rest = parts.slice(i).join(pathSep)
        return pathJoin(realPrefix, rest)
      } catch {
        continue
      }
    }
    return resolved
  }
}

// ---------------------------------------------------------------------------
// Resource extraction
// ---------------------------------------------------------------------------

/** Extract file paths from an envelope for sandbox evaluation. */
export function extractPaths(envelope: ToolEnvelope): string[] {
  const paths: string[] = []
  const seen = new Set<string>()

  function add(p: string): void {
    if (!p) return
    const resolved = _realpath(p)
    if (!seen.has(resolved)) {
      seen.add(resolved)
      paths.push(resolved)
    }
  }

  if (envelope.filePath) add(envelope.filePath)

  const args = envelope.args as Record<string, unknown>
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && _PATH_ARG_KEYS.has(key)) add(value)
  }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.startsWith('/') && !_PATH_ARG_KEYS.has(key)) add(value)
  }

  const cmd = envelope.bashCommand ?? (args.command as string | undefined) ?? ''
  if (cmd) {
    for (const token of tokenizeCommand(cmd)) {
      if (token.startsWith('/')) add(token)
    }
  }
  return paths
}

/** Extract the first command token from an envelope (shell-aware). */
export function extractCommand(envelope: ToolEnvelope): string | null {
  const cmd = envelope.bashCommand ?? (envelope.args as Record<string, unknown>).command
  if (!cmd || typeof cmd !== 'string') return null
  const stripped = cmd.trim()
  if (!stripped) return null

  // Check for shell command separators/metacharacters BEFORE extracting.
  // If any are present, the shell would execute multiple commands — return
  // sentinel value that never matches any allowlist.
  if (_SHELL_SEPARATOR_RE.test(stripped)) return '\x00'

  const rawFirst = stripped.split(/\s/)[0] ?? ''
  if (_REDIRECT_PREFIX_RE.test(rawFirst)) return '\x00'

  const tokens = tokenizeCommand(stripped)
  return tokens.length > 0 ? (tokens[0] ?? null) : null
}

/** Extract URL strings from envelope args (shell-aware). */
export function extractUrls(envelope: ToolEnvelope): string[] {
  const urls: string[] = []
  const seen = new Set<string>()

  function addUrl(u: string): void {
    if (!seen.has(u)) {
      seen.add(u)
      urls.push(u)
    }
  }

  for (const value of Object.values(envelope.args)) {
    if (typeof value !== 'string' || !value.includes('://')) continue
    if (extractHostname(value) !== null) {
      addUrl(value)
    } else {
      for (const token of tokenizeCommand(value)) {
        if (token.includes('://') && extractHostname(token) !== null) addUrl(token)
      }
    }
  }
  return urls
}

/** Extract hostname from a URL string. */
export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/** Check if hostname matches any domain pattern (supports wildcards). */
export function domainMatches(hostname: string, patterns: string[]): boolean {
  return patterns.some((p) => fnmatch(hostname, p))
}
