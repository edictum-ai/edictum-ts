import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Edictum,
  CollectingAuditSink,
  AuditAction,
  createPrincipal,
} from "@edictum/core";
import type { Precondition, Postcondition, Verdict } from "@edictum/core";

import { EdictumOpenClawAdapter } from "../src/adapter.js";
import type { ToolHookContext, BeforeToolCallEvent, AfterToolCallEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolHookContext> = {}): ToolHookContext {
  return {
    toolName: "exec",
    agentId: "agent-1",
    sessionKey: "sk-test",
    sessionId: "sid-test",
    runId: "run-test",
    toolCallId: "tc-1",
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<BeforeToolCallEvent> = {},
): BeforeToolCallEvent {
  return {
    toolName: "exec",
    params: { command: "ls -la" },
    runId: "run-test",
    toolCallId: "tc-1",
    ...overrides,
  };
}

function makeAfterEvent(
  overrides: Partial<AfterToolCallEvent> = {},
): AfterToolCallEvent {
  return {
    toolName: "exec",
    params: { command: "ls -la" },
    runId: "run-test",
    toolCallId: "tc-1",
    result: "file1.txt\nfile2.txt",
    durationMs: 42,
    ...overrides,
  };
}

const noRm: Precondition = {
  tool: "exec",
  check: async (envelope) => {
    const cmd = envelope.args.command;
    if (typeof cmd === "string" && cmd.includes("rm -rf")) {
      return { passed: false, message: "rm -rf denied", metadata: Object.freeze({}) };
    }
    return { passed: true, message: null, metadata: Object.freeze({}) };
  },
};

const detectSecrets: Postcondition = {
  contractType: "post" as const,
  tool: "*",
  check: async (_envelope, response) => {
    const text = typeof response === "string" ? response : JSON.stringify(response);
    if (text.includes("sk-secret")) {
      return { passed: false, message: "Secret detected in output", metadata: Object.freeze({}) };
    }
    return { passed: true, message: null, metadata: Object.freeze({}) };
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EdictumOpenClawAdapter", () => {
  let sink: CollectingAuditSink;

  beforeEach(() => {
    sink = new CollectingAuditSink();
  });

  describe("pre-execution", () => {
    it("allows safe tool calls", async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard);
      const ctx = makeCtx();

      const result = await adapter.pre("exec", { command: "ls -la" }, "tc-1", ctx);

      expect(result).toBeNull();
    });

    it("denies dangerous tool calls", async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard);
      const ctx = makeCtx();

      const result = await adapter.pre(
        "exec",
        { command: "rm -rf /" },
        "tc-2",
        ctx,
      );

      expect(result).toBe("rm -rf denied");
    });

    it("emits CALL_DENIED audit event on deny", async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard);
      const ctx = makeCtx();

      await adapter.pre("exec", { command: "rm -rf /" }, "tc-2", ctx);

      expect(sink.events.length).toBeGreaterThanOrEqual(1);
      const denied = sink.events.find(
        (e) => e.action === AuditAction.CALL_DENIED,
      );
      expect(denied).toBeDefined();
      expect(denied!.toolName).toBe("exec");
    });

    it("emits CALL_ALLOWED audit event on allow", async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard);
      const ctx = makeCtx();

      await adapter.pre("exec", { command: "ls" }, "tc-1", ctx);

      const allowed = sink.events.find(
        (e) => e.action === AuditAction.CALL_ALLOWED,
      );
      expect(allowed).toBeDefined();
    });
  });

  describe("observe mode", () => {
    it("converts deny to allow with CALL_WOULD_DENY audit", async () => {
      const guard = new Edictum({
        contracts: [noRm],
        auditSink: sink,
        mode: "observe",
      });
      const adapter = new EdictumOpenClawAdapter(guard);
      const ctx = makeCtx();

      const result = await adapter.pre(
        "exec",
        { command: "rm -rf /" },
        "tc-3",
        ctx,
      );

      // Observe mode: allow despite deny
      expect(result).toBeNull();

      const wouldDeny = sink.events.find(
        (e) => e.action === AuditAction.CALL_WOULD_DENY,
      );
      expect(wouldDeny).toBeDefined();
    });
  });

  describe("post-execution", () => {
    it("returns findings on postcondition failure", async () => {
      const guard = new Edictum({
        contracts: [detectSecrets],
        auditSink: sink,
      });
      const adapter = new EdictumOpenClawAdapter(guard);
      const ctx = makeCtx();

      // Pre-execute to register pending
      await adapter.pre("exec", { command: "cat config" }, "tc-4", ctx);

      // Post-execute with secret in output
      const postResult = await adapter.post(
        "tc-4",
        "config: sk-secret-key-12345",
        makeAfterEvent({ toolCallId: "tc-4", result: "config: sk-secret-key-12345" }),
      );

      expect(postResult.postconditionsPassed).toBe(false);
      expect(postResult.findings.length).toBeGreaterThan(0);
    });

    it("handles unknown callId gracefully", async () => {
      const guard = new Edictum({ auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard);

      const postResult = await adapter.post(
        "unknown-id",
        "result",
        makeAfterEvent({ toolCallId: "unknown-id" }),
      );

      expect(postResult.postconditionsPassed).toBe(true);
      expect(postResult.findings).toEqual([]);
    });
  });

  describe("hook handlers", () => {
    it("handleBeforeToolCall returns block on deny", async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard);
      const event = makeEvent({ params: { command: "rm -rf /" } });
      const ctx = makeCtx();

      const result = await adapter.handleBeforeToolCall(event, ctx);

      expect(result).toBeDefined();
      expect(result!.block).toBe(true);
      expect(result!.blockReason).toBe("rm -rf denied");
    });

    it("handleBeforeToolCall returns undefined on allow", async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard);
      const event = makeEvent({ params: { command: "ls" } });
      const ctx = makeCtx();

      const result = await adapter.handleBeforeToolCall(event, ctx);

      expect(result).toBeUndefined();
    });

    it("handleAfterToolCall completes without error", async () => {
      const guard = new Edictum({ auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard);
      const ctx = makeCtx();

      // Pre first
      await adapter.handleBeforeToolCall(makeEvent(), ctx);

      // After
      await adapter.handleAfterToolCall(makeAfterEvent(), ctx);

      const executed = sink.events.find(
        (e) => e.action === AuditAction.CALL_EXECUTED,
      );
      expect(executed).toBeDefined();
    });
  });

  describe("callbacks", () => {
    it("calls onDeny callback on denial", async () => {
      const onDeny = vi.fn();
      const guard = new Edictum({ contracts: [noRm], auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard, { onDeny });
      const ctx = makeCtx();

      await adapter.pre("exec", { command: "rm -rf /" }, "tc-5", ctx);

      expect(onDeny).toHaveBeenCalledOnce();
      expect(onDeny.mock.calls[0][1]).toBe("rm -rf denied");
    });

    it("calls onAllow callback on allow", async () => {
      const onAllow = vi.fn();
      const guard = new Edictum({ contracts: [noRm], auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard, { onAllow });
      const ctx = makeCtx();

      await adapter.pre("exec", { command: "ls" }, "tc-6", ctx);

      expect(onAllow).toHaveBeenCalledOnce();
    });

    it("swallows callback errors silently", async () => {
      const onDeny = vi.fn(() => {
        throw new Error("callback exploded");
      });
      const guard = new Edictum({ contracts: [noRm], auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard, { onDeny });
      const ctx = makeCtx();

      // Should not throw
      const result = await adapter.pre(
        "exec",
        { command: "rm -rf /" },
        "tc-7",
        ctx,
      );
      expect(result).toBe("rm -rf denied");
      expect(onDeny).toHaveBeenCalledOnce();
    });
  });

  describe("principal", () => {
    it("uses static principal", async () => {
      const principal = createPrincipal({ userId: "alice", role: "admin" });
      const guard = new Edictum({ auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard, { principal });
      const ctx = makeCtx();

      await adapter.pre("exec", { command: "ls" }, "tc-8", ctx);

      const event = sink.events[0];
      expect(event.principal).toBeDefined();
      expect((event.principal as Record<string, unknown>).userId).toBe("alice");
    });

    it("principalResolver overrides static principal", async () => {
      const principal = createPrincipal({ userId: "alice" });
      const resolver = vi.fn(() => createPrincipal({ userId: "bob" }));
      const guard = new Edictum({ auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard, {
        principal,
        principalResolver: resolver,
      });
      const ctx = makeCtx();

      await adapter.pre("exec", { command: "ls" }, "tc-9", ctx);

      expect(resolver).toHaveBeenCalledOnce();
      const event = sink.events[0];
      expect((event.principal as Record<string, unknown>).userId).toBe("bob");
    });
  });

  describe("session tracking", () => {
    it("increments attempt count on every pre call", async () => {
      const guard = new Edictum({ contracts: [noRm], auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard);
      const ctx = makeCtx();

      await adapter.pre("exec", { command: "rm -rf /" }, "tc-a", ctx);
      await adapter.pre("exec", { command: "rm -rf /" }, "tc-b", ctx);
      await adapter.pre("exec", { command: "ls" }, "tc-c", ctx);

      // 3 attempts (2 denied + 1 allowed)
      const lastEvent = sink.events[sink.events.length - 1];
      expect(lastEvent.sessionAttemptCount).toBe(3);
    });
  });

  describe("metadata", () => {
    it("includes OpenClaw context in envelope metadata", async () => {
      const guard = new Edictum({ auditSink: sink });
      const adapter = new EdictumOpenClawAdapter(guard);
      const ctx = makeCtx({
        agentId: "my-agent",
        sessionKey: "my-session-key",
        sessionId: "my-session-id",
      });

      await adapter.pre("exec", { command: "ls" }, "tc-meta", ctx);

      // Verify via audit event — metadata flows through the envelope
      const event = sink.events[0];
      expect(event).toBeDefined();
      expect(event.toolName).toBe("exec");
    });
  });
});
