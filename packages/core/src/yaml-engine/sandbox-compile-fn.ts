/** compileSandbox — compile a sandbox rule YAML dict into a callable with metadata. */

import { Decision } from '../rules.js'
import type { ToolCall } from '../tool-call.js'
import { expandMessage } from './compiler-utils.js'

/** Map YAML action values to internal effect values. */
function mapAction(action: string): string {
  if (action === 'block') return 'deny'
  if (action === 'ask') return 'approve'
  return action
}
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
 * Compile a sandbox rule into a callable with _edictum_* metadata.
 *
 * The returned object has a `check` function and stamped metadata properties
 * for pipeline routing.
 */
export function compileSandbox(
  rule: Record<string, unknown>,
  mode: string,
): Record<string, unknown> {
  const ruleId = rule.id as string

  // Normalize tool/tools to a list
  const toolPatterns: string[] = 'tools' in rule ? (rule.tools as string[]) : [rule.tool as string]

  const within = ((rule.within ?? []) as string[]).map(resolvePath)
  const notWithin = ((rule.not_within ?? []) as string[]).map(resolvePath)
  const allows = (rule.allows ?? {}) as Record<string, unknown>
  const notAllows = (rule.not_allows ?? {}) as Record<string, unknown>
  const allowedCommands = (allows.commands ?? []) as string[]
  const allowedDomains = (allows.domains ?? []) as string[]
  const blockedDomains = (notAllows.domains ?? []) as string[]
  const outside = (rule.outside as string) ?? 'block'
  const messageTemplate = (rule.message as string) ?? 'Tool call outside sandbox boundary.'
  const timeout = (rule.timeout as number) ?? 300
  const timeoutEffect = (rule.timeout_action as string) ?? 'block'

  const check = (toolCall: ToolCall): Decision => {
    // Path checks — FAIL-CLOSED when sandbox declares path boundaries
    if (within.length > 0 || notWithin.length > 0) {
      const paths = extractPaths(toolCall)

      // FAIL-CLOSED: If the sandbox declares path boundaries (within/not_within)
      // but we couldn't extract any paths from the tool call, we DENY.
      // Rationale: we can't verify what we can't see. An attacker who crafts
      // args that bypass extractPaths() should not get a free pass.
      if (paths.length === 0 && within.length > 0) {
        return Decision.fail(
          expandMessage(messageTemplate, toolCall) +
            ' (no extractable paths — sandbox cannot verify boundary compliance)',
        )
      }

      if (paths.length > 0) {
        for (const p of paths) {
          for (const excluded of notWithin) {
            if (_pathWithin(p, excluded)) {
              return Decision.fail(expandMessage(messageTemplate, toolCall))
            }
          }
        }
        if (within.length > 0) {
          for (const p of paths) {
            if (!within.some((allowed) => _pathWithin(p, allowed))) {
              return Decision.fail(expandMessage(messageTemplate, toolCall))
            }
          }
        }
      }
    }

    // Command checks
    if (allowedCommands.length > 0) {
      const firstToken = extractCommand(toolCall)
      if (firstToken !== null && !allowedCommands.includes(firstToken)) {
        return Decision.fail(expandMessage(messageTemplate, toolCall))
      }
    }

    // Domain checks
    const urls = extractUrls(toolCall)
    if (urls.length > 0) {
      for (const url of urls) {
        const hostname = extractHostname(url)
        if (hostname) {
          if (blockedDomains.length > 0 && domainMatches(hostname, blockedDomains)) {
            return Decision.fail(expandMessage(messageTemplate, toolCall))
          }
          if (allowedDomains.length > 0 && !domainMatches(hostname, allowedDomains)) {
            return Decision.fail(expandMessage(messageTemplate, toolCall))
          }
        } else if (allowedDomains.length > 0) {
          // Fail-closed: URLs without extractable hostname (file://, data:, etc.)
          // cannot be verified against domain allowlist → deny
          return Decision.fail(expandMessage(messageTemplate, toolCall))
        }
      }
    }

    return Decision.pass_()
  }

  const internalEffect = mapAction(outside)
  const internalTimeoutEffect = mapAction(timeoutEffect)
  const result: Record<string, unknown> = {
    check,
    name: ruleId,
    tool: toolPatterns.length === 1 ? toolPatterns[0] : undefined,
    effect: internalEffect,
    timeout,
    timeoutEffect: internalTimeoutEffect,
    _edictum_type: 'sandbox',
    _edictum_tools: toolPatterns,
    _edictum_mode: mode,
    _edictum_id: ruleId,
    _edictum_source: 'yaml_sandbox',
    _edictum_effect: internalEffect,
    _edictum_timeout: timeout,
    _edictum_timeout_action: internalTimeoutEffect,
  }

  // Use _observe (TS) not _shadow (Python). Strict === true to prevent
  // truthy coercion of non-boolean values (e.g., strings, numbers).
  if (rule._observe === true || rule._shadow === true) {
    result._edictum_observe = true
  }

  return result
}
