/**
 * Security, SSE watcher error, and server-assignment tests for createServerGuard().
 *
 * SIZE APPROVAL: This file exceeds 200 lines. Security adversarial tests,
 * SSE watcher error tests, and server-assignment path tests form a single
 * cohesive security test suite that cannot be meaningfully split further.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { Edictum, EdictumConfigError } from "@edictum/core";
import { createServerGuard } from "../src/factory.js";
import type { WatchErrorHandler } from "../src/factory.js";
import {
  TEST_YAML, TEST_YAML_B64,
  BASE_OPTS, mockJson, mockSse, extractUrl, setupFullMock,
  createMockFetch,
} from "./factory-helpers.js";
import type { FetchFn } from "./factory-helpers.js";

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn<FetchFn>>;
const mock = createMockFetch();

beforeEach(() => {
  mock.install();
  mockFetch = mock.mockFetch;
  mockFetch.mockReset();
});

afterEach(() => {
  mock.restore();
});

function setup(bundleResponse?: Record<string, unknown>): void {
  setupFullMock(mockFetch, bundleResponse);
}

// ---------------------------------------------------------------------------
// Security — adversarial bypass tests
// ---------------------------------------------------------------------------

describe("security", () => {
  it("rejects oversized yaml_bytes (memory exhaustion attack)", async () => {
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
    const legitimateSig = sign(null, Buffer.from(TEST_YAML), keypair.privateKey);
    const tamperedB64 = Buffer.from(TEST_YAML.replace("rm -rf", "ls")).toString("base64");

    mockFetch.mockImplementation(async () =>
      mockJson({ yaml_bytes: tamperedB64, signature: legitimateSig.toString("base64") }),
    );
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: "b", autoWatch: false, verifySignatures: true, signingPublicKey: pubHex }),
    ).rejects.toThrow();
  });

  it("SSE watcher keeps existing contracts when unsigned bundle arrives", async () => {
    const onWatchError = vi.fn<WatchErrorHandler>();
    const unsignedBundle = JSON.stringify({ yaml_bytes: TEST_YAML_B64 });

    const keypair = generateKeyPairSync("ed25519");
    const pubDer = keypair.publicKey.export({ type: "spki", format: "der" });
    const pubHex = Buffer.from(pubDer.subarray(-32)).toString("hex");
    const validSig = sign(null, Buffer.from(TEST_YAML), keypair.privateKey);

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/")) return mockJson({ yaml_bytes: TEST_YAML_B64, signature: validSig.toString("base64") });
      if (url.includes("/api/v1/stream")) return mockSse([{ event: "contract_update", data: unsignedBundle }]);
      return mockJson({ error: "not found" }, 404);
    });

    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", verifySignatures: true, signingPublicKey: pubHex, onWatchError });
    const initialVersion = sg.guard.policyVersion;

    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(expect.objectContaining({ type: "signature_rejected" }));
    }, { timeout: 2000 });
    expect(sg.guard.policyVersion).toBe(initialVersion);
    await sg.close();
  });

  it("rejects assignment_changed with path-separator bundle_name at SSE level", async () => {
    const maliciousEvent = JSON.stringify({ bundle_name: "../../evil" });
    let fetchedMaliciousBundle = false;

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/test-bundle")) return mockJson({ yaml_bytes: TEST_YAML_B64 });
      if (url.includes("/api/v1/stream")) return mockSse([{ event: "assignment_changed", data: maliciousEvent }]);
      if (url.includes("evil")) fetchedMaliciousBundle = true;
      return mockJson({ error: "not found" }, 404);
    });

    let sseCallCount = 0;
    const origImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/stream")) sseCallCount++;
      return origImpl(input, init);
    });

    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle" });
    await vi.waitFor(() => { expect(sseCallCount).toBeGreaterThanOrEqual(1); }, { timeout: 2000 });
    expect(fetchedMaliciousBundle).toBe(false);
    expect(sg.client.bundleName).toBe("test-bundle");
    await sg.close();
  });

  it("assignment_changed SSE event triggers new bundle fetch and reload", async () => {
    const assignmentEvent = JSON.stringify({ bundle_name: "new-bundle" });
    const newYamlB64 = Buffer.from(TEST_YAML.replace("no-rm", "no-rm-v2")).toString("base64");

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/test-bundle/current")) return mockJson({ yaml_bytes: TEST_YAML_B64 });
      if (url.includes("/api/v1/bundles/new-bundle/current")) return mockJson({ yaml_bytes: newYamlB64 });
      if (url.includes("/api/v1/stream")) return mockSse([{ event: "assignment_changed", data: assignmentEvent }]);
      return mockJson({ error: "not found" }, 404);
    });

    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle" });
    const initialVersion = sg.guard.policyVersion;
    await vi.waitFor(() => { expect(sg.guard.policyVersion).not.toBe(initialVersion); }, { timeout: 2000 });
    expect(sg.client.bundleName).toBe("new-bundle");
    await sg.close();
  });
});

// ---------------------------------------------------------------------------
// Server-assignment path (bundleName=null)
// ---------------------------------------------------------------------------

describe("server-assignment path (bundleName=null)", () => {
  it("throws EdictumConfigError when assignment times out", async () => {
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/stream")) return mockSse([]);
      return mockJson({ error: "not found" }, 404);
    });
    await expect(
      createServerGuard({ ...BASE_OPTS, bundleName: null, autoWatch: true, assignmentTimeout: 200 }),
    ).rejects.toThrow(EdictumConfigError);
  });

  it("succeeds when SSE delivers assignment before timeout", async () => {
    const assignmentEvent = JSON.stringify({ bundle_name: "assigned-bundle" });
    const assignedYamlB64 = Buffer.from(TEST_YAML.replace("no-rm", "assigned-contract")).toString("base64");

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/assigned-bundle/current")) return mockJson({ yaml_bytes: assignedYamlB64 });
      if (url.includes("/api/v1/stream")) return mockSse([{ event: "assignment_changed", data: assignmentEvent }]);
      return mockJson({ error: "not found" }, 404);
    });

    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: null, autoWatch: true, assignmentTimeout: 5000 });
    expect(sg.guard).toBeInstanceOf(Edictum);
    expect(sg.guard.policyVersion).toBeTruthy();
    expect(sg.client.bundleName).toBe("assigned-bundle");
    await sg.close();
  });
});

// ---------------------------------------------------------------------------
// SSE watcher error handling
// ---------------------------------------------------------------------------

describe("SSE watcher errors", () => {
  it("onWatchError receives parse_error for missing yaml_bytes in SSE", async () => {
    const onWatchError = vi.fn<WatchErrorHandler>();
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/")) return mockJson({ yaml_bytes: TEST_YAML_B64 });
      if (url.includes("/api/v1/stream")) return mockSse([{ event: "contract_update", data: JSON.stringify({ revision_hash: "abc" }) }]);
      return mockJson({ error: "not found" }, 404);
    });
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", onWatchError });
    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(expect.objectContaining({ type: "parse_error", message: expect.stringContaining("yaml_bytes") }));
    }, { timeout: 2000 });
    await sg.close();
  });

  it("onWatchError receives fetch_error when assignment bundle fetch fails", async () => {
    const onWatchError = vi.fn<WatchErrorHandler>();
    const assignmentEvent = JSON.stringify({ bundle_name: "missing-bundle" });
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/test-bundle")) return mockJson({ yaml_bytes: TEST_YAML_B64 });
      if (url.includes("/api/v1/bundles/missing-bundle")) return mockJson({ error: "not found" }, 404);
      if (url.includes("/api/v1/stream")) return mockSse([{ event: "assignment_changed", data: assignmentEvent }]);
      return mockJson({ error: "not found" }, 404);
    });
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", onWatchError });
    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(expect.objectContaining({ type: "fetch_error", bundleName: "missing-bundle" }));
    }, { timeout: 2000 });
    await sg.close();
  });

  it("onWatchError receives parse_error when assignment bundle has invalid YAML", async () => {
    const onWatchError = vi.fn<WatchErrorHandler>();
    const badYamlB64 = Buffer.from("not: valid: yaml: bundle").toString("base64");
    const assignmentEvent = JSON.stringify({ bundle_name: "bad-bundle" });
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/test-bundle/current")) return mockJson({ yaml_bytes: TEST_YAML_B64 });
      if (url.includes("/api/v1/bundles/bad-bundle/current")) return mockJson({ yaml_bytes: badYamlB64 });
      if (url.includes("/api/v1/stream")) return mockSse([{ event: "assignment_changed", data: assignmentEvent }]);
      return mockJson({ error: "not found" }, 404);
    });
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", onWatchError });
    const initialVersion = sg.guard.policyVersion;
    await vi.waitFor(() => {
      expect(onWatchError).toHaveBeenCalledWith(expect.objectContaining({ type: "parse_error" }));
    }, { timeout: 2000 });
    expect(sg.guard.policyVersion).toBe(initialVersion);
    expect(sg.client.bundleName).toBe("test-bundle");
    await sg.close();
  });

  it("watcher survives onWatchError callback that throws", async () => {
    const throwingHandler = vi.fn(() => { throw new Error("callback error"); });
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = extractUrl(input);
      if (url.includes("/api/v1/bundles/")) return mockJson({ yaml_bytes: TEST_YAML_B64 });
      if (url.includes("/api/v1/stream")) return mockSse([{ event: "contract_update", data: JSON.stringify({ revision_hash: "abc" }) }]);
      return mockJson({ error: "not found" }, 404);
    });
    const sg = await createServerGuard({ ...BASE_OPTS, bundleName: "test-bundle", onWatchError: throwingHandler });
    await vi.waitFor(() => { expect(throwingHandler).toHaveBeenCalledTimes(1); }, { timeout: 2000 });
    expect(sg.guard).toBeInstanceOf(Edictum);
    await sg.close();
  });
});
