import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  EdictumServerClient,
  EdictumServerError,
  SAFE_IDENTIFIER_RE,
} from "../src/client.js";

// ---------------------------------------------------------------------------
// SAFE_IDENTIFIER_RE
// ---------------------------------------------------------------------------

describe("SAFE_IDENTIFIER_RE", () => {
  it("accepts valid identifiers", () => {
    expect(SAFE_IDENTIFIER_RE.test("default")).toBe(true);
    expect(SAFE_IDENTIFIER_RE.test("my-agent")).toBe(true);
    expect(SAFE_IDENTIFIER_RE.test("agent_1")).toBe(true);
    expect(SAFE_IDENTIFIER_RE.test("v1.0.0")).toBe(true);
    expect(SAFE_IDENTIFIER_RE.test("a")).toBe(true);
  });

  it("rejects invalid identifiers", () => {
    expect(SAFE_IDENTIFIER_RE.test("")).toBe(false);
    expect(SAFE_IDENTIFIER_RE.test("-leading")).toBe(false);
    expect(SAFE_IDENTIFIER_RE.test("has space")).toBe(false);
    expect(SAFE_IDENTIFIER_RE.test("path/sep")).toBe(false);
    expect(SAFE_IDENTIFIER_RE.test("a".repeat(129))).toBe(false);
    expect(SAFE_IDENTIFIER_RE.test("\x00null")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TLS enforcement
// ---------------------------------------------------------------------------

describe("TLS enforcement", () => {
  it("allows HTTPS to any host", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://remote.example.com", apiKey: "k" }),
    ).not.toThrow();
  });

  it("allows HTTP to localhost", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "http://localhost:8000", apiKey: "k" }),
    ).not.toThrow();
  });

  it("allows HTTP to 127.0.0.1", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "http://127.0.0.1:8000", apiKey: "k" }),
    ).not.toThrow();
  });

  it("allows HTTP to ::1", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "http://[::1]:8000", apiKey: "k" }),
    ).not.toThrow();
  });

  it("rejects HTTP to non-loopback host", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "http://remote.example.com", apiKey: "k" }),
    ).toThrow("Refusing plaintext HTTP");
  });

  it("allows HTTP to non-loopback with allowInsecure", () => {
    expect(
      () =>
        new EdictumServerClient({
          baseUrl: "http://remote.example.com",
          apiKey: "k",
          allowInsecure: true,
        }),
    ).not.toThrow();
  });

  it("emits console.warn when allowInsecure is used for non-loopback HTTP", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      new EdictumServerClient({
        baseUrl: "http://remote.example.com",
        apiKey: "k",
        allowInsecure: true,
      });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toContain("allowInsecure");
      expect(warnSpy.mock.calls[0]![0]).toContain("plaintext HTTP");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for loopback HTTP without allowInsecure", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      new EdictumServerClient({
        baseUrl: "http://localhost:8000",
        apiKey: "k",
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

describe("identifier validation", () => {
  it("rejects invalid agentId", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", agentId: "bad agent" }),
    ).toThrow("Invalid agentId");
  });

  it("rejects invalid env", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", env: "../escape" }),
    ).toThrow("Invalid env");
  });

  it("rejects invalid bundleName", () => {
    expect(
      () =>
        new EdictumServerClient({
          baseUrl: "https://x.com",
          apiKey: "k",
          bundleName: "bad bundle!",
        }),
    ).toThrow("Invalid bundleName");
  });

  it("allows null bundleName", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", bundleName: null }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tag validation
// ---------------------------------------------------------------------------

describe("tag validation", () => {
  it("rejects too many tags", () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 65; i++) tags[`k${i}`] = "v";
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", tags }),
    ).toThrow("Too many tags");
  });

  it("rejects tag key too long", () => {
    expect(
      () =>
        new EdictumServerClient({
          baseUrl: "https://x.com",
          apiKey: "k",
          tags: { ["k".repeat(129)]: "v" },
        }),
    ).toThrow("Tag key too long");
  });

  it("rejects tag value too long", () => {
    expect(
      () =>
        new EdictumServerClient({
          baseUrl: "https://x.com",
          apiKey: "k",
          tags: { k: "v".repeat(257) },
        }),
    ).toThrow("Tag value too long");
  });

  it("rejects tag key with control characters", () => {
    expect(
      () =>
        new EdictumServerClient({
          baseUrl: "https://x.com",
          apiKey: "k",
          tags: { "key\x00null": "v" },
        }),
    ).toThrow("Tag key contains control characters");
  });

  it("rejects tag key with newline", () => {
    expect(
      () =>
        new EdictumServerClient({
          baseUrl: "https://x.com",
          apiKey: "k",
          tags: { "key\ninjection": "v" },
        }),
    ).toThrow("Tag key contains control characters");
  });

  it("rejects tag value with control characters", () => {
    expect(
      () =>
        new EdictumServerClient({
          baseUrl: "https://x.com",
          apiKey: "k",
          tags: { env: "prod\x00injected" },
        }),
    ).toThrow("Tag value contains control characters");
  });

  it("rejects tag value with carriage return", () => {
    expect(
      () =>
        new EdictumServerClient({
          baseUrl: "https://x.com",
          apiKey: "k",
          tags: { env: "val\rinjection" },
        }),
    ).toThrow("Tag value contains control characters");
  });

  it("rejects tag key with DEL character", () => {
    expect(
      () =>
        new EdictumServerClient({
          baseUrl: "https://x.com",
          apiKey: "k",
          tags: { "key\x7f": "v" },
        }),
    ).toThrow("Tag key contains control characters");
  });

  it("accepts valid tags", () => {
    expect(
      () =>
        new EdictumServerClient({
          baseUrl: "https://x.com",
          apiKey: "k",
          tags: { env: "prod", team: "platform" },
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Empty apiKey validation
// ---------------------------------------------------------------------------

describe("apiKey validation", () => {
  it("rejects empty apiKey", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "" }),
    ).toThrow("apiKey must be a non-empty string");
  });
});

// ---------------------------------------------------------------------------
// Tags immutability
// ---------------------------------------------------------------------------

describe("tags immutability", () => {
  it("stores a frozen copy of tags — caller mutations do not propagate", () => {
    const tags: Record<string, string> = { env: "prod" };
    const client = new EdictumServerClient({
      baseUrl: "https://x.com",
      apiKey: "k",
      tags,
    });

    // Mutate the original — should not affect the client
    tags["env"] = "staging";
    tags["extra"] = "injected";

    expect(client.tags).toEqual({ env: "prod" });
    expect(Object.isFrozen(client.tags)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe("headers", () => {
  it("includes Authorization and agent ID in requests", async () => {
    const client = new EdictumServerClient({
      baseUrl: "https://api.example.com",
      apiKey: "test-key-123",
      agentId: "my-agent",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await client.get("/test");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key-123");
    expect(headers["X-Edictum-Agent-Id"]).toBe("my-agent");
    expect(headers["Content-Type"]).toBe("application/json");

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

describe("retry logic", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.useRealTimers();
  });

  it("retries on 5xx then succeeds", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = new EdictumServerClient({
      baseUrl: "https://api.example.com",
      apiKey: "k",
      maxRetries: 3,
    });

    const promise = client.get("/test");
    // Advance past the retry delay (500ms for attempt 0)
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on 5xx", async () => {
    vi.useRealTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("Error", { status: 503 }));

    const client = new EdictumServerClient({
      baseUrl: "https://api.example.com",
      apiKey: "k",
      maxRetries: 1,
    });

    await expect(client.get("/test")).rejects.toThrow(EdictumServerError);
  });

  it("handles 204 No Content without calling json()", async () => {
    vi.useRealTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const client = new EdictumServerClient({
      baseUrl: "https://api.example.com",
      apiKey: "k",
    });

    const result = await client.delete("/items/1");
    expect(result).toEqual({});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 4xx errors", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    const client = new EdictumServerClient({
      baseUrl: "https://api.example.com",
      apiKey: "k",
      maxRetries: 3,
    });

    await expect(client.get("/test")).rejects.toThrow(EdictumServerError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on connection errors", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = new EdictumServerClient({
      baseUrl: "https://api.example.com",
      apiKey: "k",
      maxRetries: 3,
    });

    const promise = client.get("/test");
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// HTTP methods
// ---------------------------------------------------------------------------

describe("HTTP methods", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("sends GET with query params", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ v: 1 }), { status: 200 }));

    const client = new EdictumServerClient({ baseUrl: "https://api.example.com", apiKey: "k" });
    await client.get("/path", { foo: "bar" });

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("/path?foo=bar");
  });

  it("sends POST with JSON body", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "1" }), { status: 200 }));

    const client = new EdictumServerClient({ baseUrl: "https://api.example.com", apiKey: "k" });
    await client.post("/items", { name: "test" });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ name: "test" }));
  });

  it("sends PUT with JSON body", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    const client = new EdictumServerClient({ baseUrl: "https://api.example.com", apiKey: "k" });
    await client.put("/items/1", { value: "x" });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.method).toBe("PUT");
  });

  it("sends DELETE", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    const client = new EdictumServerClient({ baseUrl: "https://api.example.com", apiKey: "k" });
    await client.delete("/items/1");

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

describe("URL normalization", () => {
  it("strips trailing slashes from baseUrl", () => {
    const client = new EdictumServerClient({
      baseUrl: "https://api.example.com///",
      apiKey: "k",
    });
    expect(client.baseUrl).toBe("https://api.example.com");
  });
});

// ---------------------------------------------------------------------------
// maxRetries validation
// ---------------------------------------------------------------------------

describe("maxRetries validation", () => {
  it("rejects NaN", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", maxRetries: NaN }),
    ).toThrow(/maxRetries/);
  });

  it("rejects Infinity", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", maxRetries: Infinity }),
    ).toThrow(/maxRetries/);
  });

  it("rejects non-integer", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", maxRetries: 1.5 }),
    ).toThrow(/maxRetries/);
  });

  it("rejects zero", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", maxRetries: 0 }),
    ).toThrow(/maxRetries/);
  });

  it("rejects negative integer", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", maxRetries: -1 }),
    ).toThrow(/maxRetries/);
  });

  it("accepts valid positive integer", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", maxRetries: 5 }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// timeout validation
// ---------------------------------------------------------------------------

describe("timeout validation", () => {
  it("rejects NaN", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", timeout: NaN }),
    ).toThrow(/timeout/);
  });

  it("rejects Infinity", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", timeout: Infinity }),
    ).toThrow(/timeout/);
  });

  it("rejects zero", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", timeout: 0 }),
    ).toThrow(/timeout/);
  });

  it("rejects negative", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "k", timeout: -1 }),
    ).toThrow(/timeout/);
  });
});

// ---------------------------------------------------------------------------
// apiKey validation
// ---------------------------------------------------------------------------

describe("apiKey validation", () => {
  it("rejects empty string", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "" }),
    ).toThrow(/apiKey/);
  });

  it("rejects null byte in apiKey", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "key\x00evil" }),
    ).toThrow(/control characters/);
  });

  it("rejects newline in apiKey", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "key\nevil" }),
    ).toThrow(/control characters/);
  });

  it("rejects carriage return in apiKey", () => {
    expect(
      () => new EdictumServerClient({ baseUrl: "https://x.com", apiKey: "key\revil" }),
    ).toThrow(/control characters/);
  });
});

// ---------------------------------------------------------------------------
// _setClientBundleName (package-internal)
// ---------------------------------------------------------------------------

import { _setClientBundleName } from "../src/client.js";

describe("_setClientBundleName", () => {
  it("updates bundleName for valid name", () => {
    const client = new EdictumServerClient({ baseUrl: "http://localhost", apiKey: "k" });
    expect(client.bundleName).toBeNull();
    _setClientBundleName(client, "new-bundle");
    expect(client.bundleName).toBe("new-bundle");
  });

  it("rejects empty name", () => {
    const client = new EdictumServerClient({ baseUrl: "http://localhost", apiKey: "k" });
    expect(() => _setClientBundleName(client, "")).toThrow("Invalid bundleName");
  });

  it("rejects name with spaces", () => {
    const client = new EdictumServerClient({ baseUrl: "http://localhost", apiKey: "k" });
    expect(() => _setClientBundleName(client, "invalid name")).toThrow("Invalid bundleName");
  });

  it("rejects name exceeding 128 chars", () => {
    const client = new EdictumServerClient({ baseUrl: "http://localhost", apiKey: "k" });
    expect(() => _setClientBundleName(client, "a".repeat(129))).toThrow("Invalid bundleName");
  });

  it("rejects name with path separators", () => {
    const client = new EdictumServerClient({ baseUrl: "http://localhost", apiKey: "k" });
    expect(() => _setClientBundleName(client, "../../evil")).toThrow("Invalid bundleName");
  });

  // Security: control character bypass tests
  it("rejects null byte in bundle name", () => {
    const client = new EdictumServerClient({ baseUrl: "http://localhost", apiKey: "k" });
    expect(() => _setClientBundleName(client, "bundle\x00evil")).toThrow("Invalid bundleName");
  });

  it("rejects newline in bundle name", () => {
    const client = new EdictumServerClient({ baseUrl: "http://localhost", apiKey: "k" });
    expect(() => _setClientBundleName(client, "bundle\nevil")).toThrow("Invalid bundleName");
  });

  it("rejects carriage return in bundle name", () => {
    const client = new EdictumServerClient({ baseUrl: "http://localhost", apiKey: "k" });
    expect(() => _setClientBundleName(client, "bundle\revil")).toThrow("Invalid bundleName");
  });

  it("rejects leading dot in bundle name", () => {
    const client = new EdictumServerClient({ baseUrl: "http://localhost", apiKey: "k" });
    expect(() => _setClientBundleName(client, ".hidden-bundle")).toThrow("Invalid bundleName");
  });
});
