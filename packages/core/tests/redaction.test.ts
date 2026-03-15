/**
 * Tests for RedactionPolicy — ported from Python test_audit.py::TestRedactionPolicy.
 *
 * Covers: key redaction, nested dicts, lists, key normalization, partial key match,
 * secret value detection (5 patterns), false positives, long string truncation,
 * detect_values toggle, bash command redaction, result redaction, payload capping,
 * custom sensitive keys.
 */

import { describe, test, expect } from "vitest";

import { RedactionPolicy } from "../src/index.js";

describe("TestRedactionPolicy", () => {
  test("redactSensitiveKeys", () => {
    const policy = new RedactionPolicy();
    const args = { username: "alice", password: "secret123", data: "safe" };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["username"]).toBe("alice");
    expect(result["password"]).toBe("[REDACTED]");
    expect(result["data"]).toBe("safe");
  });

  test("redactNestedDicts", () => {
    const policy = new RedactionPolicy();
    const args = { config: { api_key: "sk-abc123", url: "https://example.com" } };
    const result = policy.redactArgs(args) as Record<string, Record<string, unknown>>;
    expect(result["config"]["api_key"]).toBe("[REDACTED]");
    expect(result["config"]["url"]).toBe("https://example.com");
  });

  test("redactLists", () => {
    const policy = new RedactionPolicy();
    const args = { items: [{ token: "abc" }, { name: "safe" }] };
    const result = policy.redactArgs(args) as Record<string, Record<string, unknown>[]>;
    expect(result["items"][0]["token"]).toBe("[REDACTED]");
    expect(result["items"][1]["name"]).toBe("safe");
  });

  test("keyNormalization", () => {
    const policy = new RedactionPolicy();
    const args = { PASSWORD: "secret", Api_Key: "key123" };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["PASSWORD"]).toBe("[REDACTED]");
    expect(result["Api_Key"]).toBe("[REDACTED]");
  });

  test("partialKeyMatch", () => {
    const policy = new RedactionPolicy();
    const args = { auth_token: "abc", my_secret_key: "xyz", name: "safe" };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["auth_token"]).toBe("[REDACTED]");
    expect(result["my_secret_key"]).toBe("[REDACTED]");
    expect(result["name"]).toBe("safe");
  });

  test("secretValueDetection — OpenAI", () => {
    const policy = new RedactionPolicy();
    const args = { value: "sk-abcdefghijklmnopqrstuvwxyz" };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["value"]).toBe("[REDACTED]");
  });

  test("secretValueDetection — AWS", () => {
    const policy = new RedactionPolicy();
    const args = { value: "AKIAIOSFODNN7EXAMPLE" };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["value"]).toBe("[REDACTED]");
  });

  test("secretValueDetection — JWT", () => {
    const policy = new RedactionPolicy();
    const args = { value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload" };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["value"]).toBe("[REDACTED]");
  });

  test("secretValueDetection — GitHub", () => {
    const policy = new RedactionPolicy();
    const args = { value: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["value"]).toBe("[REDACTED]");
  });

  test("secretValueDetection — Slack", () => {
    const policy = new RedactionPolicy();
    const args = { value: "xoxb-123456789-abcdefghij" };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["value"]).toBe("[REDACTED]");
  });

  test("noFalsePositiveOnNormalValues", () => {
    const policy = new RedactionPolicy();
    const args = { value: "hello world", count: 42 };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["value"]).toBe("hello world");
    expect(result["count"]).toBe(42);
  });

  test("longStringTruncation", () => {
    const policy = new RedactionPolicy();
    const longStr = "x".repeat(1500);
    const args = { data: longStr };
    const result = policy.redactArgs(args) as Record<string, string>;
    expect(result["data"].length).toBe(1000);
    expect(result["data"].endsWith("...")).toBe(true);
  });

  test("detectValuesDisabled", () => {
    const policy = new RedactionPolicy(null, null, false);
    const args = { value: "sk-abcdefghijklmnopqrstuvwxyz" };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["value"]).toBe("sk-abcdefghijklmnopqrstuvwxyz");
  });

  test("redactBashCommand", () => {
    const policy = new RedactionPolicy();
    const cmd = "export MY_SECRET_KEY=abc123";
    const result = policy.redactBashCommand(cmd);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abc123");
  });

  test("redactBashPasswordFlag", () => {
    const policy = new RedactionPolicy();
    const cmd = "mysql -p mypassword -u root";
    const result = policy.redactBashCommand(cmd);
    expect(result).toContain("[REDACTED]");
  });

  test("redactUrlCredentials", () => {
    const policy = new RedactionPolicy();
    const cmd = "curl https://user:password123@example.com/api";
    const result = policy.redactBashCommand(cmd);
    expect(result).not.toContain("password123");
  });

  test("redactResult", () => {
    const policy = new RedactionPolicy();
    const result = policy.redactResult("short result");
    expect(result).toBe("short result");
  });

  test("redactResultTruncation", () => {
    const policy = new RedactionPolicy();
    const longResult = "x".repeat(600);
    const result = policy.redactResult(longResult);
    expect(result.length).toBe(500);
    expect(result.endsWith("...")).toBe(true);
  });

  test("capPayloadUnderLimit", () => {
    const policy = new RedactionPolicy();
    const data: Record<string, unknown> = { toolArgs: { key: "value" }, toolName: "test" };
    const result = policy.capPayload(data);
    expect("_truncated" in result).toBe(false);
  });

  test("capPayloadOverLimit", () => {
    const policy = new RedactionPolicy();
    const data: Record<string, unknown> = {
      toolArgs: { key: "x".repeat(40000) },
      resultSummary: "big",
    };
    const result = policy.capPayload(data);
    expect(result["_truncated"]).toBe(true);
    expect(result["toolArgs"]).toEqual({ _redacted: "payload exceeded 32KB" });
    expect("resultSummary" in result).toBe(false);
  });

  test("customSensitiveKeys", () => {
    const policy = new RedactionPolicy(new Set(["my_custom_field"]));
    const args = { my_custom_field: "secret", other: "safe" };
    const result = policy.redactArgs(args) as Record<string, unknown>;
    expect(result["my_custom_field"]).toBe("[REDACTED]");
    expect(result["other"]).toBe("safe");
  });
});
