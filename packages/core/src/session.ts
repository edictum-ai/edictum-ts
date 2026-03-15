/** Session -- atomic counters backed by StorageBackend. */

import type { StorageBackend } from "./storage.js";

// ---------------------------------------------------------------------------
// BatchGet capability detection
// ---------------------------------------------------------------------------

/** StorageBackend that also supports batchGet(). */
interface BatchCapableBackend extends StorageBackend {
  batchGet(keys: readonly string[]): Promise<Record<string, string | null>>;
}

function hasBatchGet(
  backend: StorageBackend,
): backend is BatchCapableBackend {
  return "batchGet" in backend;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Tracks execution state via atomic counters in StorageBackend.
 *
 * All methods are ASYNC because StorageBackend is async.
 *
 * Counter semantics:
 * - attempts: every PreToolUse, including denied (pre-execution)
 * - execs: every PostToolUse (tool actually ran)
 * - tool:{name}: per-tool execution count
 * - consec_fail: resets on success, increments on failure
 */
export class Session {
  private readonly _sid: string;
  private readonly _backend: StorageBackend;

  constructor(sessionId: string, backend: StorageBackend) {
    this._sid = sessionId;
    this._backend = backend;
  }

  get sessionId(): string {
    return this._sid;
  }

  /** Increment attempt counter. Called in PreToolUse (before governance). */
  async incrementAttempts(): Promise<number> {
    return await this._backend.increment(`s:${this._sid}:attempts`);
  }

  async attemptCount(): Promise<number> {
    return Number((await this._backend.get(`s:${this._sid}:attempts`)) ?? 0);
  }

  /** Record a tool execution. Called in PostToolUse. */
  async recordExecution(toolName: string, success: boolean): Promise<void> {
    await this._backend.increment(`s:${this._sid}:execs`);
    await this._backend.increment(`s:${this._sid}:tool:${toolName}`);

    if (success) {
      await this._backend.delete(`s:${this._sid}:consec_fail`);
    } else {
      await this._backend.increment(`s:${this._sid}:consec_fail`);
    }
  }

  async executionCount(): Promise<number> {
    return Number((await this._backend.get(`s:${this._sid}:execs`)) ?? 0);
  }

  async toolExecutionCount(tool: string): Promise<number> {
    return Number(
      (await this._backend.get(`s:${this._sid}:tool:${tool}`)) ?? 0,
    );
  }

  async consecutiveFailures(): Promise<number> {
    return Number(
      (await this._backend.get(`s:${this._sid}:consec_fail`)) ?? 0,
    );
  }

  /**
   * Pre-fetch multiple session counters in a single backend call.
   *
   * Returns a record with keys: "attempts", "execs", and optionally
   * "tool:{name}" if includeTool is provided.
   *
   * Uses batchGet() on the backend when available (single HTTP round
   * trip for ServerBackend). Falls back to individual get() calls for
   * backends without batchGet support.
   */
  async batchGetCounters(options?: {
    includeTool?: string;
  }): Promise<Record<string, number>> {
    const keys: string[] = [
      `s:${this._sid}:attempts`,
      `s:${this._sid}:execs`,
    ];
    const keyLabels: string[] = ["attempts", "execs"];

    if (options?.includeTool != null) {
      keys.push(`s:${this._sid}:tool:${options.includeTool}`);
      keyLabels.push(`tool:${options.includeTool}`);
    }

    let raw: Record<string, string | null>;

    if (hasBatchGet(this._backend)) {
      raw = await this._backend.batchGet(keys);
    } else {
      raw = {};
      for (const key of keys) {
        raw[key] = await this._backend.get(key);
      }
    }

    const result: Record<string, number> = {};
    for (let i = 0; i < keys.length; i++) {
      const label = keyLabels[i] ?? "";
      const key = keys[i] ?? "";
      result[label] = Number(raw[key] ?? 0);
    }
    return result;
  }
}
