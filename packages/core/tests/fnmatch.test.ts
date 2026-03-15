/** Tests for fnmatch utility — glob pattern matching. */

import { describe, expect, test } from "vitest";

import { fnmatch } from "../src/fnmatch.js";

describe("fnmatch", () => {
  test("wildcard_star_matches_everything", () => {
    expect(fnmatch("anything", "*")).toBe(true);
    expect(fnmatch("", "*")).toBe(true);
    expect(fnmatch("Bash", "*")).toBe(true);
    expect(fnmatch("mcp_github_create_issue", "*")).toBe(true);
  });

  test("question_mark_matches_single_char", () => {
    expect(fnmatch("a", "?")).toBe(true);
    expect(fnmatch("ab", "?")).toBe(false);
    expect(fnmatch("ab", "??")).toBe(true);
    expect(fnmatch("abc", "a?c")).toBe(true);
    expect(fnmatch("aXc", "a?c")).toBe(true);
    expect(fnmatch("ac", "a?c")).toBe(false);
  });

  test("exact_match", () => {
    expect(fnmatch("Bash", "Bash")).toBe(true);
    expect(fnmatch("Read", "Read")).toBe(true);
    expect(fnmatch("Bash", "Read")).toBe(false);
    expect(fnmatch("bash", "Bash")).toBe(false);
  });

  test("glob_patterns_like_mcp_star", () => {
    expect(fnmatch("mcp_github_create_issue", "mcp_*")).toBe(true);
    expect(fnmatch("mcp_slack_send", "mcp_*")).toBe(true);
    expect(fnmatch("mcp_", "mcp_*")).toBe(true);
    expect(fnmatch("Bash", "mcp_*")).toBe(false);
    expect(fnmatch("other_tool", "mcp_*")).toBe(false);
  });

  test("no_match", () => {
    expect(fnmatch("Bash", "Read")).toBe(false);
    expect(fnmatch("foo", "bar")).toBe(false);
    expect(fnmatch("abc", "ab")).toBe(false);
    expect(fnmatch("ab", "abc")).toBe(false);
  });

  test("star_in_middle", () => {
    expect(fnmatch("mcp_github_tool", "mcp_*_tool")).toBe(true);
    expect(fnmatch("mcp__tool", "mcp_*_tool")).toBe(true);
    expect(fnmatch("mcp_tool", "mcp_*_tool")).toBe(false);
  });

  test("multiple_stars", () => {
    expect(fnmatch("a_b_c", "*_*_*")).toBe(true);
    expect(fnmatch("a_b", "*_*_*")).toBe(false);
  });
});
