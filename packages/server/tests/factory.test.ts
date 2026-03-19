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
import type { ServerGuard, WatchErrorHandler } from "../src/factory.js";

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

const TEST_YAML_OBSERVE = `
apiVersion: edictum/v1
kind: ContractBundle
metadata:
  name: observe-bundle
defaults:
  mode: observe
contracts:
  - id: log-all
    type: pre
    tool: "*"
    when:
      args.x:
        exists: true
    then:
      effect: deny
      message: "logged"
`;

const TEST_YAML_B64 = Buffer.from(TEST_YAML).toString("base64");
const TEST_YAML_OBSERVE_B64 = Buffer.from(TEST_YAML_OBSERVE).toString("base64");

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

  it("rejects NaN assignmentTimeout", async () => {
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: "b", assignmentTimeout: NaN }),
    ).rejects.toThrow(/assignmentTimeout/);
  });

  it("rejects negative assignmentTimeout", async () => {
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: "b", assignmentTimeout: -1 }),
    ).rejects.toThrow(/assignmentTimeout/);
  });

  it("rejects zero assignmentTimeout", async () => {
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: "b", assignmentTimeout: 0 }),
    ).rejects.toThrow(/assignmentTimeout/);
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

  it("uses bundle defaults.mode when mode is omitted", async () => {
    setupFullMock({ yaml_bytes: TEST_YAML_OBSERVE_B64 });
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", autoWatch: false });
    expect(sg.guard.mode).toBe("observe");
  });

  it("explicit mode overrides bundle defaults.mode", async () => {
    setupFullMock({ yaml_bytes: TEST_YAML_OBSERVE_B64 });
    sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", autoWatch: false, mode: "enforce" });
    expect(sg.guard.mode).toBe("enforce");
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
// Behavior tests for individual parameters
// ---------------------------------------------------------------------------

describe("parameter behavior", () => {
  it("tags are forwarded to the client", async () => {
    setupFullMock();
    const sg = await createServerGuard({
      ...BASE_OPTS, bundleName: "test-bundle", autoWatch: false,
      tags: { team: "security" },
    });
    expect(sg.client.tags).toEqual({ team: "security" });
    await sg.close();
  });

  it("timeout propagates to the client", async () => {
    setupFullMock();
    const sg = await createServerGuard({
      ...BASE_OPTS, bundleName: "test-bundle", autoWatch: false,
      timeout: 5_000,
    });
    expect(sg.client.timeout).toBe(5_000);
    await sg.close();
  });

  it("maxRetries propagates to the client", async () => {
    setupFullMock();
    const sg = await createServerGuard({
      ...BASE_OPTS, bundleName: "test-bundle", autoWatch: false,
      maxRetries: 5,
    });
    expect(sg.client.maxRetries).toBe(5);
    await sg.close();
  });

  it("onDeny callback fires on denied tool call", async () => {
    const onDeny = vi.fn();
    setupFullMock();
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", onDeny });

    await expect(
      sg.guard.run("Bash", { command: "rm -rf /" }, async () => "nope"),
    ).rejects.toThrow();

    expect(onDeny).toHaveBeenCalledTimes(1);
    await sg.close();
  });

  it("onAllow callback fires on allowed tool call", async () => {
    const onAllow = vi.fn();
    setupFullMock();
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", onAllow });

    await sg.guard.run("Bash", { command: "ls" }, async () => "ok");

    expect(onAllow).toHaveBeenCalledTimes(1);
    await sg.close();
  });

  it("custom audit sink receives events", async () => {
    const customSink = { emit: vi.fn(async () => {}) };
    setupFullMock();
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", auditSink: customSink });
    await sg.guard.run("SafeTool", { arg: "value" }, async () => "ok");
    expect(customSink.emit).toHaveBeenCalled();
    await sg.close();
  });

  it("mode override applies", async () => {
    setupFullMock();
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", mode: "observe" });
    expect(sg.guard.mode).toBe("observe");
    await sg.close();
  });

  it("allowInsecure permits HTTP to non-loopback", async () => {
    setupFullMock();
    // Should not throw despite non-loopback HTTP
    const sg = await createServerGuard({
      ...BASE_OPTS, url: "http://remote.example.com",
      bundleName: "test-bundle", autoWatch: false, allowInsecure: true,
    });
    expect(sg.guard).toBeInstanceOf(Edictum);
    await sg.close();
  });

  it("principal is forwarded to the guard", async () => {
    setupFullMock();
    const sg = await createServerGuard({
      ...BASE_OPTS, bundleName: "test-bundle", autoWatch: false,
      principal: { userId: "u1", role: "admin" },
    });
    // The guard should have the principal set — run a tool and check audit
    await sg.guard.run("SafeTool", {}, async () => "ok");
    const events = sg.guard.localSink.events;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].principal).toMatchObject({ userId: "u1", role: "admin" });
    await sg.close();
  });

  it("onWatchError callback receives signature rejection", async () => {
    const onWatchError = vi.fn<WatchErrorHandler>();
    const badBundle = JSON.stringify({ yaml_bytes: TEST_YAML_B64, signature: "badsig" });

    const keypair = generateKeyPairSync("ed25519");
    const pubDer = keypair.publicKey.export({ type: "spki", format: "der" });
    const pubHex = Buffer.from(pubDer.subarray(-32)).toString("hex");
    const validSig = sign(null, Buffer.from(TEST_YAML), keypair.privateKey).toString("base64");

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      // Initial fetch needs valid signature
      if (url.includes("/api/v1/bundles/")) return mockJson({ yaml_bytes: TEST_YAML_B64, signature: validSig });
      // SSE delivers bundle with bad signature
      if (url.includes("/api/v1/stream")) {
        return mockSse([{ event: "contract_update", data: badBundle }]);
      }
      return mockJson({ error: "not found" }, 404);
    });

    const sg = await createServerGuard({
      ...BASE_OPTS, bundleName: "test-bundle",
      verifySignatures: true,
      signingPublicKey: pubHex,
      onWatchError,
    });

    // Wait for SSE watcher to process the event (no fixed sleep)
    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(
        expect.objectContaining({ type: "signature_rejected" }),
      );
    }, { timeout: 2000 });
    await sg.close();
  });
});

// ---------------------------------------------------------------------------
// Security — adversarial bypass tests
// ---------------------------------------------------------------------------

describe("security", () => {
  it("rejects oversized yaml_bytes (memory exhaustion attack)", async () => {
    // Create base64 string exceeding the limit (~682K chars)
    const oversizedB64 = "A".repeat(700_000);
    mockFetch.mockImplementation(async () => mockJson({ yaml_bytes: oversizedB64 }));
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: "b", autoWatch: false }),
    ).rejects.toThrow(/exceeds maximum size/);
  });

  it("rejects tampered YAML with signature for different content", async () => {
    const keypair = generateKeyPairSync("ed25519");
    const pubDer = keypair.publicKey.export({ type: "spki", format: "der" });
    const pubHex = Buffer.from(pubDer.subarray(-32)).toString("hex");

    // Sign the legitimate YAML
    const legitimateSig = sign(null, Buffer.from(TEST_YAML), keypair.privateKey);

    // Serve tampered YAML with the legitimate signature
    const tamperedYaml = TEST_YAML.replace("rm -rf", "ls");
    const tamperedB64 = Buffer.from(tamperedYaml).toString("base64");
    mockFetch.mockImplementation(async () =>
      mockJson({ yaml_bytes: tamperedB64, signature: legitimateSig.toString("base64") }),
    );

    await expect(
      createServerGuard({
        ...BASE_OPTS, bundleName: "b", autoWatch: false,
        verifySignatures: true, signingPublicKey: pubHex,
      }),
    ).rejects.toThrow();
  });

  it("SSE watcher keeps existing contracts when unsigned bundle arrives", async () => {
    const onWatchError = vi.fn<WatchErrorHandler>();
    // Serve an unsigned update via SSE
    const unsignedBundle = JSON.stringify({ yaml_bytes: TEST_YAML_B64 });

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/")) {
        // Initial fetch with valid signature
        const kp = generateKeyPairSync("ed25519");
        const s = sign(null, Buffer.from(TEST_YAML), kp.privateKey);
        const pubDer = kp.publicKey.export({ type: "spki", format: "der" });
        // We need the matching pubkey to be used consistently — simplify:
        // use autoWatch=false for initial fetch, then manually test the watcher behavior
        return mockJson({ yaml_bytes: TEST_YAML_B64 });
      }
      if (url.includes("/api/v1/stream")) {
        return mockSse([{ event: "contract_update", data: unsignedBundle }]);
      }
      return mockJson({ error: "not found" }, 404);
    });

    const keypair = generateKeyPairSync("ed25519");
    const pubDer = keypair.publicKey.export({ type: "spki", format: "der" });
    const pubHex = Buffer.from(pubDer.subarray(-32)).toString("hex");
    const validSig = sign(null, Buffer.from(TEST_YAML), keypair.privateKey);

    // Override for initial fetch to include valid signature
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/")) {
        return mockJson({ yaml_bytes: TEST_YAML_B64, signature: validSig.toString("base64") });
      }
      if (url.includes("/api/v1/stream")) {
        return mockSse([{ event: "contract_update", data: unsignedBundle }]);
      }
      return mockJson({ error: "not found" }, 404);
    });

    const sg = await createServerGuard({
      ...BASE_OPTS, bundleName: "test-bundle",
      verifySignatures: true, signingPublicKey: pubHex,
      onWatchError,
    });

    const initialVersion = sg.guard.policyVersion;

    // Wait for SSE watcher to process (no fixed sleep)
    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(
        expect.objectContaining({ type: "signature_rejected" }),
      );
    }, { timeout: 2000 });

    // Contracts should NOT have changed (unsigned bundle rejected)
    expect(sg.guard.policyVersion).toBe(initialVersion);
    await sg.close();
  });

  it("assignment_changed SSE event triggers new bundle fetch and reload", async () => {
    const assignmentEvent = JSON.stringify({ bundle_name: "new-bundle" });
    const newYaml = TEST_YAML.replace("no-rm", "no-rm-v2");
    const newYamlB64 = Buffer.from(newYaml).toString("base64");

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      // Initial bundle fetch
      if (url.includes("/api/v1/bundles/test-bundle/current")) {
        return mockJson({ yaml_bytes: TEST_YAML_B64 });
      }
      // New bundle fetch after assignment change
      if (url.includes("/api/v1/bundles/new-bundle/current")) {
        return mockJson({ yaml_bytes: newYamlB64 });
      }
      if (url.includes("/api/v1/stream")) {
        return mockSse([{ event: "assignment_changed", data: assignmentEvent }]);
      }
      return mockJson({ error: "not found" }, 404);
    });

    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle" });
    const initialVersion = sg.guard.policyVersion;

    // Wait for SSE watcher to process the assignment change
    await vi.waitFor(() => {
      expect(sg.guard.policyVersion).not.toBe(initialVersion);
    }, { timeout: 2000 });

    // Client should have updated bundle name
    expect(sg.client.bundleName).toBe("new-bundle");
    await sg.close();
  });
});

// ---------------------------------------------------------------------------
// Additional behavior tests
// ---------------------------------------------------------------------------

describe("parameter behavior (additional)", () => {
  it("successCheck override affects tool result evaluation", async () => {
    // Custom success check that always returns false — causes EdictumToolError
    const successCheck = vi.fn(() => false);
    setupFullMock();
    const sg = await createServerGuard({
      ...BASE_OPTS, bundleName: "test-bundle", autoWatch: false, successCheck,
    });

    // Run a tool — successCheck returns false → throw
    await expect(
      sg.guard.run("SafeTool", { x: 1 }, async () => "result"),
    ).rejects.toThrow();
    expect(successCheck).toHaveBeenCalledTimes(1);
    expect(successCheck).toHaveBeenCalledWith("SafeTool", "result");
    await sg.close();
  });

  it("principalResolver override is used during tool calls", async () => {
    const principalResolver = vi.fn((_tool: string, _args: Record<string, unknown>) => ({
      userId: "resolved-user",
      role: "operator",
    }));
    setupFullMock();
    const sg = await createServerGuard({
      ...BASE_OPTS, bundleName: "test-bundle", autoWatch: false, principalResolver,
    });

    await sg.guard.run("SafeTool", { x: 1 }, async () => "ok");

    expect(principalResolver).toHaveBeenCalledTimes(1);
    const events = sg.guard.localSink.events;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].principal).toMatchObject({ userId: "resolved-user", role: "operator" });
    await sg.close();
  });
});
