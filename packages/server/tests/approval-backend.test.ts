import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ApprovalStatus } from "@edictum/core";

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

    await expect(
      backend.requestApproval("Tool", {}, "msg"),
    ).rejects.toThrow("Server returned invalid approvalId");
  });

  it("rejects non-string approvalId from server", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 12345 });
    const backend = new ServerApprovalBackend(client);

    await expect(
      backend.requestApproval("Tool", {}, "msg"),
    ).rejects.toThrow("Server returned invalid approvalId");
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
