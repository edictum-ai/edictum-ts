// @edictum/openclaw — helper functions extracted from adapter.ts

import type { Finding } from "./types.js";

// ---------------------------------------------------------------------------
// buildFindings
// ---------------------------------------------------------------------------

export function buildFindings(postDecision: {
  postconditionsPassed: boolean;
  warnings: string[];
  contractsEvaluated: Record<string, unknown>[];
  policyError: boolean;
}): Finding[] {
  if (postDecision.postconditionsPassed && !postDecision.policyError) {
    return [];
  }
  const findings: Finding[] = [];
  for (const w of postDecision.warnings) {
    findings.push({
      contractId: null,
      message: w,
      tags: [],
      severity: "warn",
    });
  }
  for (const c of postDecision.contractsEvaluated) {
    if (c.passed === false || c.policyError === true) {
      findings.push({
        contractId: (c.contractId as string) ?? null,
        message: (c.message as string) ?? "Postcondition failed.",
        tags: (c.tags as string[]) ?? [],
        severity: (c.policyError as boolean) ? "error" : "warn",
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// summarizeResult
// ---------------------------------------------------------------------------

export function summarizeResult(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  try {
    const str = typeof result === "string" ? result : JSON.stringify(result);
    return str.length > 200 ? str.slice(0, 197) + "..." : str;
  } catch {
    // Circular references or other serialization errors must not propagate
    return "[unserializable result]";
  }
}
