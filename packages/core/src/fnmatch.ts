/**
 * Minimal Python fnmatch.fnmatch() port for glob pattern matching.
 *
 * Used by Edictum for rule tool filtering and hook registration.
 */

/**
 * Match a name against a glob pattern (fnmatch-style).
 *
 * Supports: `*` (any sequence), `?` (any single char), literal match.
 * Does NOT support `[...]` character classes (not used by edictum rules).
 *
 * Input capped at 10,000 characters to prevent regex DoS.
 */
export function fnmatch(name: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return name === pattern
  }

  // Cap input length for regex DoS prevention
  const safeName = name.length > 10_000 ? name.slice(0, 10_000) : name
  const safePattern = pattern.length > 10_000 ? pattern.slice(0, 10_000) : pattern

  // Convert glob to regex: escape regex chars, then replace glob wildcards
  let regex = ''
  for (let i = 0; i < safePattern.length; i++) {
    const ch = safePattern[i] ?? ''
    if (ch === '*') {
      regex += '.*'
    } else if (ch === '?') {
      regex += '.'
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch
    } else {
      regex += ch
    }
  }

  return new RegExp('^' + regex + '$').test(safeName)
}
