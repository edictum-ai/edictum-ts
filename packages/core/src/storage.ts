/** StorageBackend interface + MemoryBackend implementation. */

// ---------------------------------------------------------------------------
// StorageBackend — protocol for persistent state storage
// ---------------------------------------------------------------------------

/**
 * Protocol for persistent state storage.
 *
 * Requirements:
 * - increment() MUST be atomic
 * - get/set for simple key-value
 *
 * v0.1.0: No append() method (counters only, no list ops).
 */
export interface StorageBackend {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  increment(key: string, amount?: number): Promise<number>
}

// ---------------------------------------------------------------------------
// MemoryBackend — in-memory implementation for dev/testing
// ---------------------------------------------------------------------------

/**
 * In-memory storage for development and testing.
 *
 * WARNING: State lost on restart. Session rules reset.
 * Suitable for: local dev, tests, single-process scripts.
 *
 * Node.js is single-threaded — Map operations are atomic.
 * No lock needed (unlike Python's asyncio.Lock).
 */
export class MemoryBackend implements StorageBackend {
  private readonly _data: Map<string, string> = new Map()
  private readonly _counters: Map<string, number> = new Map()

  async get(key: string): Promise<string | null> {
    const strVal = this._data.get(key)
    if (strVal !== undefined) {
      return strVal
    }
    const numVal = this._counters.get(key)
    if (numVal !== undefined) {
      return numVal === Math.trunc(numVal) ? String(Math.trunc(numVal)) : String(numVal)
    }
    return null
  }

  async set(key: string, value: string): Promise<void> {
    this._data.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this._data.delete(key)
    this._counters.delete(key)
  }

  async increment(key: string, amount: number = 1): Promise<number> {
    const current = this._counters.get(key) ?? 0
    const next = current + amount
    this._counters.set(key, next)
    return next
  }

  /**
   * Retrieve multiple values in a single operation.
   *
   * In-memory implementation: multiple Map lookups, no network overhead.
   */
  async batchGet(keys: readonly string[]): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {}
    for (const key of keys) {
      result[key] = await this.get(key)
    }
    return result
  }
}
