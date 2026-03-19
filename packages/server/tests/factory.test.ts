/**
 * Tests for createServerGuard() — the server guard factory.
 *
 * Uses vitest mock server (vi.fn + fetch interception) to simulate
 * the edictum-console API without a real server.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { Edictum, EdictumConfigError } from "@edictum/core";
import { createServerGuard } from "../src/factory.js";
import type { ServerGuard } from "../src/factory.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_YAML = `
apiVersion: edictum/v1
kind: ContractBundle
metadata:
  name: test-bundle
defaults:
  mode: enforce
contracts:
  - id: no-rm
    type: pre
    tool: Bash
    when:
      args.command:
        contains: "rm -rf"
    then:
      effect: deny
      message: "Cannot run rm -rf"
`;

const TEST_YAML_B64 = Buffer.from(TEST_YAML).toString("base64");

const BASE_OPTS = {
  url: "http://localhost:8000",
  apiKey: "test-key",
  agentId: "test-agent",
} as const;

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;
let originalFetch: FetchFn;
let mockFetch: ReturnType<typeof vi.fn<FetchFn>>;

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockSse(events: Array<{ event: string; data: string }>): Response {
  const lines = events.map((e) => `event:${e.event}\ndata:${e.data}\n\n`).join("");
  return new Response(lines, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** URL extractor for mock fetch input. */
function extractUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Standard mock that serves bundle + empty SSE + session endpoints. */
function setupFullMock(bundleResponse?: Record<string, unknown>): void {
  const bundle = bundleResponse ?? { yaml_bytes: TEST_YAML_B64 };
  mockFetch.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = extractUrl(input);
    if (url.includes("/api/v1/bundles/")) return mockJson(bundle);
    if (url.includes("/api/v1/stream")) return mockSse([]);
    if (url.includes("/api/v1/sessions/") && init?.method === "POST") return mockJson({ value: 1 });
    if (url.includes("/api/v1/sessions/")) return mockJson({ value: null });
    if (url.includes("/api/v1/events")) return mockJson({ ok: true });
    return mockJson({ error: "not found" }, 404);
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockFetch = vi.fn<FetchFn>();
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("rejects bundleName=null with autoWatch=false", async () => {
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: null, autoWatch: false }),
    ).rejects.toThrow(EdictumConfigError);
  });

  it("rejects verifySignatures without signingPublicKey", async () => {
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: "b", verifySignatures: true }),
    ).rejects.toThrow(EdictumConfigError);
  });

  it("rejects invalid URL (HTTP to non-loopback)", async () => {
    await expect(
      createServerGuard({ ...BASE_OPTS, url: "http://remote.example.com", bundleName: "b", autoWatch: false }),
    ).rejects.toThrow(/plaintext HTTP/);
  });
});

// ---------------------------------------------------------------------------
// Basic connection + initial contract fetch
// ---------------------------------------------------------------------------

describe("basic connection", () => {
  let sg: ServerGuard;
  afterEach(async () => { if (sg) await sg.close(); });

  it("fetches initial bundle and returns working guard", async () => {
    setupFullMock();
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle" });
    expect(sg.guard).toBeInstanceOf(Edictum);
    expect(sg.guard.policyVersion).toBeTruthy();

    const bundleCall = mockFetch.mock.calls.find(
      (c) => extractUrl(c[0]).includes("/api/v1/bundles/test-bundle/current"),
    );
    expect(bundleCall).toBeTruthy();
  });

  it("passes environment as query parameter", async () => {
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/")) {
        expect(url).toContain("env=staging");
        return mockJson({ yaml_bytes: TEST_YAML_B64 });
      }
      if (url.includes("/api/v1/stream")) return mockSse([]);
      return mockJson({ error: "not found" }, 404);
    });
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", environment: "staging" });
    expect(sg.guard).toBeInstanceOf(Edictum);
  });

  it("wires up ServerAuditSink by default", async () => {
    setupFullMock();
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle" });
    expect(sg.guard.auditSink).toBeTruthy();
  });

  it("creates guard without autoWatch", async () => {
    setupFullMock();
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", autoWatch: false });
    expect(sg.guard).toBeInstanceOf(Edictum);
    const sseCalls = mockFetch.mock.calls.filter((c) => extractUrl(c[0]).includes("/api/v1/stream"));
    expect(sseCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("throws on auth failure (401)", async () => {
    mockFetch.mockImplementation(async () => mockJson({ detail: "Unauthorized" }, 401));
    await expect(
      createServerGuard({ ...BASE_OPTS, apiKey: "bad-key", bundleName: "b", autoWatch: false }),
    ).rejects.toThrow(/401/);
  });

  it("throws on missing yaml_bytes in response", async () => {
    mockFetch.mockImplementation(async () => mockJson({ some_other_field: "value" }));
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: "b", autoWatch: false }),
    ).rejects.toThrow(/yaml_bytes/);
  });

  it("throws on invalid YAML content", async () => {
    const badYaml = Buffer.from("not: valid: yaml: bundle").toString("base64");
    mockFetch.mockImplementation(async () => mockJson({ yaml_bytes: badYaml }));
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: "b", autoWatch: false }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("signature verification", () => {
  const keypair = generateKeyPairSync("ed25519");
  const publicKeyDer = keypair.publicKey.export({ type: "spki", format: "der" });
  const publicKeyHex = Buffer.from(publicKeyDer.subarray(-32)).toString("hex");
  const sig = sign(null, Buffer.from(TEST_YAML), keypair.privateKey);
  const signatureB64 = sig.toString("base64");
  const sigOpts = { verifySignatures: true, signingPublicKey: publicKeyHex, autoWatch: false } as const;

  it("accepts valid signature", async () => {
    mockFetch.mockImplementation(async () => mockJson({ yaml_bytes: TEST_YAML_B64, signature: signatureB64 }));
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "b", ...sigOpts });
    expect(sg.guard).toBeInstanceOf(Edictum);
    await sg.close();
  });

  it("rejects invalid signature", async () => {
    mockFetch.mockImplementation(async () =>
      mockJson({ yaml_bytes: TEST_YAML_B64, signature: Buffer.from("bad").toString("base64") }),
    );
    await expect(createServerGuard({ ...BASE_OPTS, bundleName: "b", ...sigOpts })).rejects.toThrow();
  });

  it("rejects missing signature when verification enabled", async () => {
    mockFetch.mockImplementation(async () => mockJson({ yaml_bytes: TEST_YAML_B64 }));
    await expect(createServerGuard({ ...BASE_OPTS, bundleName: "b", ...sigOpts })).rejects.toThrow(/signature missing/i);
  });
});

// ---------------------------------------------------------------------------
// Guard functionality (end-to-end)
// ---------------------------------------------------------------------------

describe("guard works end-to-end", () => {
  let sg: ServerGuard;
  afterEach(async () => { if (sg) await sg.close(); });

  it("enforces contracts from server-fetched bundle", async () => {
    setupFullMock();
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle" });

    const safeResult = await sg.guard.run("Bash", { command: "ls -la" }, async () => "output");
    expect(safeResult).toBe("output");

    await expect(
      sg.guard.run("Bash", { command: "rm -rf /" }, async () => "should not run"),
    ).rejects.toThrow(/rm -rf/);
  });
});

// ---------------------------------------------------------------------------
// Close / cleanup
// ---------------------------------------------------------------------------

describe("close()", () => {
  it("can be called multiple times safely", async () => {
    setupFullMock();
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle" });
    await sg.close();
    await sg.close();
  });
});

// ---------------------------------------------------------------------------
// Custom overrides
// ---------------------------------------------------------------------------

describe("custom overrides", () => {
  it("uses provided audit sink instead of ServerAuditSink", async () => {
    const customSink = { emit: vi.fn(async () => {}) };
    setupFullMock();
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", auditSink: customSink });
    await sg.guard.run("SafeTool", { arg: "value" }, async () => "ok");
    expect(customSink.emit).toHaveBeenCalled();
    await sg.close();
  });

  it("uses provided mode", async () => {
    setupFullMock();
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", mode: "observe" });
    expect(sg.guard.mode).toBe("observe");
    await sg.close();
  });
});
