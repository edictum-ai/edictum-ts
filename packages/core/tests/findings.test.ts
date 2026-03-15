/** Tests for postcondition findings interface. */

import { describe, expect, test } from "vitest";

import {
  buildFindings,
  classifyFinding,
  createFinding,
  createPostCallResult,
} from "../src/index.js";
import type { Finding, PostCallResult, PostDecisionLike } from "../src/index.js";

describe("TestFinding", () => {
  test("creation", () => {
    const f = createFinding({
      type: "pii_detected",
      contractId: "pii-in-output",
      field: "output.text",
      message: "SSN pattern found",
    });
    expect(f.type).toBe("pii_detected");
    expect(f.contractId).toBe("pii-in-output");
    expect(f.field).toBe("output.text");
    expect(f.message).toBe("SSN pattern found");
    expect(f.metadata).toEqual({});
  });

  test("frozen", () => {
    const f = createFinding({
      type: "pii",
      contractId: "x",
      field: "y",
      message: "z",
    });
    expect(() => {
      (f as any).type = "other";
    }).toThrow(TypeError);
  });

  test("with_metadata", () => {
    const f = createFinding({
      type: "pii_detected",
      contractId: "pii-check",
      field: "output.text",
      message: "SSN found",
      metadata: { pattern: "\\d{3}-\\d{2}-\\d{4}", match_count: 2 },
    });
    expect(f.metadata["match_count"]).toBe(2);
  });

  test("equality", () => {
    const f1 = createFinding({
      type: "pii",
      contractId: "c1",
      field: "output",
      message: "m",
    });
    const f2 = createFinding({
      type: "pii",
      contractId: "c1",
      field: "output",
      message: "m",
    });
    expect(f1).toEqual(f2);
  });
});

describe("TestPostCallResult", () => {
  test("default_passed", () => {
    const r = createPostCallResult({ result: "hello" });
    expect(r.postconditionsPassed).toBe(true);
    expect(r.findings).toEqual([]);
  });

  test("with_findings", () => {
    const findings: Finding[] = [
      createFinding({
        type: "pii_detected",
        contractId: "c1",
        field: "output",
        message: "SSN",
      }),
      createFinding({
        type: "secret_detected",
        contractId: "c2",
        field: "output",
        message: "API key",
      }),
    ];
    const r = createPostCallResult({
      result: "raw output",
      postconditionsPassed: false,
      findings,
    });
    expect(r.postconditionsPassed).toBe(false);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]!.type).toBe("pii_detected");
  });

  test("result_preserved", () => {
    const obj = { data: [1, 2, 3] };
    const r = createPostCallResult({ result: obj });
    expect(r.result).toBe(obj);
  });
});

describe("TestClassifyFinding", () => {
  test("pii", () => {
    expect(classifyFinding("pii-in-output", "SSN detected")).toBe(
      "pii_detected",
    );
    expect(classifyFinding("check-patient-data", "found patient ID")).toBe(
      "pii_detected",
    );
  });

  test("secret", () => {
    expect(classifyFinding("no-secrets", "API key in output")).toBe(
      "secret_detected",
    );
    expect(classifyFinding("credential-check", "")).toBe("secret_detected");
  });

  test("limit", () => {
    expect(classifyFinding("session-limit", "max calls exceeded")).toBe(
      "limit_exceeded",
    );
  });

  test("default", () => {
    expect(classifyFinding("some-rule", "something happened")).toBe(
      "policy_violation",
    );
  });

  test("case_insensitive", () => {
    expect(classifyFinding("PII-Check", "Found SSN")).toBe("pii_detected");
    expect(classifyFinding("SECRET-SCAN", "Token found")).toBe(
      "secret_detected",
    );
  });
});

describe("TestBuildFindings", () => {
  test("field_defaults_to_output", () => {
    const decision: PostDecisionLike = {
      contractsEvaluated: [
        { name: "pii-check", passed: false, message: "SSN found" },
      ],
    };
    const findings = buildFindings(decision);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.field).toBe("output");
  });

  test("field_extracted_from_metadata", () => {
    const decision: PostDecisionLike = {
      contractsEvaluated: [
        {
          name: "pii-check",
          passed: false,
          message: "SSN found",
          metadata: { field: "output.text" },
        },
      ],
    };
    const findings = buildFindings(decision);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.field).toBe("output.text");
  });

  test("skips_passed_contracts", () => {
    const decision: PostDecisionLike = {
      contractsEvaluated: [
        { name: "ok-check", passed: true, message: undefined },
      ],
    };
    const findings = buildFindings(decision);
    expect(findings).toEqual([]);
  });

  test("metadata_preserved_in_finding", () => {
    const decision: PostDecisionLike = {
      contractsEvaluated: [
        {
          name: "pii-check",
          passed: false,
          message: "SSN found",
          metadata: { field: "output.text", match_count: 3 },
        },
      ],
    };
    const findings = buildFindings(decision);
    expect(findings[0]!.metadata["match_count"]).toBe(3);
    expect(findings[0]!.metadata["field"]).toBe("output.text");
  });
});
