/**
 * Factory functions for creating Edictum instances from YAML bundles.
 *
 * Ports Python's _factory.py: fromYaml, fromYamlString, reload.
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's _factory.py
 * (384 LOC). The three factory functions share option types and helper logic
 * that would create unnecessary coupling if split.
 *
 * Guard.ts delegates to these via dynamic import to avoid circular deps.
 */

import { createHash } from "node:crypto";

import type { ApprovalBackend } from "./approval.js";
import type { AuditSink } from "./audit.js";
import { EdictumConfigError } from "./errors.js";
import type { Principal, ToolEnvelope } from "./envelope.js";
import { Edictum } from "./guard.js";
import type { OperationLimits } from "./limits.js";
import type { RedactionPolicy } from "./redaction.js";
import type { StorageBackend } from "./storage.js";
import { composeBundles } from "./yaml-engine/composer.js";
import type { CompositionReport } from "./yaml-engine/composer.js";
import { compileContracts } from "./yaml-engine/compiler.js";
import type { CustomOperator, CustomSelector } from "./yaml-engine/evaluator.js";
import { loadBundle, loadBundleString } from "./yaml-engine/loader.js";

// ---------------------------------------------------------------------------
// Shared options type
// ---------------------------------------------------------------------------

/** Options shared by fromYaml and fromYamlString. */
export interface YamlFactoryOptions {
  readonly mode?: "enforce" | "observe";
  readonly tools?: Record<string, { side_effect?: string; idempotent?: boolean }>;
  readonly auditSink?: AuditSink | AuditSink[];
  readonly redaction?: RedactionPolicy;
  readonly backend?: StorageBackend;
  readonly environment?: string;
  readonly onDeny?: (envelope: ToolEnvelope, reason: string, source: string | null) => void;
  readonly onAllow?: (envelope: ToolEnvelope) => void;
  readonly customOperators?: Record<string, CustomOperator>;
  readonly customSelectors?: Record<string, CustomSelector>;
  readonly successCheck?: (toolName: string, result: unknown) => boolean;
  readonly principal?: Principal;
  readonly principalResolver?: (toolName: string, toolInput: Record<string, unknown>) => Principal;
  readonly approvalBackend?: ApprovalBackend;
}

/** Options for fromYaml, extending base with returnReport. */
export interface FromYamlOptions extends YamlFactoryOptions {
  readonly returnReport?: boolean;
}

// ---------------------------------------------------------------------------
// fromYaml
// ---------------------------------------------------------------------------

/**
 * Create an Edictum instance from one or more YAML contract bundle paths.
 *
 * When multiple paths are given, bundles are composed left-to-right
 * (later layers override earlier ones).
 */
export function fromYaml(
  ...args: [...string[], FromYamlOptions] | string[]
): Edictum | [Edictum, CompositionReport] {
  // Separate paths from trailing options object
  let paths: string[];
  let options: FromYamlOptions;

  const last = args[args.length - 1];
  if (typeof last === "object" && last !== null && !Array.isArray(last)) {
    paths = args.slice(0, -1) as string[];
    options = last as FromYamlOptions;
  } else {
    paths = args as string[];
    options = {};
  }

  if (paths.length === 0) {
    throw new EdictumConfigError("fromYaml() requires at least one path");
  }

  // Load all bundles
  const loaded: [Record<string, unknown>, { hex: string }][] = [];
  for (const p of paths) {
    loaded.push(loadBundle(p));
  }

  let bundleData: Record<string, unknown>;
  let policyVersion: string;
  let report: CompositionReport;

  if (loaded.length === 1) {
    const entry = loaded[0] as [Record<string, unknown>, { hex: string }];
    bundleData = entry[0];
    policyVersion = entry[1].hex;
    report = { overriddenContracts: [], observeContracts: [] };
  } else {
    const bundleTuples: [Record<string, unknown>, string][] = loaded.map(
      ([data], i) => [data, paths[i] as string],
    );
    const composed = composeBundles(...bundleTuples);
    bundleData = composed.bundle;
    report = composed.report;
    policyVersion = createHash("sha256")
      .update(loaded.map(([, h]) => h.hex).join(":"))
      .digest("hex");
  }

  const compiled = compileContracts(bundleData, {
    customOperators: options.customOperators ?? null,
    customSelectors: options.customSelectors ?? null,
  });

  const guard = _buildGuard(compiled, policyVersion, options);

  if (options.returnReport) {
    return [guard, report];
  }
  return guard;
}

// ---------------------------------------------------------------------------
// fromYamlString
// ---------------------------------------------------------------------------

/**
 * Create an Edictum instance from a YAML string or Uint8Array.
 *
 * Like fromYaml but accepts YAML content directly instead of a file path.
 */
export function fromYamlString(
  content: string | Uint8Array,
  options: YamlFactoryOptions = {},
): Edictum {
  const [bundleData, bundleHash] = loadBundleString(content);
  const policyVersion = bundleHash.hex;

  const compiled = compileContracts(bundleData, {
    customOperators: options.customOperators ?? null,
    customSelectors: options.customSelectors ?? null,
  });

  return _buildGuard(compiled, policyVersion, options);
}

// ---------------------------------------------------------------------------
// reload
// ---------------------------------------------------------------------------

/** Options for reload(). */
export interface ReloadOptions {
  readonly customOperators?: Record<string, CustomOperator>;
  readonly customSelectors?: Record<string, CustomSelector>;
}

/**
 * Atomically replace a guard's contracts from a YAML string.
 *
 * Builds a new CompiledState from the YAML content and swaps the
 * guard's internal state reference. Concurrent evaluations that
 * started before reload() see the old state; evaluations after
 * see the new state.
 */
export function reload(
  guard: Edictum,
  yamlContent: string,
  options: ReloadOptions = {},
): void {
  const [bundleData, bundleHash] = loadBundleString(yamlContent);
  const compiled = compileContracts(bundleData, {
    customOperators: options.customOperators ?? null,
    customSelectors: options.customSelectors ?? null,
  });

  const allContracts = [
    ...compiled.preconditions,
    ...compiled.postconditions,
    ...compiled.sessionContracts,
    ...compiled.sandboxContracts,
  ] as unknown[];

  // Classify into enforce/observe lists via the same logic the constructor uses.
  // We build a temporary Edictum to leverage _classifyContracts, then steal its state.
  const temp = new Edictum({
    contracts: allContracts as never[],
    limits: compiled.limits,
    policyVersion: bundleHash.hex,
  });

  // Atomic state swap — single reference assignment
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (guard as any)._state = (temp as any)._state;
}

// ---------------------------------------------------------------------------
// Internal: build guard from compiled bundle
// ---------------------------------------------------------------------------

function _buildGuard(
  compiled: {
    preconditions: readonly unknown[];
    postconditions: readonly unknown[];
    sessionContracts: readonly unknown[];
    sandboxContracts: readonly unknown[];
    limits: OperationLimits;
    defaultMode: string;
    tools: Readonly<Record<string, Record<string, unknown>>>;
  },
  policyVersion: string,
  options: YamlFactoryOptions,
): Edictum {
  const effectiveMode = options.mode ?? compiled.defaultMode;

  const allContracts = [
    ...compiled.preconditions,
    ...compiled.postconditions,
    ...compiled.sessionContracts,
    ...compiled.sandboxContracts,
  ];

  // Merge YAML tools with parameter tools (parameter wins on conflict)
  const mergedTools: Record<string, { side_effect?: string; idempotent?: boolean }> = {};
  for (const [name, cfg] of Object.entries(compiled.tools)) {
    mergedTools[name] = cfg as { side_effect?: string; idempotent?: boolean };
  }
  if (options.tools) {
    for (const [name, cfg] of Object.entries(options.tools)) {
      mergedTools[name] = cfg;
    }
  }

  return new Edictum({
    environment: options.environment ?? "production",
    mode: effectiveMode as "enforce" | "observe",
    limits: compiled.limits,
    tools: Object.keys(mergedTools).length > 0 ? mergedTools : undefined,
    contracts: allContracts as never[],
    auditSink: options.auditSink,
    redaction: options.redaction,
    backend: options.backend,
    policyVersion,
    onDeny: options.onDeny,
    onAllow: options.onAllow,
    successCheck: options.successCheck,
    principal: options.principal,
    principalResolver: options.principalResolver,
    approvalBackend: options.approvalBackend,
  });
}
