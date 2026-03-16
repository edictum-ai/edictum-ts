/** Tests for the YAML contract compiler — ports Python test_compiler.py. */

import { describe, expect, test } from "vitest";

import { createEnvelope, createPrincipal } from "../../src/envelope.js";
import type { ToolEnvelope } from "../../src/envelope.js";
import type { Verdict } from "../../src/contracts.js";
import {
  compileContracts,
  expandMessage,
  mergeSessionLimits,
  validateOperators,
} from "../../src/yaml-engine/index.js";
import { EdictumConfigError } from "../../src/errors.js";
import { DEFAULT_LIMITS } from "../../src/limits.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _envelope(
  toolName = "read_file",
  args: Record<string, unknown> = {},
  environment = "production",
  principal?: ReturnType<typeof createPrincipal> | null,
): ToolEnvelope {
  return createEnvelope(toolName, args, {
    environment,
    principal: principal ?? null,
  });
}

function _makeBundle(contracts: Record<string, unknown>[], mode = "enforce"): Record<string, unknown> {
  return {
    apiVersion: "edictum/v1",
    kind: "ContractBundle",
    metadata: { name: "test" },
    defaults: { mode },
    contracts,
  };
}

// ---------------------------------------------------------------------------
// Pre-contract compilation
// ---------------------------------------------------------------------------

describe("CompilePreConditions", () => {
  const bundle = _makeBundle([
    {
      id: "block-sensitive-reads",
      type: "pre",
      tool: "read_file",
      when: { "args.path": { contains_any: [".env", ".secret"] } },
      then: { effect: "deny", message: "Sensitive file '{args.path}' denied.", tags: ["secrets", "dlp"] },
    },
  ]);

  test("pre contracts compiled", () => {
    const compiled = compileContracts(bundle);
    expect(compiled.preconditions.length).toBe(1);
  });

  test("pre contract metadata", () => {
    const compiled = compileContracts(bundle);
    const fn = compiled.preconditions[0] as Record<string, unknown>;
    expect(fn._edictum_type).toBe("precondition");
    expect(fn._edictum_tool).toBe("read_file");
    expect(fn._edictum_id).toBe("block-sensitive-reads");
  });

  test("pre contract denies matching", () => {
    const compiled = compileContracts(bundle);
    const fn = compiled.preconditions[0] as Record<string, unknown>;
    const check = fn.check as (env: ToolEnvelope) => Verdict;
    const env = _envelope("read_file", { path: "/home/user/.env" });
    const verdict = check(env);
    expect(verdict.passed).toBe(false);
  });

  test("pre contract passes non-matching", () => {
    const compiled = compileContracts(bundle);
    const fn = compiled.preconditions[0] as Record<string, unknown>;
    const check = fn.check as (env: ToolEnvelope) => Verdict;
    const env = _envelope("read_file", { path: "/home/user/readme.md" });
    const verdict = check(env);
    expect(verdict.passed).toBe(true);
  });

  test("pre contract tags in metadata", () => {
    const compiled = compileContracts(bundle);
    const fn = compiled.preconditions[0] as Record<string, unknown>;
    const check = fn.check as (env: ToolEnvelope) => Verdict;
    const env = _envelope("read_file", { path: ".env" });
    const verdict = check(env);
    expect(verdict.metadata.tags).toEqual(["secrets", "dlp"]);
  });

  test("pre contract passes when field missing", () => {
    const compiled = compileContracts(bundle);
    const fn = compiled.preconditions[0] as Record<string, unknown>;
    const check = fn.check as (env: ToolEnvelope) => Verdict;
    const env = _envelope("read_file", {});
    const verdict = check(env);
    expect(verdict.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Post-contract compilation
// ---------------------------------------------------------------------------

describe("CompilePostConditions", () => {
  const bundle = _makeBundle([
    {
      id: "pii-in-output",
      type: "post",
      tool: "*",
      when: { "output.text": { matches: "\\d{3}-\\d{2}-\\d{4}" } },
      then: { effect: "warn", message: "PII detected.", tags: ["pii"] },
    },
  ]);

  test("post contracts compiled", () => {
    const compiled = compileContracts(bundle);
    expect(compiled.postconditions.length).toBe(1);
  });

  test("post contract metadata", () => {
    const compiled = compileContracts(bundle);
    const fn = compiled.postconditions[0] as Record<string, unknown>;
    expect(fn._edictum_type).toBe("postcondition");
    expect(fn._edictum_tool).toBe("*");
  });

  test("post contract warns on match", () => {
    const compiled = compileContracts(bundle);
    const fn = compiled.postconditions[0] as Record<string, unknown>;
    const check = fn.check as (env: ToolEnvelope, output: unknown) => Verdict;
    const verdict = check(_envelope(), "SSN: 123-45-6789");
    expect(verdict.passed).toBe(false);
    expect(verdict.metadata.tags).toEqual(["pii"]);
  });

  test("post contract passes no match", () => {
    const compiled = compileContracts(bundle);
    const fn = compiled.postconditions[0] as Record<string, unknown>;
    const check = fn.check as (env: ToolEnvelope, output: unknown) => Verdict;
    const verdict = check(_envelope(), "No PII here");
    expect(verdict.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session contracts
// ---------------------------------------------------------------------------

describe("CompileSessionContracts", () => {
  test("session contracts compiled", () => {
    const bundle = _makeBundle([
      {
        id: "session-limit",
        type: "session",
        limits: { max_tool_calls: 50, max_attempts: 120 },
        then: { effect: "deny", message: "Session limit exceeded." },
      },
    ]);
    const compiled = compileContracts(bundle);
    expect(compiled.sessionContracts.length).toBe(1);
  });

  test("session limits merged", () => {
    const bundle = _makeBundle([
      {
        id: "session-limit",
        type: "session",
        limits: { max_tool_calls: 50, max_attempts: 120 },
        then: { effect: "deny", message: "Session limit exceeded." },
      },
    ]);
    const compiled = compileContracts(bundle);
    expect(compiled.limits.maxToolCalls).toBe(50);
    expect(compiled.limits.maxAttempts).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Disabled contracts
// ---------------------------------------------------------------------------

describe("DisabledContracts", () => {
  test("disabled contract skipped", () => {
    const bundle = _makeBundle([
      {
        id: "disabled-rule",
        type: "pre",
        enabled: false,
        tool: "read_file",
        when: { "args.path": { contains: ".env" } },
        then: { effect: "deny", message: "denied" },
      },
    ]);
    const compiled = compileContracts(bundle);
    expect(compiled.preconditions.length).toBe(0);
  });

  test("enabled contract included", () => {
    const bundle = _makeBundle([
      {
        id: "enabled-rule",
        type: "pre",
        enabled: true,
        tool: "read_file",
        when: { "args.path": { contains: ".env" } },
        then: { effect: "deny", message: "denied" },
      },
    ]);
    const compiled = compileContracts(bundle);
    expect(compiled.preconditions.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Mode override
// ---------------------------------------------------------------------------

describe("ModeOverride", () => {
  test("default mode used", () => {
    const bundle = _makeBundle([
      {
        id: "rule",
        type: "pre",
        tool: "read_file",
        when: { "args.path": { contains: ".env" } },
        then: { effect: "deny", message: "denied" },
      },
    ]);
    const compiled = compileContracts(bundle);
    expect(compiled.defaultMode).toBe("enforce");
    const fn = compiled.preconditions[0] as Record<string, unknown>;
    expect(fn._edictum_mode).toBe("enforce");
  });

  test("per contract mode override", () => {
    const bundle = _makeBundle([
      {
        id: "observe-rule",
        type: "pre",
        mode: "observe",
        tool: "read_file",
        when: { "args.path": { contains: ".env" } },
        then: { effect: "deny", message: "denied" },
      },
    ]);
    const compiled = compileContracts(bundle);
    const fn = compiled.preconditions[0] as Record<string, unknown>;
    expect(fn._edictum_mode).toBe("observe");
  });
});

// ---------------------------------------------------------------------------
// Message templating
// ---------------------------------------------------------------------------

describe("MessageTemplating", () => {
  test("simple placeholder", () => {
    const env = _envelope("read_file", { path: "/etc/passwd" });
    expect(expandMessage("File '{args.path}' denied.", env)).toBe("File '/etc/passwd' denied.");
  });

  test("tool name placeholder", () => {
    const env = _envelope("bash");
    expect(expandMessage("Tool {tool.name} denied.", env)).toBe("Tool bash denied.");
  });

  test("missing placeholder kept", () => {
    const env = _envelope("read_file", {});
    expect(expandMessage("File '{args.path}' denied.", env)).toBe("File '{args.path}' denied.");
  });

  test("placeholder capped at 200", () => {
    const longPath = "x".repeat(300);
    const env = _envelope("read_file", { path: longPath });
    const msg = expandMessage("{args.path}", env);
    expect(msg.length).toBe(200);
    expect(msg.endsWith("...")).toBe(true);
  });

  test("multiple placeholders", () => {
    const env = _envelope("read_file", { path: "/tmp" });
    expect(expandMessage("{tool.name}: {args.path}", env)).toBe("read_file: /tmp");
  });

  test("environment placeholder", () => {
    const env = _envelope("read_file", {}, "staging");
    expect(expandMessage("Env: {environment}", env)).toBe("Env: staging");
  });

  test("principal placeholder", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ userId: "alice" }));
    expect(expandMessage("User: {principal.user_id}", env)).toBe("User: alice");
  });
});

// ---------------------------------------------------------------------------
// Then metadata
// ---------------------------------------------------------------------------

describe("ThenMetadata", () => {
  test("then metadata in verdict", () => {
    const bundle = _makeBundle([
      {
        id: "meta-rule",
        type: "pre",
        tool: "read_file",
        when: { "args.path": { contains: ".env" } },
        then: {
          effect: "deny",
          message: "denied",
          tags: ["secrets"],
          metadata: { severity: "high", category: "dlp" },
        },
      },
    ]);
    const compiled = compileContracts(bundle);
    const fn = compiled.preconditions[0] as Record<string, unknown>;
    const check = fn.check as (env: ToolEnvelope) => Verdict;
    const verdict = check(_envelope("read_file", { path: ".env" }));
    expect(verdict.passed).toBe(false);
    expect(verdict.metadata.tags).toEqual(["secrets"]);
    expect(verdict.metadata.severity).toBe("high");
    expect(verdict.metadata.category).toBe("dlp");
  });
});

// ---------------------------------------------------------------------------
// PolicyError in compiled contracts
// ---------------------------------------------------------------------------

describe("PolicyError", () => {
  test("type mismatch sets policyError", () => {
    const bundle = _makeBundle([
      {
        id: "type-mismatch",
        type: "pre",
        tool: "*",
        when: { "args.count": { gt: 5 } },
        then: { effect: "deny", message: "Count too high." },
      },
    ]);
    const compiled = compileContracts(bundle);
    const fn = compiled.preconditions[0] as Record<string, unknown>;
    const check = fn.check as (env: ToolEnvelope) => Verdict;
    const verdict = check(_envelope("read_file", { count: "not_a_number" }));
    expect(verdict.passed).toBe(false);
    expect(verdict.metadata.policyError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Postcondition effect metadata
// ---------------------------------------------------------------------------

describe("PostconditionEffectMetadata", () => {
  test("effect stamped on post function", () => {
    const bundle = _makeBundle([
      {
        id: "redact-secrets",
        type: "post",
        tool: "*",
        when: { "output.text": { matches_any: ["sk-[a-z0-9]+"] } },
        then: { effect: "redact", message: "Secrets found." },
      },
    ]);
    const compiled = compileContracts(bundle);
    const fn = compiled.postconditions[0] as Record<string, unknown>;
    expect(fn._edictum_effect).toBe("redact");
  });

  test("default effect is warn", () => {
    const bundle = _makeBundle([
      {
        id: "pii-check",
        type: "post",
        tool: "*",
        when: { "output.text": { matches: "\\d{3}-\\d{2}-\\d{4}" } },
        then: { message: "PII detected." },
      },
    ]);
    const compiled = compileContracts(bundle);
    const fn = compiled.postconditions[0] as Record<string, unknown>;
    expect(fn._edictum_effect).toBe("warn");
  });

  test("redact patterns extracted", () => {
    const bundle = _makeBundle([
      {
        id: "redact-keys",
        type: "post",
        tool: "*",
        when: { "output.text": { matches_any: ["sk-prod-[a-z0-9]{8}", "AKIA-PROD-[A-Z]{12}"] } },
        then: { effect: "redact", message: "Keys found." },
      },
    ]);
    const compiled = compileContracts(bundle);
    const fn = compiled.postconditions[0] as Record<string, unknown>;
    const patterns = fn._edictum_redact_patterns as RegExp[];
    expect(patterns.length).toBe(2);
    expect(patterns.every((p) => p instanceof RegExp)).toBe(true);
    expect(patterns[0]!.test("sk-prod-abcd1234")).toBe(true);
    expect(patterns[1]!.test("AKIA-PROD-ABCDEFGHIJKL")).toBe(true);
  });

  test("no patterns for contains operator", () => {
    const bundle = _makeBundle([
      {
        id: "contains-check",
        type: "post",
        tool: "*",
        when: { "output.text": { contains: "secret" } },
        then: { effect: "redact", message: "Secret found." },
      },
    ]);
    const compiled = compileContracts(bundle);
    const fn = compiled.postconditions[0] as Record<string, unknown>;
    expect(fn._edictum_redact_patterns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Session limits merging
// ---------------------------------------------------------------------------

describe("SessionLimitsMerging", () => {
  test("multiple session contracts merge restrictive", () => {
    const bundle = _makeBundle([
      {
        id: "limits-1",
        type: "session",
        limits: { max_tool_calls: 100, max_attempts: 200 },
        then: { effect: "deny", message: "limit 1" },
      },
      {
        id: "limits-2",
        type: "session",
        limits: { max_tool_calls: 50, max_calls_per_tool: { bash: 10 } },
        then: { effect: "deny", message: "limit 2" },
      },
    ]);
    const compiled = compileContracts(bundle);
    expect(compiled.limits.maxToolCalls).toBe(50);
    expect(compiled.limits.maxAttempts).toBe(200);
    expect(compiled.limits.maxCallsPerTool).toEqual({ bash: 10 });
  });

  test("mergeSessionLimits takes lower value", () => {
    const contract = { limits: { max_tool_calls: 30 } };
    const result = mergeSessionLimits(contract, { ...DEFAULT_LIMITS, maxToolCalls: 100 });
    expect(result.maxToolCalls).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Operator validation
// ---------------------------------------------------------------------------

describe("OperatorValidation", () => {
  test("unknown operator throws", () => {
    const bundle = _makeBundle([
      {
        id: "bad-op",
        type: "pre",
        tool: "*",
        when: { "args.x": { foobar: 42 } },
        then: { effect: "deny", message: "bad" },
      },
    ]);
    expect(() => compileContracts(bundle)).toThrow(EdictumConfigError);
  });

  test("custom operator accepted", () => {
    const bundle = _makeBundle([
      {
        id: "custom-op",
        type: "pre",
        tool: "*",
        when: { "args.x": { is_even: true } },
        then: { effect: "deny", message: "even" },
      },
    ]);
    // Should not throw when custom operator is provided
    expect(() =>
      compileContracts(bundle, {
        customOperators: { is_even: (v) => (v as number) % 2 === 0 },
      }),
    ).not.toThrow();
  });
});
