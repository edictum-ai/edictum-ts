import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { EdictumServerClient } from "../src/client.js";
import { ServerContractSource } from "../src/contract-source.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockClient(
  overrides?: Partial<EdictumServerClient>,
): EdictumServerClient {
  return {
    rawFetch: vi.fn(),
    agentId: "test-agent",
    env: "test",
    bundleName: null,
    tags: null,
    ...overrides,
  } as unknown as EdictumServerClient;
}

/** Create a ReadableStream from SSE text lines. */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const text = lines.join("\n") + "\n";
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Create a Response with an SSE body. */
function sseResponse(lines: string[]): Response {
  return new Response(sseStream(lines), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

describe("ServerContractSource.watch", () => {
  it("yields contract_update events", async () => {
    const bundle = { apiVersion: "edictum/v1", revision_hash: "abc123" };
    const client = mockClient();
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: contract_update`,
        `data: ${JSON.stringify(bundle)}`,
        ``,
      ]),
    );

    const source = new ServerContractSource(client);
    const results: Record<string, unknown>[] = [];

    for await (const item of source.watch()) {
      results.push(item);
      // Close after first event to stop the loop
      await source.close();
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(bundle);
  });

  it("yields assignment_changed events", async () => {
    const client = mockClient();
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: assignment_changed`,
        `data: ${JSON.stringify({ bundle_name: "new-bundle" })}`,
        ``,
      ]),
    );

    const source = new ServerContractSource(client);
    const results: Record<string, unknown>[] = [];

    for await (const item of source.watch()) {
      results.push(item);
      await source.close();
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      _assignment_changed: true,
      bundle_name: "new-bundle",
    });
  });

  it("skips invalid JSON in contract_update", async () => {
    const validBundle = { valid: true, revision_hash: "r1" };
    const client = mockClient();
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: contract_update`,
        `data: not-json`,
        ``,
        `event: contract_update`,
        `data: ${JSON.stringify(validBundle)}`,
        ``,
      ]),
    );

    const source = new ServerContractSource(client);
    const results: Record<string, unknown>[] = [];

    for await (const item of source.watch()) {
      results.push(item);
      await source.close();
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(validBundle);
  });

  it("skips non-object payloads", async () => {
    const validBundle = { ok: true };
    const client = mockClient();
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: contract_update`,
        `data: "just a string"`,
        ``,
        `event: contract_update`,
        `data: [1, 2, 3]`,
        ``,
        `event: contract_update`,
        `data: ${JSON.stringify(validBundle)}`,
        ``,
      ]),
    );

    const source = new ServerContractSource(client);
    const results: Record<string, unknown>[] = [];

    for await (const item of source.watch()) {
      results.push(item);
      await source.close();
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(validBundle);
  });

  it("skips assignment_changed with invalid bundle_name", async () => {
    const client = mockClient();
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: assignment_changed`,
        `data: ${JSON.stringify({ bundle_name: "../escape" })}`,
        ``,
        `event: assignment_changed`,
        `data: ${JSON.stringify({ bundle_name: "valid-name" })}`,
        ``,
      ]),
    );

    const source = new ServerContractSource(client);
    const results: Record<string, unknown>[] = [];

    for await (const item of source.watch()) {
      results.push(item);
      await source.close();
    }

    expect(results).toHaveLength(1);
    expect(results[0]!["bundle_name"]).toBe("valid-name");
  });

  it("ignores unknown event types", async () => {
    const bundle = { data: true };
    const client = mockClient();
    vi.mocked(client.rawFetch).mockResolvedValueOnce(
      sseResponse([
        `event: heartbeat`,
        `data: {}`,
        ``,
        `event: contract_update`,
        `data: ${JSON.stringify(bundle)}`,
        ``,
      ]),
    );

    const source = new ServerContractSource(client);
    const results: Record<string, unknown>[] = [];

    for await (const item of source.watch()) {
      results.push(item);
      await source.close();
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(bundle);
  });
});

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

describe("ServerContractSource query params", () => {
  it("passes env to rawFetch", async () => {
    const client = mockClient({ env: "production" });
    const source = new ServerContractSource(client);

    // Close after first fetch attempt to prevent reconnect loop
    vi.mocked(client.rawFetch).mockImplementation(async () => {
      await source.close();
      return sseResponse([]);
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of source.watch()) {
      // Should not yield anything
    }

    expect(client.rawFetch).toHaveBeenCalledWith(
      "/api/v1/stream",
      { env: "production" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("passes bundle_name when set", async () => {
    const client = mockClient({ bundleName: "my-bundle" });
    const source = new ServerContractSource(client);

    vi.mocked(client.rawFetch).mockImplementation(async () => {
      await source.close();
      return sseResponse([]);
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of source.watch()) {
      // noop
    }

    const params = vi.mocked(client.rawFetch).mock.calls[0]![1];
    expect(params).toHaveProperty("bundle_name", "my-bundle");
  });

  it("passes tags as JSON when set", async () => {
    const client = mockClient({ tags: { team: "platform" } });
    const source = new ServerContractSource(client);

    vi.mocked(client.rawFetch).mockImplementation(async () => {
      await source.close();
      return sseResponse([]);
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of source.watch()) {
      // noop
    }

    const params = vi.mocked(client.rawFetch).mock.calls[0]![1];
    expect(params).toHaveProperty("tags", JSON.stringify({ team: "platform" }));
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("ServerContractSource.close", () => {
  it("sets connected to false", async () => {
    const client = mockClient();
    const source = new ServerContractSource(client);

    await source.connect();
    expect(source.connected).toBe(true);

    await source.close();
    expect(source.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reconnect (unit-level)
// ---------------------------------------------------------------------------

describe("ServerContractSource reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects on HTTP error", async () => {
    const client = mockClient();
    const bundle = { reconnected: true };

    vi.mocked(client.rawFetch)
      .mockResolvedValueOnce(new Response("Server Error", { status: 500 }))
      .mockResolvedValueOnce(
        sseResponse([
          `event: contract_update`,
          `data: ${JSON.stringify(bundle)}`,
          ``,
        ]),
      );

    const source = new ServerContractSource(client, { reconnectDelay: 100 });
    const results: Record<string, unknown>[] = [];

    const watchPromise = (async () => {
      for await (const item of source.watch()) {
        results.push(item);
        await source.close();
      }
    })();

    // Advance past reconnect delay
    await vi.advanceTimersByTimeAsync(200);
    await watchPromise;

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(bundle);
    expect(client.rawFetch).toHaveBeenCalledTimes(2);
  });
});
