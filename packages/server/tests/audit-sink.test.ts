import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createAuditEvent, AuditAction } from "@edictum/core";

import { EdictumServerClient } from "../src/client.js";
import { ServerAuditSink } from "../src/audit-sink.js";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function mockClient(overrides?: Partial<EdictumServerClient>): EdictumServerClient {
  return {
    post: vi.fn().mockResolvedValue({}),
    agentId: "test-agent",
    env: "test",
    bundleName: "test-bundle",
    ...overrides,
  } as unknown as EdictumServerClient;
}

function makeEvent(overrides?: Partial<Parameters<typeof createAuditEvent>[0]>) {
  return createAuditEvent({
    callId: "call-1",
    toolName: "Bash",
    action: AuditAction.CALL_ALLOWED,
    mode: "enforce",
    sideEffect: "write",
    environment: "test",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

describe("ServerAuditSink batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers events until batch size is reached", async () => {
    const client = mockClient();
    const sink = new ServerAuditSink(client, { batchSize: 3 });

    await sink.emit(makeEvent({ callId: "1" }));
    await sink.emit(makeEvent({ callId: "2" }));

    // Not flushed yet
    expect(client.post).not.toHaveBeenCalled();

    await sink.emit(makeEvent({ callId: "3" }));

    // Batch full, should flush
    expect(client.post).toHaveBeenCalledOnce();
    const [path, body] = vi.mocked(client.post).mock.calls[0]!;
    expect(path).toBe("/api/v1/events");
    expect((body as { events: unknown[] }).events).toHaveLength(3);
  });

  it("auto-flushes after interval", async () => {
    const client = mockClient();
    const sink = new ServerAuditSink(client, {
      batchSize: 100,
      flushInterval: 1000,
    });

    await sink.emit(makeEvent());

    expect(client.post).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1100);

    expect(client.post).toHaveBeenCalledOnce();
  });

  it("manual flush sends all buffered events", async () => {
    const client = mockClient();
    const sink = new ServerAuditSink(client, { batchSize: 100 });

    await sink.emit(makeEvent({ callId: "a" }));
    await sink.emit(makeEvent({ callId: "b" }));

    await sink.flush();

    expect(client.post).toHaveBeenCalledOnce();
    const body = vi.mocked(client.post).mock.calls[0]![1] as { events: unknown[] };
    expect(body.events).toHaveLength(2);
  });

  it("flush is a no-op when buffer is empty", async () => {
    const client = mockClient();
    const sink = new ServerAuditSink(client, { batchSize: 100 });

    await sink.flush();

    expect(client.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Buffer overflow
// ---------------------------------------------------------------------------

describe("ServerAuditSink buffer overflow", () => {
  it("drops oldest events when buffer exceeds max", async () => {
    const client = mockClient();
    // Make post always fail so events get restored
    vi.mocked(client.post).mockRejectedValue(new Error("network error"));

    const sink = new ServerAuditSink(client, {
      batchSize: 3,
      maxBufferSize: 5,
    });

    // Emit 3 events — triggers flush which fails, restores to buffer
    await sink.emit(makeEvent({ callId: "1" }));
    await sink.emit(makeEvent({ callId: "2" }));
    await sink.emit(makeEvent({ callId: "3" }));

    // Buffer now has 3 events restored. Add more to overflow.
    await sink.emit(makeEvent({ callId: "4" }));
    await sink.emit(makeEvent({ callId: "5" }));
    await sink.emit(makeEvent({ callId: "6" }));
    // This flush fails again, restoring 3 events (4,5,6) + existing 3 = 6 > 5
    // Oldest 1 should be dropped

    // Now make flush succeed to inspect buffer state
    vi.mocked(client.post).mockResolvedValue({});
    await sink.flush();

    const lastCall = vi.mocked(client.post).mock.lastCall;
    const body = lastCall![1] as { events: Array<{ call_id: string }> };
    expect(body.events.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Failed flush restore
// ---------------------------------------------------------------------------

describe("ServerAuditSink failed flush restore", () => {
  it("restores events to buffer on flush failure", async () => {
    const client = mockClient();
    vi.mocked(client.post)
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({});

    const sink = new ServerAuditSink(client, { batchSize: 100 });

    await sink.emit(makeEvent({ callId: "x" }));
    await sink.flush(); // fails, events restored

    // Second flush should send the same events
    await sink.flush();

    expect(client.post).toHaveBeenCalledTimes(2);
    const body = vi.mocked(client.post).mock.calls[1]![1] as {
      events: Array<{ call_id: string }>;
    };
    expect(body.events[0]!.call_id).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

describe("ServerAuditSink event mapping", () => {
  it("maps AuditEvent to server format correctly via POST body", async () => {
    const client = mockClient({ bundleName: "my-bundle" });
    const sink = new ServerAuditSink(client, { batchSize: 1 });
    const event = makeEvent({
      callId: "c1",
      toolName: "Bash",
      action: AuditAction.CALL_DENIED,
      mode: "enforce",
      sideEffect: "write",
      environment: "prod",
      decisionSource: "precondition",
      decisionName: "no-rm",
      reason: "rm -rf denied",
      policyVersion: "v1.0",
    });

    await sink.emit(event);

    expect(client.post).toHaveBeenCalledOnce();
    const body = vi.mocked(client.post).mock.calls[0]![1] as {
      events: Array<{
        call_id: string;
        agent_id: string;
        tool_name: string;
        verdict: string;
        mode: string;
        timestamp: string;
        payload: {
          side_effect: string;
          environment: string;
          decision_source: string | null;
          decision_name: string | null;
          reason: string | null;
          policy_version: string | null;
          bundle_name: string | null;
        };
      }>;
    };
    const mapped = body.events[0]!;
    expect(mapped.call_id).toBe("c1");
    expect(mapped.agent_id).toBe("test-agent");
    expect(mapped.tool_name).toBe("Bash");
    expect(mapped.verdict).toBe("call_denied");
    expect(mapped.mode).toBe("enforce");
    expect(mapped.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mapped.payload.side_effect).toBe("write");
    expect(mapped.payload.environment).toBe("prod");
    expect(mapped.payload.decision_source).toBe("precondition");
    expect(mapped.payload.decision_name).toBe("no-rm");
    expect(mapped.payload.reason).toBe("rm -rf denied");
    expect(mapped.payload.policy_version).toBe("v1.0");
    expect(mapped.payload.bundle_name).toBe("my-bundle");
  });

  it("uses client env when event environment is empty", async () => {
    const client = mockClient({ env: "staging" });
    const sink = new ServerAuditSink(client, { batchSize: 1 });
    const event = makeEvent({ environment: "" });

    await sink.emit(event);

    const body = vi.mocked(client.post).mock.calls[0]![1] as {
      events: Array<{ payload: { environment: string } }>;
    };
    expect(body.events[0]!.payload.environment).toBe("staging");
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("ServerAuditSink.close", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes remaining events on close", async () => {
    const client = mockClient();
    const sink = new ServerAuditSink(client, { batchSize: 100 });

    await sink.emit(makeEvent());
    await sink.close();

    expect(client.post).toHaveBeenCalledOnce();
  });

  it("cancels auto-flush timer on close", async () => {
    const client = mockClient();
    const sink = new ServerAuditSink(client, {
      batchSize: 100,
      flushInterval: 5000,
    });

    await sink.emit(makeEvent());
    await sink.close();

    // Advance time — should not trigger another flush
    vi.mocked(client.post).mockClear();
    await vi.advanceTimersByTimeAsync(6000);

    expect(client.post).not.toHaveBeenCalled();
  });
});
