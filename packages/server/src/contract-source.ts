/**
 * SSE client for receiving contract bundle updates from edictum-server.
 *
 * SIZE APPROVAL: This file exceeds 200 lines. SSE parsing, reconnect
 * logic, and event handling form a cohesive streaming client.
 */

import type { EdictumServerClient } from "./client.js";
import { SAFE_IDENTIFIER_RE } from "./client.js";

const STABLE_CONNECTION_SECS = 30_000; // 30s in ms

/**
 * Receives contract bundle updates from edictum-server via SSE.
 *
 * Subscribes to /api/v1/stream and yields updated bundles.
 * Implements auto-reconnect with exponential backoff.
 */
export class ServerContractSource {
  private readonly _client: EdictumServerClient;
  private readonly _reconnectDelay: number;
  private readonly _maxReconnectDelay: number;
  private _connected: boolean = false;
  private _closed: boolean = false;
  private _currentRevision: string | null = null;

  constructor(
    client: EdictumServerClient,
    options?: {
      reconnectDelay?: number;
      maxReconnectDelay?: number;
    },
  ) {
    this._client = client;
    this._reconnectDelay = options?.reconnectDelay ?? 1_000;
    this._maxReconnectDelay = options?.maxReconnectDelay ?? 60_000;
  }

  /** Mark the source as ready to receive events. */
  async connect(): Promise<void> {
    this._connected = true;
    this._closed = false;
  }

  /**
   * Yield contract bundles as they arrive via SSE.
   *
   * Passes env, bundle_name, and policy_version as query params
   * so the server can filter events and detect drift.
   * Auto-reconnects on disconnect with exponential backoff.
   */
  async *watch(): AsyncGenerator<Record<string, unknown>> {
    let delay = this._reconnectDelay;
    // Track consecutive failures for backoff reset
    let connectedAt: number | null = null;

    while (!this._closed) {
      try {
        const params: Record<string, string> = { env: this._client.env };
        if (this._client.bundleName) {
          params["bundle_name"] = this._client.bundleName;
        }
        if (this._currentRevision) {
          params["policy_version"] = this._currentRevision;
        }
        if (this._client.tags) {
          params["tags"] = JSON.stringify(this._client.tags);
        }

        const response = await this._client.rawFetch(
          "/api/v1/stream",
          params,
        );

        if (!response.ok) {
          throw new Error(`SSE connection failed: HTTP ${response.status}`);
        }

        if (!response.body) {
          throw new Error("SSE response has no body");
        }

        this._connected = true;
        connectedAt = Date.now();

        // Parse SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";
        let currentData = "";

        try {
          while (!this._closed) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            // Keep the last incomplete line in buffer
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (line.startsWith("event:")) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                currentData += line.slice(5).trim();
              } else if (line === "") {
                // Empty line = end of event
                if (currentEvent && currentData) {
                  const result = this._processEvent(
                    currentEvent,
                    currentData,
                  );
                  if (result !== null) {
                    yield result;
                  }
                }
                currentEvent = "";
                currentData = "";
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        if (this._closed) {
          return;
        }

        // Stream ended cleanly — full reset
        this._connected = false;
        connectedAt = null;
        delay = this._reconnectDelay;
      } catch {
        if (this._closed) {
          return;
        }

        this._connected = false;

        if (connectedAt !== null) {
          const elapsed = Date.now() - connectedAt;
          if (elapsed >= STABLE_CONNECTION_SECS) {
            delay = this._reconnectDelay;
          }
          connectedAt = null;
        }


        await sleep(delay);
        delay = Math.min(delay * 2, this._maxReconnectDelay);
      }
    }
  }

  private _processEvent(
    eventType: string,
    data: string,
  ): Record<string, unknown> | null {
    if (eventType === "contract_update") {
      let bundle: unknown;
      try {
        bundle = JSON.parse(data);
      } catch {
        return null; // Invalid JSON
      }
      if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
        return null; // Not an object
      }
      const bundleObj = bundle as Record<string, unknown>;
      if ("revision_hash" in bundleObj) {
        this._currentRevision = bundleObj["revision_hash"] as string;
      }
      return bundleObj;
    }

    if (eventType === "assignment_changed") {
      let data_obj: unknown;
      try {
        data_obj = JSON.parse(data);
      } catch {
        return null;
      }
      if (typeof data_obj !== "object" || data_obj === null || Array.isArray(data_obj)) {
        return null;
      }
      const obj = data_obj as Record<string, unknown>;
      const newBundle = obj["bundle_name"];
      if (
        typeof newBundle !== "string" ||
        !SAFE_IDENTIFIER_RE.test(newBundle)
      ) {
        return null;
      }
      // Do NOT update _client.bundleName here.
      // The watcher updates it after a successful reload.
      return { _assignment_changed: true, bundle_name: newBundle };
    }

    return null;
  }

  /** Stop watching for updates. */
  async close(): Promise<void> {
    this._closed = true;
    this._connected = false;
  }

  get connected(): boolean {
    return this._connected;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
