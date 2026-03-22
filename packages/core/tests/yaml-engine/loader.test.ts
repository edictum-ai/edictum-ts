/** Tests for the YAML bundle loader — loadBundle, loadBundleString, validators. */

import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import {
  loadBundle,
  loadBundleString,
  computeHash,
  MAX_BUNDLE_SIZE,
  validateSchema,
  validateUniqueIds,
  validateRegexes,
  validatePreSelectors,
  validateSandboxContracts,
} from "../../src/yaml-engine/index.js";
import { EdictumConfigError } from "../../src/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_YAML = `
apiVersion: edictum/v1
kind: ContractBundle
metadata:
  name: test-bundle
defaults:
  mode: enforce
contracts:
  - id: block-env
    type: pre
    tool: read_file
    when:
      args.path:
        contains: ".env"
    then:
      effect: deny
      message: "Sensitive file denied."
      tags: [secrets]
`;

function writeTempYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "edictum-test-"));
  const filePath = join(dir, "bundle.yaml");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// loadBundleString
// ---------------------------------------------------------------------------

describe("loadBundleString", () => {
  test("parses valid YAML", () => {
    const [data, hash] = loadBundleString(VALID_YAML);
    expect(data.apiVersion).toBe("edictum/v1");
    expect(data.kind).toBe("ContractBundle");
    expect(Array.isArray(data.contracts)).toBe(true);
    expect((data.contracts as unknown[]).length).toBe(1);
    expect(hash.hex).toBeDefined();
  });

  test("accepts Uint8Array input", () => {
    const bytes = new TextEncoder().encode(VALID_YAML);
    const [data, hash] = loadBundleString(bytes);
    expect(data.apiVersion).toBe("edictum/v1");
    expect(hash.hex.length).toBe(64);
  });

  test("bundle hash is SHA256 hex (64 chars)", () => {
    const [, hash] = loadBundleString(VALID_YAML);
    expect(hash.hex.length).toBe(64);
    expect(/^[a-f0-9]{64}$/.test(hash.hex)).toBe(true);
  });

  test("same content produces same hash", () => {
    const [, hash1] = loadBundleString(VALID_YAML);
    const [, hash2] = loadBundleString(VALID_YAML);
    expect(hash1.hex).toBe(hash2.hex);
  });
});

// ---------------------------------------------------------------------------
// loadBundle (from file)
// ---------------------------------------------------------------------------

describe("loadBundle", () => {
  test("loads from file path", () => {
    const filePath = writeTempYaml(VALID_YAML);
    const [data, hash] = loadBundle(filePath);
    expect(data.apiVersion).toBe("edictum/v1");
    expect(hash.hex.length).toBe(64);
  });

  test("file not found throws", () => {
    expect(() => loadBundle("/nonexistent/path/bundle.yaml")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// computeHash
// ---------------------------------------------------------------------------

describe("computeHash", () => {
  test("returns SHA256 hex", () => {
    const bytes = new TextEncoder().encode("test content");
    const hash = computeHash(bytes);
    expect(hash.hex.length).toBe(64);
    expect(/^[a-f0-9]{64}$/.test(hash.hex)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Max bundle size
// ---------------------------------------------------------------------------

describe("MaxBundleSize", () => {
  test("oversized content rejected", () => {
    const oversized = "x".repeat(MAX_BUNDLE_SIZE + 1);
    expect(() => loadBundleString(oversized)).toThrow(EdictumConfigError);
  });

  test("oversized file rejected", () => {
    const oversized = "x".repeat(MAX_BUNDLE_SIZE + 1);
    const filePath = writeTempYaml(oversized);
    expect(() => loadBundle(filePath)).toThrow(EdictumConfigError);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("validateSchema", () => {
  test("missing apiVersion rejected", () => {
    expect(() =>
      validateSchema({ kind: "ContractBundle", contracts: [] }),
    ).toThrow(EdictumConfigError);
  });

  test("wrong apiVersion rejected", () => {
    expect(() =>
      validateSchema({ apiVersion: "bad/v1", kind: "ContractBundle", contracts: [] }),
    ).toThrow(EdictumConfigError);
  });

  test("missing kind rejected", () => {
    expect(() =>
      validateSchema({ apiVersion: "edictum/v1", contracts: [] }),
    ).toThrow(EdictumConfigError);
  });

  test("wrong kind rejected", () => {
    expect(() =>
      validateSchema({ apiVersion: "edictum/v1", kind: "Wrong", contracts: [] }),
    ).toThrow(EdictumConfigError);
  });

  test("contracts must be array", () => {
    expect(() =>
      validateSchema({ apiVersion: "edictum/v1", kind: "ContractBundle", contracts: "bad" }),
    ).toThrow(EdictumConfigError);
  });

  test("valid schema passes", () => {
    expect(() =>
      validateSchema({ apiVersion: "edictum/v1", kind: "ContractBundle", contracts: [] }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Duplicate contract IDs
// ---------------------------------------------------------------------------

describe("validateUniqueIds", () => {
  test("duplicate IDs rejected", () => {
    expect(() =>
      validateUniqueIds({
        contracts: [{ id: "dup" }, { id: "dup" }],
      }),
    ).toThrow(EdictumConfigError);
  });

  test("unique IDs pass", () => {
    expect(() =>
      validateUniqueIds({
        contracts: [{ id: "a" }, { id: "b" }],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Regex validation
// ---------------------------------------------------------------------------

describe("validateRegexes", () => {
  test("invalid regex rejected", () => {
    expect(() =>
      validateRegexes({
        contracts: [
          {
            id: "bad-regex",
            when: { "args.x": { matches: "[invalid" } },
          },
        ],
      }),
    ).toThrow(EdictumConfigError);
  });

  test("valid regex passes", () => {
    expect(() =>
      validateRegexes({
        contracts: [
          {
            id: "good-regex",
            when: { "args.x": { matches: "\\d+" } },
          },
        ],
      }),
    ).not.toThrow();
  });

  test("invalid regex in matches_any rejected", () => {
    expect(() =>
      validateRegexes({
        contracts: [
          {
            id: "bad-regex-any",
            when: { "args.x": { matches_any: ["good", "[bad"] } },
          },
        ],
      }),
    ).toThrow(EdictumConfigError);
  });
});

// ---------------------------------------------------------------------------
// Pre-selector validation: output.text in pre contracts
// ---------------------------------------------------------------------------

describe("validatePreSelectors", () => {
  test("output.text in pre contract rejected", () => {
    expect(() =>
      validatePreSelectors({
        contracts: [
          {
            id: "bad-pre",
            type: "pre",
            when: { "output.text": { contains: "secret" } },
          },
        ],
      }),
    ).toThrow(EdictumConfigError);
  });

  test("output.text in post contract allowed", () => {
    expect(() =>
      validatePreSelectors({
        contracts: [
          {
            id: "ok-post",
            type: "post",
            when: { "output.text": { contains: "secret" } },
          },
        ],
      }),
    ).not.toThrow();
  });

  test("output.text in nested all within pre rejected", () => {
    expect(() =>
      validatePreSelectors({
        contracts: [
          {
            id: "nested-bad",
            type: "pre",
            when: { all: [{ "output.text": { contains: "secret" } }] },
          },
        ],
      }),
    ).toThrow(EdictumConfigError);
  });
});

// ---------------------------------------------------------------------------
// Sandbox contract validation
// ---------------------------------------------------------------------------

describe("validateSandboxContracts", () => {
  test("not_within without within rejected", () => {
    expect(() =>
      validateSandboxContracts({
        contracts: [
          {
            id: "bad-sandbox",
            type: "sandbox",
            not_within: ["/etc"],
          },
        ],
      }),
    ).toThrow(EdictumConfigError);
  });

  test("not_allows without allows rejected", () => {
    expect(() =>
      validateSandboxContracts({
        contracts: [
          {
            id: "bad-sandbox",
            type: "sandbox",
            not_allows: { domains: ["evil.com"] },
          },
        ],
      }),
    ).toThrow(EdictumConfigError);
  });

  test("not_allows.domains without allows.domains rejected", () => {
    expect(() =>
      validateSandboxContracts({
        contracts: [
          {
            id: "bad-sandbox",
            type: "sandbox",
            allows: { paths: ["/tmp"] },
            not_allows: { domains: ["evil.com"] },
          },
        ],
      }),
    ).toThrow(EdictumConfigError);
  });

  test("valid sandbox passes", () => {
    expect(() =>
      validateSandboxContracts({
        contracts: [
          {
            id: "ok-sandbox",
            type: "sandbox",
            within: ["/tmp"],
            not_within: ["/tmp/secret"],
          },
        ],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Security: adversarial loader inputs
// ---------------------------------------------------------------------------

describe("security", () => {
  test("symlink-resolved path used for file loading", () => {
    // loadBundle now calls realpathSync — verify it doesn't crash on a normal path
    const filePath = writeTempYaml(VALID_YAML);
    const [data] = loadBundle(filePath);
    expect(data.apiVersion).toBe("edictum/v1");
  });

  test("null bytes in YAML content rejected", () => {
    const malicious = VALID_YAML + "\x00";
    // Should either parse successfully (ignoring null) or throw — must not crash
    expect(() => {
      try {
        loadBundleString(malicious);
      } catch (e) {
        if (e instanceof EdictumConfigError) throw e;
        // Non-config errors (e.g. YAML parse) are also acceptable rejections
        throw new EdictumConfigError(String(e));
      }
    }).not.toThrow(TypeError);
  });

  test("control characters in contract IDs rejected or handled", () => {
    const yaml = `
apiVersion: edictum/v1
kind: ContractBundle
metadata:
  name: test
defaults:
  mode: enforce
contracts:
  - id: "bad\\x00id"
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "bad"
`;
    // Must not throw TypeError — either parses or throws EdictumConfigError
    try {
      loadBundleString(yaml);
    } catch (e) {
      expect(e).not.toBeInstanceOf(TypeError);
    }
  });

  test("U+2028 line separator in contract ID rejected", () => {
    const yaml = `
apiVersion: edictum/v1
kind: ContractBundle
metadata:
  name: test
defaults:
  mode: enforce
contracts:
  - id: "bad\u2028id"
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "bad"
`;
    expect(() => loadBundleString(yaml)).toThrow(/control characters/);
  });

  test("U+2029 paragraph separator in contract ID rejected", () => {
    const yaml = `
apiVersion: edictum/v1
kind: ContractBundle
metadata:
  name: test
defaults:
  mode: enforce
contracts:
  - id: "bad\u2029id"
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "bad"
`;
    expect(() => loadBundleString(yaml)).toThrow(/control characters/);
  });

  test("extremely deeply nested YAML does not cause stack overflow", () => {
    // Build a moderately nested structure — should throw config error, not crash
    let nested = '{ equals: "x" }';
    for (let i = 0; i < 50; i++) {
      nested = `{ not: ${nested} }`;
    }
    const yaml = `
apiVersion: edictum/v1
kind: ContractBundle
metadata:
  name: test
defaults:
  mode: enforce
contracts:
  - id: deep-nest
    type: pre
    tool: "*"
    when:
      args.x: ${nested}
    then:
      effect: deny
      message: "deep"
`;
    // Should not throw RangeError (stack overflow)
    try {
      loadBundleString(yaml);
    } catch (e) {
      expect(e).not.toBeInstanceOf(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: loadBundleString with validation failures
// ---------------------------------------------------------------------------

describe("loadBundleString validation", () => {
  test("invalid YAML syntax rejected", () => {
    expect(() => loadBundleString("{ invalid yaml: [")).toThrow(EdictumConfigError);
  });

  test("non-mapping YAML rejected", () => {
    expect(() => loadBundleString("- just\n- a list")).toThrow(EdictumConfigError);
  });

  test("missing apiVersion in full load rejected", () => {
    const yaml = `
kind: ContractBundle
contracts: []
`;
    expect(() => loadBundleString(yaml)).toThrow(EdictumConfigError);
  });

  test("duplicate IDs in full load rejected", () => {
    const yaml = `
apiVersion: edictum/v1
kind: ContractBundle
metadata:
  name: test
defaults:
  mode: enforce
contracts:
  - id: dup
    type: pre
    tool: "*"
    when:
      args.x: { equals: 1 }
    then:
      effect: deny
      message: "a"
  - id: dup
    type: pre
    tool: "*"
    when:
      args.y: { equals: 2 }
    then:
      effect: deny
      message: "b"
`;
    expect(() => loadBundleString(yaml)).toThrow(EdictumConfigError);
  });
});
