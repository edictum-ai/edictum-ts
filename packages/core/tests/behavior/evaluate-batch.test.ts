/** Tests for Edictum.evaluateBatch() and evaluate() security edge cases. */

import { describe, expect, test } from "vitest";

import { Verdict } from "../../src/contracts.js";
import type {
  Precondition,
  Postcondition,
} from "../../src/contracts.js";
import { Edictum } from "../../src/guard.js";
import { MemoryBackend } from "../../src/storage.js";
import { NullAuditSink } from "../helpers.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeGuard(opts: {
  contracts?: (Precondition | Postcondition)[];
  mode?: "enforce" | "observe";
} = {}): Edictum {
  return new Edictum({
    environment: "test",
    mode: opts.mode,
    auditSink: new NullAuditSink(),
    backend: new MemoryBackend(),
    contracts: opts.contracts,
  });
}

// ---------------------------------------------------------------------------
// evaluateBatch()
// ---------------------------------------------------------------------------

describe("EvaluateBatch", () => {
  test("batch_correct_length", async () => {
    const guard = makeGuard();
    const results = await guard.evaluateBatch([
      { tool: "ToolA", args: { a: 1 } },
      { tool: "ToolB", args: { b: 2 } },
      { tool: "ToolC", args: { c: 3 } },
    ]);

    expect(results.length).toBe(3);
  });

  test("batch_mixed_results", async () => {
    const denyBash: Precondition = {
      name: "deny-bash",
      tool: "Bash",
      check: () => Verdict.fail("bash denied"),
    };
    const guard = makeGuard({ contracts: [denyBash] });
    const results = await guard.evaluateBatch([
      { tool: "Bash", args: { command: "ls" } },
      { tool: "Read", args: { path: "x" } },
    ]);

    expect(results.length).toBe(2);
    expect(results[0]!.verdict).toBe("deny");
    expect(results[1]!.verdict).toBe("allow");
  });

  test("batch_principal_dict_conversion", async () => {
    const requireTicket: Precondition = {
      name: "require-ticket",
      tool: "*",
      check: (envelope) => {
        if (envelope.principal?.ticketRef == null) {
          return Verdict.fail("Ticket required");
        }
        return Verdict.pass_();
      },
    };
    const guard = makeGuard({ contracts: [requireTicket] });
    const results = await guard.evaluateBatch([
      {
        tool: "Deploy",
        args: {},
        principal: { ticketRef: "JIRA-42" },
      },
    ]);

    expect(results.length).toBe(1);
    expect(results[0]!.verdict).toBe("allow");
  });

  test("batch_output_dict_serialized_to_json", async () => {
    const checkOutput: Postcondition = {
      contractType: "post",
      tool: "*",
      check: (_envelope, response) => {
        if (typeof response === "string" && response.includes("secret")) {
          return Verdict.fail("secret found");
        }
        return Verdict.pass_();
      },
    };
    const guard = makeGuard({ contracts: [checkOutput] });
    const results = await guard.evaluateBatch([
      {
        tool: "Search",
        args: {},
        output: { text: "contains secret data" },
      },
    ]);

    expect(results.length).toBe(1);
    expect(results[0]!.verdict).toBe("warn");
  });

  test("batch_empty_list", async () => {
    const guard = makeGuard();
    const results = await guard.evaluateBatch([]);

    expect(results).toEqual([]);
  });

  test("batch_string_output_passed_as_is", async () => {
    const checkOutput: Postcondition = {
      contractType: "post",
      tool: "*",
      check: (_envelope, response) => {
        if (String(response).includes("PII")) {
          return Verdict.fail("PII detected");
        }
        return Verdict.pass_();
      },
    };
    const guard = makeGuard({ contracts: [checkOutput] });
    const results = await guard.evaluateBatch([
      { tool: "Read", args: {}, output: "contains PII data" },
    ]);

    expect(results.length).toBe(1);
    expect(results[0]!.verdict).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// Security: postcondition deny-effect exception must produce deny verdict
// ---------------------------------------------------------------------------

describe("security", () => {
  test("postcondition_deny_effect_exception_produces_deny_verdict", async () => {
    const throwingDeny = {
      _edictum_type: "postcondition",
      name: "deny-on-pii",
      tool: "*",
      effect: "deny",
      check: () => { throw new Error("check crashed"); },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ contracts: [throwingDeny as any] });
    const result = await guard.evaluate("TestTool", {}, {
      output: "some output",
    });

    expect(result.verdict).toBe("deny");
    expect(result.denyReasons.length).toBe(1);
    expect(result.policyError).toBe(true);
  });

  test("postcondition_warn_effect_exception_produces_warn_verdict", async () => {
    const throwingWarn = {
      _edictum_type: "postcondition",
      name: "warn-on-pii",
      tool: "*",
      effect: "warn",
      check: () => { throw new Error("check crashed"); },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ contracts: [throwingWarn as any] });
    const result = await guard.evaluate("TestTool", {}, {
      output: "some output",
    });

    expect(result.verdict).toBe("warn");
    expect(result.warnReasons.length).toBe(1);
  });
});
