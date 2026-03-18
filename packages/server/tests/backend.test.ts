import { describe, expect, it, vi, beforeEach } from "vitest";

import { EdictumServerClient, EdictumServerError } from "../src/client.js";
import { ServerBackend } from "../src/backend.js";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function mockClient(): EdictumServerClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    agentId: "test-agent",
    env: "test",
    bundleName: null,
  } as unknown as EdictumServerClient;
}

// ---------------------------------------------------------------------------
// ServerBackend.get
// ---------------------------------------------------------------------------

describe("ServerBackend.get", () => {
  let client: EdictumServerClient;
  let backend: ServerBackend;

  beforeEach(() => {
    client = mockClient();
    backend = new ServerBackend(client);
  });

  it("returns value from server", async () => {
    vi.mocked(client.get).mockResolvedValue({ value: "hello" });

    const result = await backend.get("session:123:count");
    expect(result).toBe("hello");
    expect(client.get).toHaveBeenCalledWith("/api/v1/sessions/session%3A123%3Acount");
  });

  it("returns null on 404", async () => {
    vi.mocked(client.get).mockRejectedValue(new EdictumServerError(404, "Not Found"));

    const result = await backend.get("missing-key");
    expect(result).toBeNull();
  });

  it("propagates non-404 errors (fail-closed)", async () => {
    vi.mocked(client.get).mockRejectedValue(new EdictumServerError(500, "Server Error"));

    await expect(backend.get("key")).rejects.toThrow(EdictumServerError);
  });

  it("returns null when value field is missing", async () => {
    vi.mocked(client.get).mockResolvedValue({});

    const result = await backend.get("key");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ServerBackend.set
// ---------------------------------------------------------------------------

describe("ServerBackend.set", () => {
  it("calls PUT with correct path and body", async () => {
    const client = mockClient();
    vi.mocked(client.put).mockResolvedValue({});
    const backend = new ServerBackend(client);

    await backend.set("my-key", "my-value");

    expect(client.put).toHaveBeenCalledWith("/api/v1/sessions/my-key", {
      value: "my-value",
    });
  });
});

// ---------------------------------------------------------------------------
// ServerBackend.delete
// ---------------------------------------------------------------------------

describe("ServerBackend.delete", () => {
  it("calls DELETE with correct path", async () => {
    const client = mockClient();
    vi.mocked(client.delete).mockResolvedValue({});
    const backend = new ServerBackend(client);

    await backend.delete("my-key");

    expect(client.delete).toHaveBeenCalledWith("/api/v1/sessions/my-key");
  });

  it("ignores 404 on delete", async () => {
    const client = mockClient();
    vi.mocked(client.delete).mockRejectedValue(new EdictumServerError(404, "Not Found"));
    const backend = new ServerBackend(client);

    await expect(backend.delete("missing-key")).resolves.toBeUndefined();
  });

  it("propagates non-404 errors on delete", async () => {
    const client = mockClient();
    vi.mocked(client.delete).mockRejectedValue(new EdictumServerError(500, "Error"));
    const backend = new ServerBackend(client);

    await expect(backend.delete("key")).rejects.toThrow(EdictumServerError);
  });
});

// ---------------------------------------------------------------------------
// ServerBackend.increment
// ---------------------------------------------------------------------------

describe("ServerBackend.increment", () => {
  it("calls POST and returns new value", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ value: 5 });
    const backend = new ServerBackend(client);

    const result = await backend.increment("counter", 2);

    expect(result).toBe(5);
    expect(client.post).toHaveBeenCalledWith(
      "/api/v1/sessions/counter/increment",
      { amount: 2 },
    );
  });

  it("defaults amount to 1", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ value: 1 });
    const backend = new ServerBackend(client);

    await backend.increment("counter");

    expect(client.post).toHaveBeenCalledWith(
      "/api/v1/sessions/counter/increment",
      { amount: 1 },
    );
  });
});

// ---------------------------------------------------------------------------
// ServerBackend.batchGet
// ---------------------------------------------------------------------------

describe("ServerBackend.batchGet", () => {
  it("returns empty object for empty keys", async () => {
    const client = mockClient();
    const backend = new ServerBackend(client);

    const result = await backend.batchGet([]);
    expect(result).toEqual({});
    expect(client.post).not.toHaveBeenCalled();
  });

  it("returns values from batch endpoint", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      values: { a: "1", b: "2" },
    });
    const backend = new ServerBackend(client);

    const result = await backend.batchGet(["a", "b", "c"]);

    expect(result).toEqual({ a: "1", b: "2", c: null });
    expect(client.post).toHaveBeenCalledWith("/api/v1/sessions/batch", {
      keys: ["a", "b", "c"],
    });
  });

  it("falls back to individual gets on 404", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockRejectedValue(new EdictumServerError(404, "Not Found"));
    vi.mocked(client.get)
      .mockResolvedValueOnce({ value: "x" })
      .mockRejectedValueOnce(new EdictumServerError(404, "Not Found"));
    const backend = new ServerBackend(client);

    const result = await backend.batchGet(["a", "b"]);

    expect(result).toEqual({ a: "x", b: null });
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it("falls back to individual gets on 405", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockRejectedValue(new EdictumServerError(405, "Method Not Allowed"));
    vi.mocked(client.get).mockResolvedValue({ value: "v" });
    const backend = new ServerBackend(client);

    const result = await backend.batchGet(["k1"]);

    expect(result).toEqual({ k1: "v" });
  });

  it("propagates non-404/405 errors from batch", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockRejectedValue(new EdictumServerError(500, "Error"));
    const backend = new ServerBackend(client);

    await expect(backend.batchGet(["a"])).rejects.toThrow(EdictumServerError);
  });
});
