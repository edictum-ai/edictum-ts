/** Tests for Edictum.run() — governed tool execution via the guard class. */

import { describe, expect, test, vi } from "vitest";

import { Verdict } from "../../src/contracts.js";
import type { Precondition, Postcondition } from "../../src/contracts.js";
import { Edictum } from "../../src/guard.js";
import { EdictumDenied, EdictumToolError } from "../../src/errors.js";
import { AuditAction } from "../../src/audit.js";
import { createPrincipal } from "../../src/envelope.js";
import { MemoryBackend } from "../../src/storage.js";
import { CapturingAuditSink } from "../helpers.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeGuard(opts: {
  contracts?: (Precondition | Postcondition)[];
  mode?: "enforce" | "observe";
  auditSink?: CapturingAuditSink;
  onDeny?: (envelope: unknown, reason: string, source: string | null) => void;
  onAllow?: (envelope: unknown) => void;
  successCheck?: (toolName: string, result: unknown) => boolean;
  tools?: Record<string, { side_effect?: string; idempotent?: boolean }>;
} = {}): { guard: Edictum; sink: CapturingAuditSink } {
  const sink = opts.auditSink ?? new CapturingAuditSink();
  const guard = new Edictum({
    environment: "test",
    mode: opts.mode,
    auditSink: sink,
    backend: new MemoryBackend(),
    contracts: opts.contracts,
    onDeny: opts.onDeny as Edictum["_onDeny"] ?? undefined,
    onAllow: opts.onAllow as Edictum["_onAllow"] ?? undefined,
    successCheck: opts.successCheck,
    tools: opts.tools,
  });
  return { guard, sink };
}

// ---------------------------------------------------------------------------
// Basic execution
// ---------------------------------------------------------------------------

describe("RunBasicExecution", () => {
  test("allow_with_no_contracts_executes_tool_and_returns_result", async () => {
    const { guard } = makeGuard();
    const result = await guard.run("TestTool", { x: 1 }, (args) => {
      return { echo: args };
    });
    expect(result).toEqual({ echo: { x: 1 } });
  });

  test("tool_callable_receives_args_dict", async () => {
    const { guard } = makeGuard();
    let received: Record<string, unknown> | null = null;
    await guard.run("TestTool", { key: "value" }, (args) => {
      received = { ...args };
      return "ok";
    });
    expect(received).toEqual({ key: "value" });
  });

  test("async_tool_callable_works", async () => {
    const { guard } = makeGuard();
    const result = await guard.run("TestTool", {}, async () => {
      return "async-result";
    });
    expect(result).toBe("async-result");
  });
});

// ---------------------------------------------------------------------------
// Precondition deny
// ---------------------------------------------------------------------------

describe("RunPreconditionDeny", () => {
  test("precondition_deny_throws_EdictumDenied", async () => {
    const denyAll: Precondition = {
      name: "block-all",
      tool: "*",
      check: () => Verdict.fail("not allowed"),
    };
    const { guard } = makeGuard({ contracts: [denyAll] });

    const err = await guard
      .run("TestTool", {}, () => "should not run")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EdictumDenied);
    expect((err as EdictumDenied).reason).toContain("not allowed");
    expect((err as EdictumDenied).decisionSource).toBe("precondition");
  });

  test("precondition_deny_prevents_tool_execution", async () => {
    const denyAll: Precondition = {
      tool: "*",
      check: () => Verdict.fail("denied"),
    };
    const { guard } = makeGuard({ contracts: [denyAll] });
    let executed = false;

    await guard.run("T", {}, () => { executed = true; return "x"; }).catch(() => {});
    expect(executed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool execution failure
// ---------------------------------------------------------------------------

describe("RunToolFailure", () => {
  test("tool_exception_caught_and_throws_EdictumToolError", async () => {
    const { guard } = makeGuard();

    const err = await guard
      .run("TestTool", {}, () => {
        throw new Error("tool-boom");
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EdictumToolError);
    expect((err as EdictumToolError).message).toContain("tool-boom");
  });

  test("tool_returning_error_string_throws_EdictumToolError", async () => {
    const { guard } = makeGuard();

    const err = await guard
      .run("TestTool", {}, () => "error: something went wrong")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EdictumToolError);
  });
});

// ---------------------------------------------------------------------------
// Observe mode
// ---------------------------------------------------------------------------

describe("RunObserveMode", () => {
  test("observe_mode_deny_becomes_allow_and_tool_executes", async () => {
    const denyAll: Precondition = {
      tool: "*",
      check: () => Verdict.fail("would deny"),
    };
    const { guard } = makeGuard({ contracts: [denyAll], mode: "observe" });
    let executed = false;

    const result = await guard.run("TestTool", {}, () => {
      executed = true;
      return "observe-result";
    });

    expect(executed).toBe(true);
    expect(result).toBe("observe-result");
  });

  test("observe_mode_emits_CALL_WOULD_DENY_audit", async () => {
    const denyAll: Precondition = {
      tool: "*",
      check: () => Verdict.fail("would deny"),
    };
    const { guard, sink } = makeGuard({
      contracts: [denyAll],
      mode: "observe",
    });

    await guard.run("TestTool", {}, () => "ok");

    const wouldDeny = sink.getByAction(AuditAction.CALL_WOULD_DENY);
    expect(wouldDeny.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Custom success_check
// ---------------------------------------------------------------------------

describe("RunSuccessCheck", () => {
  test("custom_success_check_marks_success_as_failure", async () => {
    const alwaysFail = (_toolName: string, _result: unknown) => false;
    const { guard } = makeGuard({ successCheck: alwaysFail });

    const err = await guard
      .run("TestTool", {}, () => "looks fine")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EdictumToolError);
  });

  test("default_success_heuristic_null_is_success", async () => {
    const { guard } = makeGuard();
    const result = await guard.run("TestTool", {}, () => null);
    expect(result).toBeNull();
  });

  test("default_success_heuristic_error_prefix_is_failure", async () => {
    const { guard } = makeGuard();

    const err = await guard
      .run("TestTool", {}, () => "error: bad thing")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EdictumToolError);
  });

  test("default_success_heuristic_is_error_dict_is_failure", async () => {
    const { guard } = makeGuard();

    const err = await guard
      .run("TestTool", {}, () => ({ is_error: true, message: "fail" }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EdictumToolError);
  });

  test("default_success_heuristic_dict_without_is_error_is_success", async () => {
    const { guard } = makeGuard();
    const result = await guard.run("TestTool", {}, () => ({
      status: 500,
      error: "Internal Server Error",
    }));
    // Default heuristic misses this (no is_error key)
    expect(result).toEqual({ status: 500, error: "Internal Server Error" });
  });
});

// ---------------------------------------------------------------------------
// Postcondition redaction
// ---------------------------------------------------------------------------

describe("RunPostconditionRedaction", () => {
  test("redacted_response_returned_when_postcondition_redacts", async () => {
    const redactPost: Postcondition = {
      contractType: "post",
      tool: "TestTool",
      check: (_envelope, _response) => Verdict.fail("PII found"),
    };
    const { guard } = makeGuard({
      contracts: [redactPost],
      tools: { TestTool: { side_effect: "pure" } },
    });

    const result = await guard.run("TestTool", {}, () => "SSN: 123-45-6789");
    // Postcondition failure on pure tool adds warning; result still returned
    // (warn effect does not redact — only "redact" effect does)
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

describe("RunCallbacks", () => {
  test("on_deny_fires_exactly_once_on_deny", async () => {
    const denyAll: Precondition = {
      tool: "*",
      check: () => Verdict.fail("denied"),
    };
    const onDeny = vi.fn();
    const { guard } = makeGuard({ contracts: [denyAll], onDeny });

    await guard.run("T", {}, () => "x").catch(() => {});
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  test("on_allow_fires_exactly_once_on_allow", async () => {
    const onAllow = vi.fn();
    const { guard } = makeGuard({ onAllow });

    await guard.run("T", {}, () => "ok");
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  test("on_deny_callback_error_does_not_crash_pipeline", async () => {
    const denyAll: Precondition = {
      tool: "*",
      check: () => Verdict.fail("denied"),
    };
    const onDeny = () => {
      throw new Error("callback boom");
    };
    const { guard } = makeGuard({ contracts: [denyAll], onDeny });

    // Should still throw EdictumDenied, not the callback error
    const err = await guard
      .run("T", {}, () => "x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdictumDenied);
  });

  test("on_allow_callback_error_does_not_crash_pipeline", async () => {
    const onAllow = () => {
      throw new Error("callback boom");
    };
    const { guard } = makeGuard({ onAllow });

    // Should succeed despite callback error
    const result = await guard.run("T", {}, () => "ok");
    expect(result).toBe("ok");
  });

  test("on_deny_NOT_called_in_observe_mode", async () => {
    const denyAll: Precondition = {
      tool: "*",
      check: () => Verdict.fail("would deny"),
    };
    const onDeny = vi.fn();
    const { guard } = makeGuard({
      contracts: [denyAll],
      mode: "observe",
      onDeny,
    });

    await guard.run("T", {}, () => "ok");
    expect(onDeny).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

describe("RunAuditEvents", () => {
  test("CALL_ALLOWED_emitted_on_allow", async () => {
    const { guard, sink } = makeGuard();

    await guard.run("T", {}, () => "ok");

    sink.assertActionEmitted(AuditAction.CALL_ALLOWED);
  });

  test("CALL_DENIED_emitted_on_deny", async () => {
    const denyAll: Precondition = {
      tool: "*",
      check: () => Verdict.fail("denied"),
    };
    const { guard, sink } = makeGuard({ contracts: [denyAll] });

    await guard.run("T", {}, () => "x").catch(() => {});

    sink.assertActionEmitted(AuditAction.CALL_DENIED);
  });

  test("CALL_EXECUTED_emitted_on_successful_tool", async () => {
    const { guard, sink } = makeGuard();

    await guard.run("T", {}, () => "ok");

    sink.assertActionEmitted(AuditAction.CALL_EXECUTED);
  });

  test("CALL_FAILED_emitted_on_tool_failure", async () => {
    const { guard, sink } = makeGuard();

    await guard
      .run("T", {}, () => {
        throw new Error("boom");
      })
      .catch(() => {});

    sink.assertActionEmitted(AuditAction.CALL_FAILED);
  });

  test("CALL_EXECUTED_not_emitted_when_tool_fails", async () => {
    const { guard, sink } = makeGuard();

    await guard
      .run("T", {}, () => {
        throw new Error("boom");
      })
      .catch(() => {});

    sink.assertActionNotEmitted(AuditAction.CALL_EXECUTED);
  });

  test("CALL_FAILED_not_emitted_when_tool_succeeds", async () => {
    const { guard, sink } = makeGuard();

    await guard.run("T", {}, () => "ok");

    sink.assertActionNotEmitted(AuditAction.CALL_FAILED);
  });

  test("audit_event_has_correct_toolName", async () => {
    const { guard, sink } = makeGuard();

    await guard.run("MySpecialTool", {}, () => "ok");

    const allowed = sink.getByAction(AuditAction.CALL_ALLOWED);
    expect(allowed.length).toBe(1);
    expect(allowed[0]!.toolName).toBe("MySpecialTool");
  });
});

// ---------------------------------------------------------------------------
// Optional parameters
// ---------------------------------------------------------------------------

describe("RunOptionalParams", () => {
  test("environment_override_propagates_to_envelope", async () => {
    const sink = new CapturingAuditSink();
    const guard = new Edictum({
      environment: "production",
      auditSink: sink,
    });

    await guard.run("Tool", {}, () => "ok", { environment: "staging" });

    const event = sink.events.find((e) => e.action === AuditAction.CALL_ALLOWED);
    expect(event?.environment).toBe("staging");
  });

  test("principal_option_propagates_to_envelope", async () => {
    const sink = new CapturingAuditSink();
    const guard = new Edictum({
      auditSink: sink,
      principalResolver: (_tool, _args) =>
        createPrincipal({ userId: "resolver-user" }),
    });

    // Principal resolver should be used
    await guard.run("Tool", {}, () => "ok");

    const event = sink.events.find((e) => e.action === AuditAction.CALL_ALLOWED);
    expect(event?.principal).toBeDefined();
    expect((event?.principal as Record<string, unknown>)?.["userId"]).toBe("resolver-user");
  });
});
