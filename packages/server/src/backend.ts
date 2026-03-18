/**
 * Server-backed storage backend for distributed session state.
 *
 * Fail-closed contract: when the server is unreachable or returns a
 * non-404 error, methods raise rather than returning defaults. The
 * governance pipeline treats unhandled exceptions as deny decisions,
 * so propagating errors here ensures that session-based rate limits
 * cannot be silently bypassed by a network outage.
 */

import type { StorageBackend } from "@edictum/core";

import type { EdictumServerClient} from "./client.js";
import { EdictumServerError } from "./client.js";

/**
 * Storage backend that delegates session state to edictum-server.
 *
 * Implements the StorageBackend protocol, forwarding all operations
 * to the server's session state API.
 */
export class ServerBackend implements StorageBackend {
  private readonly _client: EdictumServerClient;

  constructor(client: EdictumServerClient) {
    this._client = client;
  }

  /**
   * Retrieve a value from the server session store.
   *
   * Returns null only when the key genuinely does not exist (HTTP 404).
   * All other errors propagate so the pipeline fails closed.
   */
  async get(key: string): Promise<string | null> {
    try {
      const response = await this._client.get(`/api/v1/sessions/${encodeURIComponent(key)}`);
      return (response["value"] as string) ?? null;
    } catch (error) {
      if (error instanceof EdictumServerError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Set a value in the server session store. */
  async set(key: string, value: string): Promise<void> {
    await this._client.put(`/api/v1/sessions/${encodeURIComponent(key)}`, { value });
  }

  /** Delete a key from the server session store. */
  async delete(key: string): Promise<void> {
    try {
      await this._client.delete(`/api/v1/sessions/${encodeURIComponent(key)}`);
    } catch (error) {
      if (error instanceof EdictumServerError && error.statusCode === 404) {
        return;
      }
      throw error;
    }
  }

  /** Atomically increment a counter on the server. */
  async increment(key: string, amount: number = 1): Promise<number> {
    const response = await this._client.post(
      `/api/v1/sessions/${encodeURIComponent(key)}/increment`,
      { amount },
    );
    return response["value"] as number;
  }

  /**
   * Retrieve multiple session values in a single HTTP call.
   *
   * Falls back to individual get() calls if the server returns 404
   * or 405 (endpoint not available on older servers).
   *
   * Fail-closed: other errors propagate so the pipeline denies
   * rather than silently allowing with missing data.
   */
  async batchGet(keys: readonly string[]): Promise<Record<string, string | null>> {
    if (keys.length === 0) {
      return {};
    }

    try {
      const response = await this._client.post("/api/v1/sessions/batch", {
        keys: [...keys],
      });
      const values = (response["values"] as Record<string, string>) ?? {};
      const result: Record<string, string | null> = {};
      for (const key of keys) {
        result[key] = (values[key] as string) ?? null;
      }
      return result;
    } catch (error) {
      if (
        error instanceof EdictumServerError &&
        (error.statusCode === 404 || error.statusCode === 405)
      ) {
        // Server doesn't support batch endpoint -- fall back
        const result: Record<string, string | null> = {};
        for (const key of keys) {
          result[key] = await this.get(key);
        }
        return result;
      }
      throw error;
    }
  }
}
