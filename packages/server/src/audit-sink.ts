/** Server-backed audit sink with batching. */

import type { AuditEvent, AuditSink } from "@edictum/core";
import { EdictumConfigError } from "@edictum/core";

import type { EdictumServerClient } from "./client.js";

/** Deep-copy with fallback to JSON roundtrip for non-cloneable values. */
function safeClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

interface ServerEventPayload {
  call_id: string;
  agent_id: string;
  tool_name: string;
  verdict: string;
  mode: string;
  timestamp: string;
  payload: {
    tool_args: Record<string, unknown>;
    side_effect: string;
    environment: string;
    principal: Record<string, unknown> | null;
    decision_source: string | null;
    decision_name: string | null;
    reason: string | null;
    policy_version: string | null;
    bundle_name: string | null;
  };
}

/**
 * Audit sink that sends events to the edictum-server.
 *
 * Batches events and flushes periodically or when batch is full.
 */
export class ServerAuditSink implements AuditSink {
  static readonly MAX_BUFFER_SIZE = 10_000;

  private readonly _client: EdictumServerClient;
  private readonly _batchSize: number;
  private readonly _flushInterval: number;
  private readonly _maxBufferSize: number;
  private _buffer: ServerEventPayload[] = [];
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    client: EdictumServerClient,
    options?: {
      batchSize?: number;
      flushInterval?: number;
      maxBufferSize?: number;
    },
  ) {
    this._client = client;
    this._batchSize = options?.batchSize ?? 50;
    this._flushInterval = options?.flushInterval ?? 5_000;
    this._maxBufferSize =
      options?.maxBufferSize ?? ServerAuditSink.MAX_BUFFER_SIZE;

    if (!Number.isInteger(this._batchSize) || this._batchSize < 1) {
      throw new EdictumConfigError(
        `batchSize must be an integer >= 1, got ${this._batchSize}`,
      );
    }
    if (!Number.isFinite(this._flushInterval) || this._flushInterval <= 0) {
      throw new EdictumConfigError(
        `flushInterval must be a positive finite number, got ${this._flushInterval}`,
      );
    }
    if (!Number.isInteger(this._maxBufferSize) || this._maxBufferSize < 1) {
      throw new EdictumConfigError(
        `maxBufferSize must be an integer >= 1, got ${this._maxBufferSize}`,
      );
    }
    if (this._maxBufferSize > ServerAuditSink.MAX_BUFFER_SIZE) {
      throw new EdictumConfigError(
        `maxBufferSize must be <= ${ServerAuditSink.MAX_BUFFER_SIZE}, got ${this._maxBufferSize}`,
      );
    }
    if (this._batchSize > this._maxBufferSize) {
      throw new EdictumConfigError(
        `batchSize (${this._batchSize}) must be <= maxBufferSize (${this._maxBufferSize})`,
      );
    }
  }

  /** Convert an AuditEvent to server format and add to batch buffer. */
  async emit(event: AuditEvent): Promise<void> {
    const payload = this._mapEvent(event);
    this._buffer.push(payload);
    const needsFlush = this._buffer.length >= this._batchSize;

    if (needsFlush) {
      await this._flush();
    } else {
      this._scheduleAutoFlush();
    }
  }

  /** Map an AuditEvent to the server EventPayload format. */
  private _mapEvent(event: AuditEvent): ServerEventPayload {
    return {
      call_id: event.callId,
      agent_id: this._client.agentId,
      tool_name: event.toolName,
      verdict: event.action,
      mode: event.mode,
      timestamp: event.timestamp.toISOString(),
      payload: {
        tool_args: safeClone(event.toolArgs),
        side_effect: event.sideEffect,
        environment: event.environment || this._client.env,
        principal: event.principal !== null ? safeClone(event.principal) : null,
        decision_source: event.decisionSource,
        decision_name: event.decisionName,
        reason: event.reason,
        policy_version: event.policyVersion,
        bundle_name: this._client.bundleName,
      },
    };
  }

  /** Flush all buffered events to the server. */
  async flush(): Promise<void> {
    await this._flush();
  }

  private async _flush(): Promise<void> {
    if (this._buffer.length === 0) {
      return;
    }

    const events = [...this._buffer];
    this._buffer = [];

    try {
      await this._client.post("/api/v1/events", { events });
    } catch (error) {
      this._restoreEvents(events);
      // Rethrow non-Error throwables and client auth errors (4xx except 429)
      // so credential failures surface immediately instead of silently retrying
      if (!(error instanceof Error)) throw error;
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw error;
      }
      // Only log retry message for retryable errors (network, 5xx, 429)
      console.warn(
        `Failed to flush ${events.length} audit events, keeping in buffer for retry`,
      );
    }
  }

  private _restoreEvents(events: ServerEventPayload[]): void {
    this._buffer = [...events, ...this._buffer];
    if (this._buffer.length > this._maxBufferSize) {
      const dropped = this._buffer.length - this._maxBufferSize;
      console.warn(
        `[edictum] audit buffer overflow: dropping ${dropped} oldest events (buffer capped at ${this._maxBufferSize})`,
      );
      this._buffer = this._buffer.slice(dropped);
    }
  }

  private _scheduleAutoFlush(): void {
    if (this._flushTimer !== null) {
      return;
    }
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch((err: unknown) => {
        // Auto-flush is fire-and-forget. Auth errors (4xx) will surface on
        // the next explicit emit→flush path. Log here to aid debugging.
        console.warn(
          `[edictum] auto-flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this._flushInterval);
  }

  /** Flush remaining events and cancel the background flush timer. */
  async close(): Promise<void> {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    await this.flush();
  }
}
