/** Tests for Edictum.evaluate() and Edictum.evaluateBatch() — dry-run evaluation. */

import { describe, expect, test } from "vitest";

import { Verdict } from "../../src/contracts.js";
import type {
  Precondition,
  Postcondition,
} from "../../src/contracts.js";
import { Edictum } from "../../src/guard.js";
import { MemoryBackend } from "../../src/storage.js";
import { NullAuditSink } from "../helpers.js";
import { createPrincipal } from "../../src/envelope.js";

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
// evaluate() — basic verdicts
// ---------------------------------------------------------------------------

describe("EvaluateBasicVerdicts", () => {
  test("no_matching_contracts_returns_allow", async () => {
    const guard = makeGuard();
    const result = await guard.evaluate("UnknownTool", { x: 1 });

    expect(result.verdict).toBe("allow");
    expect(result.contractsEvaluated).toBe(0);
    expect(result.contracts).toEqual([]);
    expect(result.denyReasons).toEqual([]);
    expect(result.warnReasons).toEqual([]);
  });

  test("precondition_deny_returns_deny_with_reasons", async () => {
    const denyAll: Precondition = {
      name: "block-all",
      tool: "*",
      check: () => Verdict.fail("not allowed"),
    };
    const guard = makeGuard({ contracts: [denyAll] });
    const result = await guard.evaluate("TestTool", {});

    expect(result.verdict).toBe("deny");
    expect(result.denyReasons.length).toBe(1);
    expect(result.denyReasons[0]).toContain("not allowed");
    expect(result.contracts[0]!.contractId).toBe("block-all");
    expect(result.contracts[0]!.contractType).toBe("precondition");
    expect(result.contracts[0]!.passed).toBe(false);
  });

  test("precondition_pass_returns_allow", async () => {
    const passAll: Precondition = {
      tool: "*",
      check: () => Verdict.pass_(),
    };
    const guard = makeGuard({ contracts: [passAll] });
    const result = await guard.evaluate("TestTool", {});

    expect(result.verdict).toBe("allow");
    expect(result.denyReasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// evaluate() — postconditions
// ---------------------------------------------------------------------------

describe("EvaluatePostconditions", () => {
  test("postcondition_warn_when_output_provided", async () => {
    const warnPost: Postcondition = {
      contractType: "post",
      name: "pii-check",
      tool: "*",
      check: (_envelope, response) => {
        if (String(response).includes("SSN")) {
          return Verdict.fail("PII detected");
        }
        return Verdict.pass_();
      },
    };
    const guard = makeGuard({ contracts: [warnPost] });
    const result = await guard.evaluate("TestTool", {}, {
      output: "SSN: 123-45-6789",
    });

    expect(result.verdict).toBe("warn");
    expect(result.warnReasons.length).toBeGreaterThanOrEqual(1);
    expect(result.contracts[0]!.contractType).toBe("postcondition");
    expect(result.contracts[0]!.passed).toBe(false);
  });

  test("postcondition_skipped_when_no_output", async () => {
    const warnPost: Postcondition = {
      contractType: "post",
      tool: "*",
      check: () => Verdict.fail("should not fire"),
    };
    const guard = makeGuard({ contracts: [warnPost] });
    const result = await guard.evaluate("TestTool", {});

    expect(result.verdict).toBe("allow");
    expect(result.contractsEvaluated).toBe(0);
  });

  test("postcondition_pass_with_output_returns_allow", async () => {
    const passPost: Postcondition = {
      contractType: "post",
      tool: "*",
      check: () => Verdict.pass_(),
    };
    const guard = makeGuard({ contracts: [passPost] });
    const result = await guard.evaluate("TestTool", {}, { output: "safe" });

    expect(result.verdict).toBe("allow");
    expect(result.warnReasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// evaluate() — exhaustive evaluation (no short-circuit)
// ---------------------------------------------------------------------------

describe("EvaluateExhaustive", () => {
  test("multiple_contracts_evaluated_exhaustively", async () => {
    const ruleA: Precondition = {
      name: "rule-a",
      tool: "*",
      check: () => Verdict.fail("Rule A denied"),
    };
    const ruleB: Precondition = {
      name: "rule-b",
      tool: "*",
      check: () => Verdict.fail("Rule B denied"),
    };
    const guard = makeGuard({ contracts: [ruleA, ruleB] });
    const result = await guard.evaluate("TestTool", {});

    expect(result.contractsEvaluated).toBe(2);
    expect(result.contracts[0]!.passed).toBe(false);
    expect(result.contracts[1]!.passed).toBe(false);
    expect(result.denyReasons.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// evaluate() — observe mode
// ---------------------------------------------------------------------------

describe("EvaluateObserveMode", () => {
  test("observe_mode_contract_failure_excluded_from_deny_reasons", async () => {
    // Per-contract observe mode: stays in enforce list but has mode: "observe".
    // _edictum_observe=false keeps it in getPreconditions(); mode="observe"
    // makes evaluate() mark it as observed and exclude from deny_reasons.
    const observePre = {
      _edictum_type: "precondition",
      _edictum_observe: false,
      name: "observe-rule",
      tool: "*",
      mode: "observe",
      check: () => Verdict.fail("would deny"),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = makeGuard({ contracts: [observePre as any] });
    const result = await guard.evaluate("TestTool", {});

    expect(result.verdict).toBe("allow");
    expect(result.denyReasons).toEqual([]);
    expect(result.contracts.length).toBe(1);
    expect(result.contracts[0]!.observed).toBe(true);
    expect(result.contracts[0]!.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluate() — contract exception
// ---------------------------------------------------------------------------

describe("EvaluateContractException", () => {
  test("contract_exception_sets_policy_error", async () => {
    const broken: Precondition = {
      name: "broken",
      tool: "*",
      check: () => {
        throw new Error("boom");
      },
    };
    const guard = makeGuard({ contracts: [broken] });
    const result = await guard.evaluate("TestTool", {});

    expect(result.policyError).toBe(true);
    expect(result.verdict).toBe("deny");
    expect(result.contracts[0]!.policyError).toBe(true);
    expect(result.contracts[0]!.passed).toBe(false);
    expect(result.contracts[0]!.message).toContain("boom");
  });
});

// ---------------------------------------------------------------------------
// evaluate() — ContractResult fields
// ---------------------------------------------------------------------------

describe("EvaluateContractResultFields", () => {
  test("contract_result_has_correct_fields", async () => {
    const tagged: Precondition = {
      name: "tagged-rule",
      tool: "*",
      check: () =>
        Verdict.fail("denied", { tags: ["safety", "security"] }),
    };
    const guard = makeGuard({ contracts: [tagged] });
    const result = await guard.evaluate("TestTool", {});

    const cr = result.contracts[0]!;
    expect(cr.contractId).toBe("tagged-rule");
    expect(cr.contractType).toBe("precondition");
    expect(cr.passed).toBe(false);
    expect(cr.message).toContain("denied");
    expect(cr.tags).toEqual(["safety", "security"]);
    // Default effect for precondition result in evaluate
    expect(cr.effect).toBe("warn");
    expect(typeof cr.policyError).toBe("boolean");
    expect(typeof cr.observed).toBe("boolean");
  });

  test("postcondition_effect_field_populated", async () => {
    const warnPost: Postcondition = {
      contractType: "post",
      name: "warn-post",
      tool: "*",
      check: () => Verdict.fail("warned"),
    };
    const guard = makeGuard({ contracts: [warnPost] });
    const result = await guard.evaluate("TestTool", {}, { output: "text" });

    const cr = result.contracts[0]!;
    expect(cr.effect).toBe("warn");
    expect(cr.contractType).toBe("postcondition");
  });
});

// ---------------------------------------------------------------------------
// evaluate() — frozen results
// ---------------------------------------------------------------------------

describe("EvaluateFrozenResults", () => {
  test("evaluation_result_is_frozen", async () => {
    const guard = makeGuard();
    const result = await guard.evaluate("TestTool", {});

    expect(Object.isFrozen(result)).toBe(true);
  });

  test("contracts_array_is_frozen", async () => {
    const pre: Precondition = {
      tool: "*",
      check: () => Verdict.fail("x"),
    };
    const guard = makeGuard({ contracts: [pre] });
    const result = await guard.evaluate("TestTool", {});

    expect(Object.isFrozen(result.contracts)).toBe(true);
  });

  test("deny_reasons_array_is_frozen", async () => {
    const guard = makeGuard();
    const result = await guard.evaluate("TestTool", {});

    expect(Object.isFrozen(result.denyReasons)).toBe(true);
    expect(Object.isFrozen(result.warnReasons)).toBe(true);
  });

  test("individual_contract_result_is_frozen", async () => {
    const pre: Precondition = {
      tool: "*",
      check: () => Verdict.fail("x"),
    };
    const guard = makeGuard({ contracts: [pre] });
    const result = await guard.evaluate("TestTool", {});

    expect(Object.isFrozen(result.contracts[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluate() — toolName in result
// ---------------------------------------------------------------------------

describe("EvaluateResultToolName", () => {
  test("result_contains_correct_toolName", async () => {
    const guard = makeGuard();
    const result = await guard.evaluate("SpecificTool", {});

    expect(result.toolName).toBe("SpecificTool");
  });
});

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
        // When output is a dict, evaluateBatch serializes it to JSON
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
    // JSON.stringify({ text: "contains secret data" }) includes "secret"
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
