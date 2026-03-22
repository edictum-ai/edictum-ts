import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ApprovalStatus, EdictumConfigError } from "@edictum/core";

import { EdictumServerClient } from "../src/client.js";
import { ServerApprovalBackend } from "../src/approval-backend.js";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function mockClient(): EdictumServerClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    agentId: "test-agent",
    env: "test",
    bundleName: null,
  } as unknown as EdictumServerClient;
}

// ---------------------------------------------------------------------------
// requestApproval
// ---------------------------------------------------------------------------

describe("ServerApprovalBackend.requestApproval", () => {
  it("creates approval request via POST", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "approval-123" });
    const backend = new ServerApprovalBackend(client);

    const request = await backend.requestApproval(
      "Bash",
      { command: "rm -rf /" },
      "Dangerous command detected",
    );

    expect(client.post).toHaveBeenCalledWith("/api/v1/approvals", {
      agent_id: "test-agent",
      tool_name: "Bash",
      tool_args: { command: "rm -rf /" },
      message: "Dangerous command detected",
      timeout: 300,
      timeout_effect: "deny",
    });

    expect(request.approvalId).toBe("approval-123");
    expect(request.toolName).toBe("Bash");
    expect(request.message).toBe("Dangerous command detected");
    expect(request.timeout).toBe(300);
    expect(request.timeoutEffect).toBe("deny");
  });

  it("returns frozen ApprovalRequest", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    const request = await backend.requestApproval("Tool", {}, "msg");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.toolArgs)).toBe(true);
    expect(Object.isFrozen(request.metadata)).toBe(true);
  });

  it("rejects invalid approvalId from server", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "../escape" });
    const backend = new ServerApprovalBackend(client);

    const err = await backend.requestApproval("Tool", {}, "msg").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdictumConfigError);
    expect((err as Error).message).toMatch(/Server returned invalid approvalId/);
  });

  it("rejects non-string approvalId from server", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 12345 });
    const backend = new ServerApprovalBackend(client);

    const err = await backend.requestApproval("Tool", {}, "msg").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdictumConfigError);
    expect((err as Error).message).toMatch(/Server returned invalid approvalId/);
  });

  it("passes custom options", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a2" });
    const backend = new ServerApprovalBackend(client);

    const request = await backend.requestApproval("Tool", {}, "msg", {
      timeout: 60,
      timeoutEffect: "allow",
      principal: { sub: "user-1" },
      metadata: { key: "value" },
    });

    expect(request.timeout).toBe(60);
    expect(request.timeoutEffect).toBe("allow");
    expect(request.principal).toEqual({ sub: "user-1" });
    expect(request.metadata).toEqual({ key: "value" });
  });
});

// ---------------------------------------------------------------------------
// waitForDecision
// ---------------------------------------------------------------------------

describe("ServerApprovalBackend.waitForDecision", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns approved decision", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    vi.mocked(client.get).mockResolvedValue({
      status: "approved",
      decided_by: "admin",
      decision_reason: "Looks safe",
    });

    const backend = new ServerApprovalBackend(client);
    await backend.requestApproval("Tool", {}, "msg");

    const decision = await backend.waitForDecision("a1");

    expect(decision.approved).toBe(true);
    expect(decision.approver).toBe("admin");
    expect(decision.reason).toBe("Looks safe");
    expect(decision.status).toBe(ApprovalStatus.APPROVED);
  });

  it("returns denied decision", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    vi.mocked(client.get).mockResolvedValue({
      status: "denied",
      decided_by: "reviewer",
      decision_reason: "Too risky",
    });

    const backend = new ServerApprovalBackend(client);
    await backend.requestApproval("Tool", {}, "msg");

    const decision = await backend.waitForDecision("a1");

    expect(decision.approved).toBe(false);
    expect(decision.status).toBe(ApprovalStatus.DENIED);
    expect(decision.reason).toBe("Too risky");
  });

  it("returns timeout decision from server", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    vi.mocked(client.get).mockResolvedValue({ status: "timeout" });

    const backend = new ServerApprovalBackend(client);
    await backend.requestApproval("Tool", {}, "msg");

    const decision = await backend.waitForDecision("a1");

    expect(decision.approved).toBe(false);
    expect(decision.status).toBe(ApprovalStatus.TIMEOUT);
  });

  it("respects timeout_effect=allow on server timeout", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    vi.mocked(client.get).mockResolvedValue({ status: "timeout" });

    const backend = new ServerApprovalBackend(client);
    await backend.requestApproval("Tool", {}, "msg", { timeoutEffect: "allow" });

    const decision = await backend.waitForDecision("a1");

    expect(decision.approved).toBe(true);
    expect(decision.status).toBe(ApprovalStatus.TIMEOUT);
  });

  it("returns timeout on local deadline exceeded", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });

    let pollCount = 0;
    vi.mocked(client.get).mockImplementation(async () => {
      pollCount++;
      // Always return pending
      return { status: "pending" };
    });

    const backend = new ServerApprovalBackend(client, { pollInterval: 1000 });
    await backend.requestApproval("Tool", {}, "msg", { timeout: 3 });

    const promise = backend.waitForDecision("a1");

    // Advance past the timeout (3 seconds + poll intervals)
    await vi.advanceTimersByTimeAsync(5000);

    const decision = await promise;

    expect(decision.status).toBe(ApprovalStatus.TIMEOUT);
    expect(decision.approved).toBe(false);
    expect(pollCount).toBeGreaterThanOrEqual(1);
  });

  it("returns frozen decisions", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    vi.mocked(client.get).mockResolvedValue({
      status: "approved",
      decided_by: "admin",
    });

    const backend = new ServerApprovalBackend(client);
    await backend.requestApproval("Tool", {}, "msg");
    const decision = await backend.waitForDecision("a1");

    expect(Object.isFrozen(decision)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pollInterval validation
// ---------------------------------------------------------------------------

describe("ServerApprovalBackend pollInterval validation", () => {
  it("rejects pollInterval of 0", () => {
    const client = mockClient();
    expect(() => new ServerApprovalBackend(client, { pollInterval: 0 })).toThrow(
      EdictumConfigError,
    );
  });

  it("rejects negative pollInterval", () => {
    const client = mockClient();
    expect(() => new ServerApprovalBackend(client, { pollInterval: -1000 })).toThrow(
      EdictumConfigError,
    );
  });

  it("rejects NaN pollInterval", () => {
    const client = mockClient();
    expect(() => new ServerApprovalBackend(client, { pollInterval: NaN })).toThrow(
      EdictumConfigError,
    );
  });

  it("rejects Infinity pollInterval", () => {
    const client = mockClient();
    expect(() => new ServerApprovalBackend(client, { pollInterval: Infinity })).toThrow(
      EdictumConfigError,
    );
  });

  it("accepts valid positive pollInterval", () => {
    const client = mockClient();
    expect(() => new ServerApprovalBackend(client, { pollInterval: 500 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// timeout validation
// ---------------------------------------------------------------------------

describe("ServerApprovalBackend timeout validation", () => {
  it("rejects timeout of 0", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("Tool", {}, "msg", { timeout: 0 }),
    ).rejects.toThrow(EdictumConfigError);
  });

  it("rejects negative timeout", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("Tool", {}, "msg", { timeout: -10 }),
    ).rejects.toThrow(EdictumConfigError);
  });

  it("rejects NaN timeout", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("Tool", {}, "msg", { timeout: NaN }),
    ).rejects.toThrow(EdictumConfigError);
  });

  it("rejects Infinity timeout", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("Tool", {}, "msg", { timeout: Infinity }),
    ).rejects.toThrow(EdictumConfigError);
  });

  it("accepts valid positive timeout", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    const request = await backend.requestApproval("Tool", {}, "msg", { timeout: 60 });
    expect(request.timeout).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// pending map cap
// ---------------------------------------------------------------------------

describe("ServerApprovalBackend pending map cap", () => {
  it("throws when MAX_PENDING is exceeded", async () => {
    const client = mockClient();
    let idCounter = 0;
    vi.mocked(client.post).mockImplementation(async () => ({
      id: `approval-${idCounter++}`,
    }));

    const backend = new ServerApprovalBackend(client);

    // Fill up to MAX_PENDING by accessing internal map
    // Use requestApproval to fill (this also stores into _pending)
    // We need to fill to the cap — use a smaller cap for test efficiency
    // Instead, directly test the boundary by filling the internal map
    const pendingMap = (backend as unknown as { _pending: Map<string, unknown> })._pending;
    for (let i = 0; i < ServerApprovalBackend.MAX_PENDING; i++) {
      pendingMap.set(`fake-${i}`, {} as never);
    }

    await expect(
      backend.requestApproval("Tool", {}, "msg"),
    ).rejects.toThrow(EdictumConfigError);
    await expect(
      backend.requestApproval("Tool", {}, "msg"),
    ).rejects.toThrow(/Maximum pending approvals/);
  });

  it("allows requests when under MAX_PENDING", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    // Under the cap — should succeed
    await expect(
      backend.requestApproval("Tool", {}, "msg"),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// toolName validation
// ---------------------------------------------------------------------------

describe("ServerApprovalBackend toolName validation", () => {
  it("rejects empty toolName", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("", {}, "msg"),
    ).rejects.toThrow(EdictumConfigError);
  });

  it("rejects toolName with spaces", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("bad tool", {}, "msg"),
    ).rejects.toThrow(/Invalid toolName/);
  });

  it("accepts valid toolName", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    const request = await backend.requestApproval("Bash", {}, "msg");
    expect(request.toolName).toBe("Bash");
  });

  it("accepts toolName of exactly 128 chars", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);
    const name128 = "a" + "b".repeat(127);
    await expect(backend.requestApproval(name128, {}, "msg")).resolves.toBeDefined();
  });

  it("rejects toolName of 129 chars", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);
    const name129 = "a" + "b".repeat(128);
    await expect(backend.requestApproval(name129, {}, "msg")).rejects.toThrow(/Invalid toolName/);
  });
});

// ---------------------------------------------------------------------------
// timeoutEffect validation
// ---------------------------------------------------------------------------

describe("ServerApprovalBackend timeoutEffect validation", () => {
  it("rejects invalid timeoutEffect", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("Bash", {}, "msg", { timeoutEffect: "invalid" }),
    ).rejects.toThrow(EdictumConfigError);
    await expect(
      backend.requestApproval("Bash", {}, "msg", { timeoutEffect: "invalid" }),
    ).rejects.toThrow(/timeoutEffect must be "deny" or "allow"/);
  });

  it("accepts timeoutEffect 'deny'", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    const request = await backend.requestApproval("Bash", {}, "msg", { timeoutEffect: "deny" });
    expect(request.timeoutEffect).toBe("deny");
  });

  it("accepts timeoutEffect 'allow'", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    const request = await backend.requestApproval("Bash", {}, "msg", { timeoutEffect: "allow" });
    expect(request.timeoutEffect).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// message validation
// ---------------------------------------------------------------------------

describe("ServerApprovalBackend message validation", () => {
  it("rejects empty message", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("Bash", {}, ""),
    ).rejects.toThrow(EdictumConfigError);
  });

  it("accepts message of exactly 4096 chars", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("Bash", {}, "x".repeat(4096)),
    ).resolves.toBeDefined();
  });

  it("rejects message exceeding 4096 chars", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("Bash", {}, "x".repeat(4097)),
    ).rejects.toThrow(/message too long/);
  });

  it("allows message with newlines and tabs", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: "a1" });
    const backend = new ServerApprovalBackend(client);

    const request = await backend.requestApproval("Bash", {}, "line1\nline2\ttab");
    expect(request.message).toBe("line1\nline2\ttab");
  });
});

describe("security", () => {
  it("rejects path traversal in requestApproval toolName", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);
    await expect(
      backend.requestApproval("../../escape", {}, "msg"),
    ).rejects.toThrow(/Invalid toolName/);
  });

  it("rejects null byte in requestApproval toolName", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);
    await expect(
      backend.requestApproval("tool\x00evil", {}, "msg"),
    ).rejects.toThrow(/Invalid toolName/);
  });

  it("rejects null byte in requestApproval message", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);
    await expect(
      backend.requestApproval("Bash", {}, "msg\x00evil"),
    ).rejects.toThrow(/control characters/);
  });

  it("rejects carriage return in requestApproval message", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);
    await expect(
      backend.requestApproval("Bash", {}, "msg\x0devil"),
    ).rejects.toThrow(/control characters/);
  });

  it("rejects vertical tab in requestApproval message", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);
    await expect(
      backend.requestApproval("Bash", {}, "msg\x0bevil"),
    ).rejects.toThrow(/control characters/);
  });

  it("rejects DEL character in requestApproval message", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);
    await expect(
      backend.requestApproval("Bash", {}, "msg\x7fevil"),
    ).rejects.toThrow(/control characters/);
  });

  it("rejects C1 control char NEL in message", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);
    await expect(
      backend.requestApproval("Bash", {}, "msg\u0085evil"),
    ).rejects.toThrow(/control characters/);
  });

  it("rejects line separator U+2028 in message", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);
    await expect(
      backend.requestApproval("Bash", {}, "msg\u2028evil"),
    ).rejects.toThrow(/control characters/);
  });

  it("rejects paragraph separator U+2029 in message", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);
    await expect(
      backend.requestApproval("Bash", {}, "msg\u2029evil"),
    ).rejects.toThrow(/control characters/);
  });

  it("rejects path traversal in waitForDecision approvalId", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);

    const err = await backend.waitForDecision("../../admin/secrets").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdictumConfigError);
    expect((err as Error).message).toMatch(/Invalid approvalId/);
  });

  it("rejects control characters in waitForDecision approvalId", async () => {
    const client = mockClient();
    const backend = new ServerApprovalBackend(client);

    const err = await backend.waitForDecision("id\x00injected").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdictumConfigError);
    expect((err as Error).message).toMatch(/Invalid approvalId/);
  });

  it("rejects path traversal in server-returned approvalId", async () => {
    const client = mockClient();
    (client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "../../../etc" });
    const backend = new ServerApprovalBackend(client);

    const err = await backend.requestApproval("Tool", {}, "msg").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdictumConfigError);
    expect((err as Error).message).toMatch(/Server returned invalid approvalId/);
  });
});
