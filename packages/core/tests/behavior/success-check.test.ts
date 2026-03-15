/** Tests for defaultSuccessCheck — tool success heuristic. */

import { describe, expect, test } from "vitest";

import { defaultSuccessCheck } from "../../src/runner.js";

// ---------------------------------------------------------------------------
// Null / undefined — always success
// ---------------------------------------------------------------------------

describe("DefaultSuccessCheckNullish", () => {
  test("null_returns_true", () => {
    expect(defaultSuccessCheck("TestTool", null)).toBe(true);
  });

  test("undefined_returns_true", () => {
    expect(defaultSuccessCheck("TestTool", undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

describe("DefaultSuccessCheckStrings", () => {
  test("normal_string_returns_true", () => {
    expect(defaultSuccessCheck("TestTool", "all good")).toBe(true);
  });

  test("empty_string_returns_true", () => {
    expect(defaultSuccessCheck("TestTool", "")).toBe(true);
  });

  test("error_colon_prefix_returns_false", () => {
    expect(defaultSuccessCheck("TestTool", "error: something broke")).toBe(
      false,
    );
  });

  test("Error_colon_prefix_case_insensitive_returns_false", () => {
    expect(defaultSuccessCheck("TestTool", "Error: uppercase")).toBe(false);
  });

  test("ERROR_colon_all_caps_returns_false", () => {
    expect(defaultSuccessCheck("TestTool", "ERROR: all caps")).toBe(false);
  });

  test("fatal_colon_prefix_returns_false", () => {
    expect(defaultSuccessCheck("TestTool", "fatal: crash")).toBe(false);
  });

  test("Fatal_colon_prefix_case_insensitive_returns_false", () => {
    expect(defaultSuccessCheck("TestTool", "Fatal: uppercase")).toBe(false);
  });

  test("FATAL_colon_all_caps_returns_false", () => {
    expect(defaultSuccessCheck("TestTool", "FATAL: all caps")).toBe(false);
  });

  test("string_containing_error_not_at_start_returns_true", () => {
    expect(
      defaultSuccessCheck("TestTool", "no error here"),
    ).toBe(true);
  });

  test("string_containing_fatal_not_at_start_returns_true", () => {
    expect(
      defaultSuccessCheck("TestTool", "not fatal here"),
    ).toBe(true);
  });

  test("error_without_colon_returns_true", () => {
    expect(defaultSuccessCheck("TestTool", "error message")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Objects with is_error
// ---------------------------------------------------------------------------

describe("DefaultSuccessCheckObjects", () => {
  test("dict_with_is_error_true_returns_false", () => {
    expect(
      defaultSuccessCheck("TestTool", { is_error: true, message: "fail" }),
    ).toBe(false);
  });

  test("dict_with_is_error_false_returns_true", () => {
    expect(
      defaultSuccessCheck("TestTool", { is_error: false, data: "ok" }),
    ).toBe(true);
  });

  test("dict_without_is_error_returns_true", () => {
    expect(
      defaultSuccessCheck("TestTool", { status: 200, data: "ok" }),
    ).toBe(true);
  });

  test("dict_with_is_error_truthy_string_returns_false", () => {
    // is_error is truthy (non-empty string)
    expect(
      defaultSuccessCheck("TestTool", { is_error: "yes" }),
    ).toBe(false);
  });

  test("dict_with_is_error_zero_returns_true", () => {
    // is_error: 0 is falsy
    expect(
      defaultSuccessCheck("TestTool", { is_error: 0 }),
    ).toBe(true);
  });

  test("dict_with_is_error_null_returns_true", () => {
    // is_error: null is falsy
    expect(
      defaultSuccessCheck("TestTool", { is_error: null }),
    ).toBe(true);
  });

  test("dict_with_is_error_undefined_returns_true", () => {
    // is_error: undefined is falsy
    expect(
      defaultSuccessCheck("TestTool", { is_error: undefined }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Other types — always success
// ---------------------------------------------------------------------------

describe("DefaultSuccessCheckOtherTypes", () => {
  test("number_returns_true", () => {
    expect(defaultSuccessCheck("TestTool", 42)).toBe(true);
  });

  test("zero_returns_true", () => {
    expect(defaultSuccessCheck("TestTool", 0)).toBe(true);
  });

  test("boolean_true_returns_true", () => {
    expect(defaultSuccessCheck("TestTool", true)).toBe(true);
  });

  test("boolean_false_returns_true", () => {
    expect(defaultSuccessCheck("TestTool", false)).toBe(true);
  });

  test("array_returns_true", () => {
    // Arrays are excluded from the object check (Array.isArray guard)
    expect(defaultSuccessCheck("TestTool", [1, 2, 3])).toBe(true);
  });

  test("array_with_is_error_returns_true", () => {
    // Arrays skip the is_error check even if somehow present
    const arr = [1, 2] as unknown as Record<string, unknown>;
    (arr as Record<string, unknown>)["is_error"] = true;
    expect(defaultSuccessCheck("TestTool", arr)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("DefaultSuccessCheckEdgeCases", () => {
  test("string_exactly_error_colon_returns_false", () => {
    expect(defaultSuccessCheck("TestTool", "error:")).toBe(false);
  });

  test("string_exactly_fatal_colon_returns_false", () => {
    expect(defaultSuccessCheck("TestTool", "fatal:")).toBe(false);
  });

  test("eRrOr_mixed_case_returns_false", () => {
    expect(defaultSuccessCheck("TestTool", "eRrOr: mixed")).toBe(false);
  });

  test("fAtAl_mixed_case_returns_false", () => {
    expect(defaultSuccessCheck("TestTool", "fAtAl: mixed")).toBe(false);
  });

  test("nested_dict_with_is_error_in_child_returns_true", () => {
    // Only top-level is_error matters
    expect(
      defaultSuccessCheck("TestTool", {
        nested: { is_error: true },
      }),
    ).toBe(true);
  });
});
