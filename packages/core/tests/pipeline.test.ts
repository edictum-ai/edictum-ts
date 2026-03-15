/** Tests for GovernancePipeline -- full preExecute and postExecute flows. */

import { describe, expect, test } from "vitest";

import { Verdict } from "../src/contracts.js";
import type {
  Precondition,
  Postcondition,
  SessionContract,
} from "../src/contracts.js";
import { createEnvelope, SideEffect, ToolRegistry } from "../src/envelope.js";
import type { ToolEnvelope } from "../src/envelope.js";
import { Edictum } from "../src/guard.js";
import { HookDecision } from "../src/hooks.js";
import type { OperationLimits } from "../src/limits.js";
import { GovernancePipeline } from "../src/pipeline.js";
import { Session } from "../src/session.js";
import { MemoryBackend } from "../src/storage.js";
import type { HookRegistration } from "../src/types.js";
import { NullAuditSink } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface MakeGuardOptions {
  environment?: string;
  mode?: "enforce" | "observe";
  limits?: OperationLimits;
  contracts?: (Precondition | Postcondition | SessionContract)[];
  hooks?: HookRegistration[];
  backend?: MemoryBackend;
  tools?: Record<string, { side_effect?: string; idempotent?: boolean }>;
}

function makeGuard(opts: MakeGuardOptions = {}): Edictum {
  return new Edictum({
    environment: opts.environment ?? "test",
    mode: opts.mode,
    auditSink: new NullAuditSink(),
    backend: opts.backend ?? new MemoryBackend(),
    contracts: opts.contracts,
    hooks: opts.hooks,
    limits: opts.limits,
    tools: opts.tools,
  });
}

// ---------------------------------------------------------------------------
// TestPreExecute
// ---------------------------------------------------------------------------

describe("TestPreExecute", () => {
  test("allow_with_no_contracts", async () => {
    const backend = new MemoryBackend();
    const guard = makeGuard({ backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});
    const session = new Session("pipeline-test", backend);
    await session.incrementAttempts();

    const decision = await pipeline.preExecute(envelope, session);
    expect(decision.action).toBe("allow");
    expect(decision.reason).toBeNull();
  });

  test("attempt_limit_deny", async () => {
    const backend = new MemoryBackend();
    const guard = makeGuard({
      limits: { maxAttempts: 2, maxToolCalls: 200, maxCallsPerTool: {} },
      backend,
    });
    const session = new Session("test", backend);
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});

    // Simulate 2 attempts (>= maxAttempts=2)
    await session.incrementAttempts();
    await session.incrementAttempts();

    const decision = await pipeline.preExecute(envelope, session);
    expect(decision.action).toBe("deny");
    expect(decision.decisionSource).toBe("attempt_limit");
    expect(decision.reason!.toLowerCase()).toContain("retry loop");
  });

  test("hook_deny", async () => {
    const backend = new MemoryBackend();
    function denyAll(_envelope: ToolEnvelope): HookDecision {
      return HookDecision.deny("denied by hook");
    }

    const hook: HookRegistration = {
      phase: "before",
      tool: "*",
      callback: denyAll,
    };
    const guard = makeGuard({ hooks: [hook], backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});
    const session = new Session("pipeline-test", backend);
    await session.incrementAttempts();

    const decision = await pipeline.preExecute(envelope, session);
    expect(decision.action).toBe("deny");
    expect(decision.decisionSource).toBe("hook");
    expect(decision.reason).toBe("denied by hook");
    expect(decision.hooksEvaluated).toHaveLength(1);
    expect(decision.hooksEvaluated[0]!["result"]).toBe("deny");
  });

  test("hook_allow_continues", async () => {
    const backend = new MemoryBackend();
    function allowAll(_envelope: ToolEnvelope): HookDecision {
      return HookDecision.allow();
    }

    const hook: HookRegistration = {
      phase: "before",
      tool: "*",
      callback: allowAll,
    };
    const guard = makeGuard({ hooks: [hook], backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});
    const session = new Session("pipeline-test", backend);
    await session.incrementAttempts();

    const decision = await pipeline.preExecute(envelope, session);
    expect(decision.action).toBe("allow");
    expect(decision.hooksEvaluated).toHaveLength(1);
  });

  test("precondition_deny", async () => {
    const backend = new MemoryBackend();
    const mustHaveName: Precondition = {
      tool: "*",
      check: (envelope) => {
        if (!("name" in envelope.args)) {
          return Verdict.fail("Missing required arg: name");
        }
        return Verdict.pass_();
      },
    };

    const guard = makeGuard({ contracts: [mustHaveName], backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});
    const session = new Session("pipeline-test", backend);
    await session.incrementAttempts();

    const decision = await pipeline.preExecute(envelope, session);
    expect(decision.action).toBe("deny");
    expect(decision.decisionSource).toBe("precondition");
    expect(decision.reason).toContain("name");
  });

  test("precondition_pass", async () => {
    const backend = new MemoryBackend();
    const mustHaveName: Precondition = {
      tool: "*",
      check: (envelope) => {
        if (!("name" in envelope.args)) {
          return Verdict.fail("Missing required arg: name");
        }
        return Verdict.pass_();
      },
    };

    const guard = makeGuard({ contracts: [mustHaveName], backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", { name: "test" });
    const session = new Session("pipeline-test", backend);
    await session.incrementAttempts();

    const decision = await pipeline.preExecute(envelope, session);
    expect(decision.action).toBe("allow");
  });

  test("session_contract_deny", async () => {
    const backend = new MemoryBackend();
    const max3Execs: SessionContract = {
      check: async (sess) => {
        const count = await sess.executionCount();
        if (count >= 3) {
          return Verdict.fail("Too many executions");
        }
        return Verdict.pass_();
      },
    };

    const session = new Session("pipeline-test", backend);

    // Simulate 3 executions
    for (let i = 0; i < 3; i++) {
      await session.recordExecution("T", true);
    }

    const guard = makeGuard({ contracts: [max3Execs], backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});
    await session.incrementAttempts();

    const decision = await pipeline.preExecute(envelope, session);
    expect(decision.action).toBe("deny");
    expect(decision.decisionSource).toBe("session_contract");
  });

  test("execution_limit_deny", async () => {
    const backend = new MemoryBackend();
    const guard = makeGuard({
      limits: { maxAttempts: 500, maxToolCalls: 2, maxCallsPerTool: {} },
      backend,
    });
    const session = new Session("test", backend);
    const pipeline = new GovernancePipeline(guard);

    // Record 2 executions
    await session.recordExecution("T", true);
    await session.recordExecution("T", true);
    await session.incrementAttempts();

    const envelope = createEnvelope("TestTool", {});
    const decision = await pipeline.preExecute(envelope, session);
    expect(decision.action).toBe("deny");
    expect(decision.decisionSource).toBe("operation_limit");
    expect(decision.decisionName).toBe("max_tool_calls");
  });

  test("per_tool_limit_deny", async () => {
    const backend = new MemoryBackend();
    const guard = makeGuard({
      limits: {
        maxAttempts: 500,
        maxToolCalls: 200,
        maxCallsPerTool: { Bash: 1 },
      },
      backend,
    });
    const session = new Session("test", backend);
    const pipeline = new GovernancePipeline(guard);

    await session.recordExecution("Bash", true);
    await session.incrementAttempts();

    const envelope = createEnvelope("Bash", { command: "ls" });
    const decision = await pipeline.preExecute(envelope, session);
    expect(decision.action).toBe("deny");
    expect(decision.reason!.toLowerCase()).toContain("per-tool limit");
  });

  test("evaluation_order", async () => {
    /** Verify hooks run before preconditions. */
    const backend = new MemoryBackend();
    const order: string[] = [];

    function trackingHook(_envelope: ToolEnvelope): HookDecision {
      order.push("hook");
      return HookDecision.allow();
    }

    const trackingPrecondition: Precondition = {
      tool: "*",
      check: (_envelope) => {
        order.push("precondition");
        return Verdict.pass_();
      },
    };

    const hook: HookRegistration = {
      phase: "before",
      tool: "*",
      callback: trackingHook,
    };
    const guard = makeGuard({
      contracts: [trackingPrecondition],
      hooks: [hook],
      backend,
    });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});
    const session = new Session("pipeline-test", backend);
    await session.incrementAttempts();

    await pipeline.preExecute(envelope, session);
    expect(order).toEqual(["hook", "precondition"]);
  });

  test("contracts_evaluated_populated", async () => {
    const backend = new MemoryBackend();
    const checkA: Precondition = {
      tool: "*",
      check: (_envelope) => Verdict.pass_(),
    };

    const guard = makeGuard({ contracts: [checkA], backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});
    const session = new Session("pipeline-test", backend);
    await session.incrementAttempts();

    const decision = await pipeline.preExecute(envelope, session);
    expect(decision.contractsEvaluated).toHaveLength(1);
    expect(decision.contractsEvaluated[0]!["type"]).toBe("precondition");
    expect(decision.contractsEvaluated[0]!["passed"]).toBe(true);
  });

  test("tool_specific_precondition", async () => {
    const backend = new MemoryBackend();
    const bashOnly: Precondition = {
      tool: "Bash",
      check: (_envelope) => Verdict.fail("bash denied"),
    };

    const guard = makeGuard({ contracts: [bashOnly], backend });
    const pipeline = new GovernancePipeline(guard);
    const session = new Session("pipeline-test", backend);

    // Non-Bash tool should not be affected
    const readEnvelope = createEnvelope("Read", { file_path: "/tmp/x" });
    await session.incrementAttempts();
    const readDecision = await pipeline.preExecute(readEnvelope, session);
    expect(readDecision.action).toBe("allow");

    // Bash tool should be denied
    const bashEnvelope = createEnvelope("Bash", { command: "ls" });
    const bashDecision = await pipeline.preExecute(bashEnvelope, session);
    expect(bashDecision.action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// TestPostExecute
// ---------------------------------------------------------------------------

describe("TestPostExecute", () => {
  test("success_no_postconditions", async () => {
    const backend = new MemoryBackend();
    const guard = makeGuard({ backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});

    const decision = await pipeline.postExecute(envelope, "ok", true);
    expect(decision.toolSuccess).toBe(true);
    expect(decision.postconditionsPassed).toBe(true);
    expect(decision.warnings).toEqual([]);
  });

  test("postcondition_failure_pure_tool", async () => {
    const backend = new MemoryBackend();
    // Postcondition check takes 2 args: (envelope, result)
    const checkResult: Postcondition = {
      contractType: "post",
      tool: "TestTool",
      check: (_envelope, result) => {
        if (result !== "expected") {
          return Verdict.fail("Unexpected result");
        }
        return Verdict.pass_();
      },
    };

    const guard = makeGuard({
      contracts: [checkResult],
      backend,
      tools: { TestTool: { side_effect: "pure" } },
    });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {}, {
      registry: guard.toolRegistry,
    });

    const decision = await pipeline.postExecute(envelope, "wrong", true);
    expect(decision.postconditionsPassed).toBe(false);
    expect(decision.warnings).toHaveLength(1);
    expect(decision.warnings[0]!.toLowerCase()).toContain("consider retrying");
  });

  test("postcondition_failure_write_tool", async () => {
    const backend = new MemoryBackend();
    const checkWrite: Postcondition = {
      contractType: "post",
      tool: "WriteTool",
      check: (_envelope, _result) => {
        return Verdict.fail("Write verification failed");
      },
    };

    const guard = makeGuard({ contracts: [checkWrite], backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("WriteTool", {});

    const decision = await pipeline.postExecute(envelope, "result", true);
    expect(decision.postconditionsPassed).toBe(false);
    expect(decision.warnings[0]!.toLowerCase()).toContain(
      "assess before proceeding",
    );
  });

  test("after_hooks_called", async () => {
    const backend = new MemoryBackend();
    const called: unknown[] = [];

    function afterHook(_envelope: ToolEnvelope, result: unknown): void {
      called.push(result);
    }

    const hook: HookRegistration = {
      phase: "after",
      tool: "*",
      callback: afterHook,
    };
    const guard = makeGuard({ hooks: [hook], backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});

    await pipeline.postExecute(envelope, "the_result", true);
    expect(called).toEqual(["the_result"]);
  });

  test("tool_failure_reported", async () => {
    const backend = new MemoryBackend();
    const guard = makeGuard({ backend });
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});

    const decision = await pipeline.postExecute(
      envelope,
      "Error: failed",
      false,
    );
    expect(decision.toolSuccess).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TestObserveMode
// ---------------------------------------------------------------------------

describe("TestObserveMode", () => {
  test("global_observe_mode_pipeline_still_returns_deny", async () => {
    // Global observe mode (mode="observe") is handled by Edictum.run() / adapters,
    // NOT by the pipeline. The pipeline always evaluates contracts at face value.
    // When mode="observe", run() converts the deny to allow + CALL_WOULD_DENY audit.
    // This test verifies the pipeline itself does NOT handle global observe mode.
    const backend = new MemoryBackend();
    const alwaysFail: Precondition = {
      tool: "*",
      check: (_envelope) => Verdict.fail("always fails"),
    };

    const guard = makeGuard({
      mode: "observe",
      contracts: [alwaysFail],
      backend,
    });
    const session = new Session("test", backend);
    const pipeline = new GovernancePipeline(guard);
    const envelope = createEnvelope("TestTool", {});
    await session.incrementAttempts();

    const decision = await pipeline.preExecute(envelope, session);
    // Pipeline returns deny — the observe-mode conversion is the caller's job
    expect(decision.action).toBe("deny");
  });
});
