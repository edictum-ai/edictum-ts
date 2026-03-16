/** Tests for the YAML condition evaluator — ports Python test_evaluator.py. */

import { afterEach, describe, expect, test } from "vitest";

import { createEnvelope, createPrincipal } from "../../src/envelope.js";
import type { ToolEnvelope } from "../../src/envelope.js";
import {
  evaluateExpression,
  PolicyError,
  MAX_REGEX_INPUT,
} from "../../src/yaml-engine/evaluator.js";

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

// ---------------------------------------------------------------------------
// Selector Resolution
// ---------------------------------------------------------------------------

describe("SelectorResolution", () => {
  test("environment", () => {
    const env = _envelope("read_file", {}, "staging");
    expect(evaluateExpression({ environment: { equals: "staging" } }, env)).toBe(true);
  });

  test("tool.name", () => {
    const env = _envelope("read_file");
    expect(evaluateExpression({ "tool.name": { equals: "read_file" } }, env)).toBe(true);
  });

  test("args simple", () => {
    const env = _envelope("read_file", { path: "/etc/passwd" });
    expect(evaluateExpression({ "args.path": { equals: "/etc/passwd" } }, env)).toBe(true);
  });

  test("args nested", () => {
    const env = _envelope("read_file", { config: { timeout: 30 } });
    expect(evaluateExpression({ "args.config.timeout": { equals: 30 } }, env)).toBe(true);
  });

  test("args deeply nested", () => {
    const env = _envelope("read_file", { a: { b: { c: "deep" } } });
    expect(evaluateExpression({ "args.a.b.c": { equals: "deep" } }, env)).toBe(true);
  });

  test("principal user_id", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ userId: "alice" }));
    expect(evaluateExpression({ "principal.user_id": { equals: "alice" } }, env)).toBe(true);
  });

  test("principal role", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ role: "admin" }));
    expect(evaluateExpression({ "principal.role": { equals: "admin" } }, env)).toBe(true);
  });

  test("principal ticket_ref", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ ticketRef: "JIRA-123" }));
    expect(evaluateExpression({ "principal.ticket_ref": { equals: "JIRA-123" } }, env)).toBe(true);
  });

  test("principal claims", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ claims: { department: "platform" } }));
    expect(evaluateExpression({ "principal.claims.department": { equals: "platform" } }, env)).toBe(true);
  });

  test("output.text present", () => {
    const env = _envelope();
    expect(evaluateExpression({ "output.text": { contains: "secret" } }, env, "this has a secret in it")).toBe(true);
  });

  test("output.text missing", () => {
    const env = _envelope();
    expect(evaluateExpression({ "output.text": { contains: "secret" } }, env)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing Field Semantics
// ---------------------------------------------------------------------------

describe("MissingFields", () => {
  test("missing arg returns false", () => {
    const env = _envelope("read_file", {});
    expect(evaluateExpression({ "args.nonexistent": { equals: "x" } }, env)).toBe(false);
  });

  test("missing nested arg returns false", () => {
    const env = _envelope("read_file", { config: {} });
    expect(evaluateExpression({ "args.config.timeout": { equals: 30 } }, env)).toBe(false);
  });

  test("missing intermediate key returns false", () => {
    const env = _envelope("read_file", {});
    expect(evaluateExpression({ "args.config.timeout": { equals: 30 } }, env)).toBe(false);
  });

  test("no principal returns false", () => {
    const env = _envelope("read_file", {}, "production", null);
    expect(evaluateExpression({ "principal.role": { equals: "admin" } }, env)).toBe(false);
  });

  test("null principal field returns false", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ role: null }));
    expect(evaluateExpression({ "principal.role": { equals: "admin" } }, env)).toBe(false);
  });

  test("unknown selector returns false", () => {
    const env = _envelope();
    expect(evaluateExpression({ "unknown.selector": { equals: "x" } }, env)).toBe(false);
  });

  test("unknown principal field returns false", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal());
    expect(evaluateExpression({ "principal.unknown": { equals: "x" } }, env)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Exists Operator
// ---------------------------------------------------------------------------

describe("ExistsOperator", () => {
  test("exists true when present", () => {
    const env = _envelope("read_file", { path: "/tmp/file" });
    expect(evaluateExpression({ "args.path": { exists: true } }, env)).toBe(true);
  });

  test("exists true when missing", () => {
    const env = _envelope("read_file", {});
    expect(evaluateExpression({ "args.path": { exists: true } }, env)).toBe(false);
  });

  test("exists false when missing", () => {
    const env = _envelope("read_file", {});
    expect(evaluateExpression({ "args.path": { exists: false } }, env)).toBe(true);
  });

  test("exists false when present", () => {
    const env = _envelope("read_file", { path: "/tmp/file" });
    expect(evaluateExpression({ "args.path": { exists: false } }, env)).toBe(false);
  });

  test("exists true when null", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ role: null }));
    expect(evaluateExpression({ "principal.role": { exists: true } }, env)).toBe(false);
  });

  test("exists false when null", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ role: null }));
    expect(evaluateExpression({ "principal.role": { exists: false } }, env)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Equality Operators
// ---------------------------------------------------------------------------

describe("EqualityOperators", () => {
  test("equals string", () => {
    const env = _envelope("read_file", { path: ".env" });
    expect(evaluateExpression({ "args.path": { equals: ".env" } }, env)).toBe(true);
    expect(evaluateExpression({ "args.path": { equals: ".secret" } }, env)).toBe(false);
  });

  test("equals number", () => {
    const env = _envelope("read_file", { count: 42 });
    expect(evaluateExpression({ "args.count": { equals: 42 } }, env)).toBe(true);
    expect(evaluateExpression({ "args.count": { equals: 43 } }, env)).toBe(false);
  });

  test("equals boolean", () => {
    const env = _envelope("read_file", { dry_run: true });
    expect(evaluateExpression({ "args.dry_run": { equals: true } }, env)).toBe(true);
  });

  test("not_equals", () => {
    const env = _envelope("read_file", {}, "staging");
    expect(evaluateExpression({ environment: { not_equals: "production" } }, env)).toBe(true);
    expect(evaluateExpression({ environment: { not_equals: "staging" } }, env)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Membership Operators
// ---------------------------------------------------------------------------

describe("MembershipOperators", () => {
  test("in operator", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ role: "sre" }));
    expect(evaluateExpression({ "principal.role": { in: ["sre", "admin"] } }, env)).toBe(true);
  });

  test("in operator not in list", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ role: "junior" }));
    expect(evaluateExpression({ "principal.role": { in: ["sre", "admin"] } }, env)).toBe(false);
  });

  test("not_in operator", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ role: "junior" }));
    expect(evaluateExpression({ "principal.role": { not_in: ["sre", "admin"] } }, env)).toBe(true);
  });

  test("not_in operator is in list", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ role: "admin" }));
    expect(evaluateExpression({ "principal.role": { not_in: ["sre", "admin"] } }, env)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// String Operators
// ---------------------------------------------------------------------------

describe("StringOperators", () => {
  test("contains", () => {
    const env = _envelope("read_file", { path: "/home/user/.env.local" });
    expect(evaluateExpression({ "args.path": { contains: ".env" } }, env)).toBe(true);
    expect(evaluateExpression({ "args.path": { contains: ".secret" } }, env)).toBe(false);
  });

  test("contains_any", () => {
    const env = _envelope("read_file", { path: "/home/.env" });
    expect(evaluateExpression({ "args.path": { contains_any: [".env", ".secret"] } }, env)).toBe(true);
  });

  test("contains_any none match", () => {
    const env = _envelope("read_file", { path: "/home/readme.md" });
    expect(evaluateExpression({ "args.path": { contains_any: [".env", ".secret"] } }, env)).toBe(false);
  });

  test("starts_with", () => {
    const env = _envelope("read_file", { path: "/etc/config" });
    expect(evaluateExpression({ "args.path": { starts_with: "/etc" } }, env)).toBe(true);
    expect(evaluateExpression({ "args.path": { starts_with: "/home" } }, env)).toBe(false);
  });

  test("ends_with", () => {
    const env = _envelope("read_file", { path: "deploy.yaml" });
    expect(evaluateExpression({ "args.path": { ends_with: ".yaml" } }, env)).toBe(true);
    expect(evaluateExpression({ "args.path": { ends_with: ".json" } }, env)).toBe(false);
  });

  test("matches", () => {
    const env = _envelope("read_file", { command: "rm -rf /tmp" });
    expect(evaluateExpression({ "args.command": { matches: "\\brm\\s+(-rf?|--recursive)\\b" } }, env)).toBe(true);
  });

  test("matches no match", () => {
    const env = _envelope("read_file", { command: "ls -la" });
    expect(evaluateExpression({ "args.command": { matches: "\\brm\\s+(-rf?|--recursive)\\b" } }, env)).toBe(false);
  });

  test("matches_any", () => {
    const env = _envelope("read_file", { command: "mkfs /dev/sda" });
    expect(evaluateExpression({ "args.command": { matches_any: ["\\brm\\b", "\\bmkfs\\b"] } }, env)).toBe(true);
  });

  test("matches_any none match", () => {
    const env = _envelope("read_file", { command: "echo hello" });
    expect(evaluateExpression({ "args.command": { matches_any: ["\\brm\\b", "\\bmkfs\\b"] } }, env)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Numeric Operators
// ---------------------------------------------------------------------------

describe("NumericOperators", () => {
  test("gt", () => {
    const env = _envelope("read_file", { count: 10 });
    expect(evaluateExpression({ "args.count": { gt: 5 } }, env)).toBe(true);
    expect(evaluateExpression({ "args.count": { gt: 10 } }, env)).toBe(false);
    expect(evaluateExpression({ "args.count": { gt: 15 } }, env)).toBe(false);
  });

  test("gte", () => {
    const env = _envelope("read_file", { count: 10 });
    expect(evaluateExpression({ "args.count": { gte: 10 } }, env)).toBe(true);
    expect(evaluateExpression({ "args.count": { gte: 11 } }, env)).toBe(false);
  });

  test("lt", () => {
    const env = _envelope("read_file", { count: 10 });
    expect(evaluateExpression({ "args.count": { lt: 15 } }, env)).toBe(true);
    expect(evaluateExpression({ "args.count": { lt: 10 } }, env)).toBe(false);
  });

  test("lte", () => {
    const env = _envelope("read_file", { count: 10 });
    expect(evaluateExpression({ "args.count": { lte: 10 } }, env)).toBe(true);
    expect(evaluateExpression({ "args.count": { lte: 9 } }, env)).toBe(false);
  });

  test("float comparison", () => {
    const env = _envelope("read_file", { score: 3.14 });
    expect(evaluateExpression({ "args.score": { gt: 3.0 } }, env)).toBe(true);
    expect(evaluateExpression({ "args.score": { lt: 4.0 } }, env)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type Mismatch → PolicyError
// ---------------------------------------------------------------------------

describe("TypeMismatch", () => {
  test("contains on number", () => {
    const env = _envelope("read_file", { count: 42 });
    const result = evaluateExpression({ "args.count": { contains: "4" } }, env);
    expect(result).toBeInstanceOf(PolicyError);
    expect((result as PolicyError).message).toContain("Type mismatch");
  });

  test("gt on string", () => {
    const env = _envelope("read_file", { name: "alice" });
    expect(evaluateExpression({ "args.name": { gt: 5 } }, env)).toBeInstanceOf(PolicyError);
  });

  test("starts_with on number", () => {
    const env = _envelope("read_file", { count: 42 });
    expect(evaluateExpression({ "args.count": { starts_with: "4" } }, env)).toBeInstanceOf(PolicyError);
  });

  test("matches on number", () => {
    const env = _envelope("read_file", { count: 42 });
    expect(evaluateExpression({ "args.count": { matches: "\\d+" } }, env)).toBeInstanceOf(PolicyError);
  });
});

// ---------------------------------------------------------------------------
// Boolean Composition
// ---------------------------------------------------------------------------

describe("BooleanComposition", () => {
  test("all true", () => {
    const env = _envelope("deploy", {}, "production");
    const expr = { all: [{ "tool.name": { equals: "deploy" } }, { environment: { equals: "production" } }] };
    expect(evaluateExpression(expr, env)).toBe(true);
  });

  test("all one false", () => {
    const env = _envelope("deploy", {}, "staging");
    const expr = { all: [{ "tool.name": { equals: "deploy" } }, { environment: { equals: "production" } }] };
    expect(evaluateExpression(expr, env)).toBe(false);
  });

  test("any one true", () => {
    const env = _envelope("read_file", { command: "rm -rf /" });
    const expr = { any: [{ "args.command": { matches: "\\brm\\b" } }, { "args.command": { matches: "\\bmkfs\\b" } }] };
    expect(evaluateExpression(expr, env)).toBe(true);
  });

  test("any none true", () => {
    const env = _envelope("read_file", { command: "echo hello" });
    const expr = { any: [{ "args.command": { matches: "\\brm\\b" } }, { "args.command": { matches: "\\bmkfs\\b" } }] };
    expect(evaluateExpression(expr, env)).toBe(false);
  });

  test("not true", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ role: "junior" }));
    expect(evaluateExpression({ not: { "principal.role": { in: ["admin", "sre"] } } }, env)).toBe(true);
  });

  test("not false", () => {
    const env = _envelope("read_file", {}, "production", createPrincipal({ role: "admin" }));
    expect(evaluateExpression({ not: { "principal.role": { in: ["admin", "sre"] } } }, env)).toBe(false);
  });

  test("nested boolean all + not", () => {
    const env = _envelope("deploy", {}, "production", createPrincipal({ role: "junior" }));
    const expr = {
      all: [
        { environment: { equals: "production" } },
        { not: { "principal.role": { in: ["senior_engineer", "sre", "admin"] } } },
      ],
    };
    expect(evaluateExpression(expr, env)).toBe(true);
  });

  test("policy error propagates through all", () => {
    const env = _envelope("read_file", { count: "not_a_number" });
    expect(evaluateExpression({ all: [{ "args.count": { gt: 5 } }] }, env)).toBeInstanceOf(PolicyError);
  });

  test("policy error propagates through any", () => {
    const env = _envelope("read_file", { count: "not_a_number" });
    expect(evaluateExpression({ any: [{ "args.count": { gt: 5 } }] }, env)).toBeInstanceOf(PolicyError);
  });

  test("policy error propagates through not", () => {
    const env = _envelope("read_file", { count: "not_a_number" });
    expect(evaluateExpression({ not: { "args.count": { gt: 5 } } }, env)).toBeInstanceOf(PolicyError);
  });
});

// ---------------------------------------------------------------------------
// env.* Selector
// ---------------------------------------------------------------------------

describe("EnvSelector", () => {
  const saved: Record<string, string | undefined> = {};
  function setEnv(key: string, value: string): void { saved[key] = process.env[key]; process.env[key] = value; }
  function delEnv(key: string): void { saved[key] = process.env[key]; delete process.env[key]; }
  afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  test("env equals matches", () => {
    setEnv("APP_ENV", "production");
    expect(evaluateExpression({ "env.APP_ENV": { equals: "production" } }, _envelope())).toBe(true);
  });

  test("env unset evaluates false", () => {
    delEnv("NONEXISTENT_VAR_TEST");
    expect(evaluateExpression({ "env.NONEXISTENT_VAR_TEST": { equals: "anything" } }, _envelope())).toBe(false);
  });

  test("env coerces booleans and numbers", () => {
    setEnv("FLAG_TEST", "true");
    expect(evaluateExpression({ "env.FLAG_TEST": { equals: true } }, _envelope())).toBe(true);
    setEnv("FLAG_TEST", "false");
    expect(evaluateExpression({ "env.FLAG_TEST": { equals: false } }, _envelope())).toBe(true);
    setEnv("MAX_RETRIES_TEST", "42");
    expect(evaluateExpression({ "env.MAX_RETRIES_TEST": { equals: 42 } }, _envelope())).toBe(true);
    setEnv("THRESHOLD_TEST", "3.14");
    expect(evaluateExpression({ "env.THRESHOLD_TEST": { equals: 3.14 } }, _envelope())).toBe(true);
  });

  test("env gt with coerced int", () => {
    setEnv("MAX_RETRIES_TEST", "10");
    expect(evaluateExpression({ "env.MAX_RETRIES_TEST": { gt: 5 } }, _envelope())).toBe(true);
    expect(evaluateExpression({ "env.MAX_RETRIES_TEST": { gt: 10 } }, _envelope())).toBe(false);
  });

  test("env exists", () => {
    setEnv("MY_VAR_TEST", "anything");
    expect(evaluateExpression({ "env.MY_VAR_TEST": { exists: true } }, _envelope())).toBe(true);
    delEnv("MY_VAR_TEST");
    expect(evaluateExpression({ "env.MY_VAR_TEST": { exists: true } }, _envelope())).toBe(false);
  });
});

describe("RegexInputCap", () => {
  test("regex input is capped at MAX_REGEX_INPUT", () => {
    const longInput = "a".repeat(MAX_REGEX_INPUT + 1000);
    const env = _envelope("read_file", { data: longInput });
    const result = evaluateExpression({ "args.data": { matches: "a{10001}" } }, env);
    expect(typeof result === "boolean" || result instanceof PolicyError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Custom Operators
// ---------------------------------------------------------------------------

describe("CustomOperators", () => {
  test("custom operator is invoked", () => {
    const env = _envelope("read_file", { count: 10 });
    const customOps = { is_even: (val: unknown) => (val as number) % 2 === 0 };
    const result = evaluateExpression(
      { "args.count": { is_even: true } },
      env,
      null,
      { customOperators: customOps },
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Custom Selectors
// ---------------------------------------------------------------------------

describe("CustomSelectors", () => {
  test("custom selector is resolved", () => {
    const env = _envelope("read_file");
    const customSels = {
      custom: () => ({ level: "high" }),
    };
    const result = evaluateExpression(
      { "custom.level": { equals: "high" } },
      env,
      null,
      { customSelectors: customSels },
    );
    expect(result).toBe(true);
  });
});
