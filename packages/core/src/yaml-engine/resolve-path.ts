/** Cross-platform path resolution that matches Python's os.path.realpath(). */

import { realpathSync } from 'node:fs'
import { resolve as pathResolve, sep as pathSep, join as pathJoin } from 'node:path'

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
 *
 * Security: only ENOENT triggers the walk-up fallback. EACCES (permission
 * denied) and ELOOP (circular symlink) return the normalized path without
 * partial resolution — fail closed when the true target is unknowable.
 */
export function resolvePath(p: string): string {
  const resolved = pathResolve(p)
  try {
    return realpathSync(resolved)
  } catch (err: unknown) {
    // Only apply the walk-up fallback for ENOENT (path doesn't exist yet).
    // For EACCES, ELOOP, or any other error, return the normalized path
    // without attempting partial resolution — we cannot safely determine
    // the true target and must fail closed.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return resolved
    }
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
