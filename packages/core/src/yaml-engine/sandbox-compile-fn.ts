/** compileSandbox — compile a sandbox contract YAML dict into a callable with metadata. */

import { Verdict } from '../contracts.js'
import type { ToolEnvelope } from '../envelope.js'
import { expandMessage } from './compiler-utils.js'
import {
  extractPaths,
  extractCommand,
  extractUrls,
  extractHostname,
  domainMatches,
} from './sandbox-compiler.js'

import { resolvePath } from './resolve-path.js'

/** Check if a path is within an allowed prefix. */
function _pathWithin(filePath: string, prefix: string): boolean {
  return filePath === prefix || filePath.startsWith(prefix.replace(/\/+$/, '') + '/')
}

/**
 * Compile a sandbox contract into a callable with _edictum_* metadata.
 *
 * The returned object has a `check` function and stamped metadata properties
 * for pipeline routing.
 */
export function compileSandbox(
  contract: Record<string, unknown>,
  mode: string,
): Record<string, unknown> {
  const contractId = contract.id as string

  // Normalize tool/tools to a list
  const toolPatterns: string[] =
    'tools' in contract ? (contract.tools as string[]) : [contract.tool as string]

  const within = ((contract.within ?? []) as string[]).map(resolvePath)
  const notWithin = ((contract.not_within ?? []) as string[]).map(resolvePath)
  const allows = (contract.allows ?? {}) as Record<string, unknown>
  const notAllows = (contract.not_allows ?? {}) as Record<string, unknown>
  const allowedCommands = (allows.commands ?? []) as string[]
  const allowedDomains = (allows.domains ?? []) as string[]
  const blockedDomains = (notAllows.domains ?? []) as string[]
  const outside = (contract.outside as string) ?? 'deny'
  const messageTemplate = (contract.message as string) ?? 'Tool call outside sandbox boundary.'
  const timeout = (contract.timeout as number) ?? 300
  const timeoutEffect = (contract.timeout_effect as string) ?? 'deny'

  const check = (envelope: ToolEnvelope): Verdict => {
    // Path checks — FAIL-CLOSED when sandbox declares path boundaries
    if (within.length > 0 || notWithin.length > 0) {
      const paths = extractPaths(envelope)

      // FAIL-CLOSED: If the sandbox declares path boundaries (within/not_within)
      // but we couldn't extract any paths from the tool call, we DENY.
      // Rationale: we can't verify what we can't see. An attacker who crafts
      // args that bypass extractPaths() should not get a free pass.
      if (paths.length === 0 && within.length > 0) {
        return Verdict.fail(
          expandMessage(messageTemplate, envelope) +
            ' (no extractable paths — sandbox cannot verify boundary compliance)',
        )
      }

      if (paths.length > 0) {
        for (const p of paths) {
          for (const excluded of notWithin) {
            if (_pathWithin(p, excluded)) {
              return Verdict.fail(expandMessage(messageTemplate, envelope))
            }
          }
        }
        if (within.length > 0) {
          for (const p of paths) {
            if (!within.some((allowed) => _pathWithin(p, allowed))) {
              return Verdict.fail(expandMessage(messageTemplate, envelope))
            }
          }
        }
      }
    }

    // Command checks
    if (allowedCommands.length > 0) {
      const firstToken = extractCommand(envelope)
      if (firstToken !== null && !allowedCommands.includes(firstToken)) {
        return Verdict.fail(expandMessage(messageTemplate, envelope))
      }
    }

    // Domain checks
    const urls = extractUrls(envelope)
    if (urls.length > 0) {
      for (const url of urls) {
        const hostname = extractHostname(url)
        if (hostname) {
          if (blockedDomains.length > 0 && domainMatches(hostname, blockedDomains)) {
            return Verdict.fail(expandMessage(messageTemplate, envelope))
          }
          if (allowedDomains.length > 0 && !domainMatches(hostname, allowedDomains)) {
            return Verdict.fail(expandMessage(messageTemplate, envelope))
          }
        } else if (allowedDomains.length > 0) {
          // Fail-closed: URLs without extractable hostname (file://, data:, etc.)
          // cannot be verified against domain allowlist → deny
          return Verdict.fail(expandMessage(messageTemplate, envelope))
        }
      }
    }

    return Verdict.pass_()
  }

  const result: Record<string, unknown> = {
    check,
    name: contractId,
    tool: toolPatterns.length === 1 ? toolPatterns[0] : undefined,
    _edictum_type: 'sandbox',
    _edictum_tools: toolPatterns,
    _edictum_mode: mode,
    _edictum_id: contractId,
    _edictum_source: 'yaml_sandbox',
    _edictum_effect: outside,
    _edictum_timeout: timeout,
    _edictum_timeout_effect: timeoutEffect,
  }

  // Use _observe (TS) not _shadow (Python). Strict === true to prevent
  // truthy coercion of non-boolean values (e.g., strings, numbers).
  if (contract._observe === true || contract._shadow === true) {
    result._edictum_observe = true
  }

  return result
}
