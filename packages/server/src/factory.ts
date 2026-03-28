/**
 * Server guard factory — connects an Edictum guard to edictum-console.
 *
 * This is the TypeScript equivalent of Python's Edictum.from_server().
 * It lives in @edictum/server (not @edictum/core) because core does not
 * depend on server-specific I/O classes (HTTP client, SSE, audit sink).
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's
 * _server_factory.py (228 LOC) — validation, bundle fetch, SSE watcher
 * startup, assignment waiting, and cleanup form a cohesive factory.
 */

import { Edictum, EdictumConfigError, compileContracts, loadBundleString } from '@edictum/core'
import type { AuditSink, ApprovalBackend, StorageBackend, Principal, ToolCall } from '@edictum/core'

import { EdictumServerClient, SAFE_IDENTIFIER_RE, _setClientBundleName } from './client.js'
import type { EdictumServerClientOptions } from './client.js'
import { ServerAuditSink } from './audit-sink.js'
import { ServerApprovalBackend } from './approval-backend.js'
import { ServerBackend } from './backend.js'
import { ServerRuleSource } from './rule-source.js'
import { verifyBundleSignature } from './verification.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback for SSE watcher errors (signature rejections, parse failures). */
export type WatchErrorHandler = (error: {
  readonly type: 'signature_rejected' | 'parse_error' | 'fetch_error' | 'reload_error'
  readonly message: string
  readonly bundleName?: string
}) => void

/** Options for createServerGuard(). */
export interface CreateServerGuardOptions {
  /** Base URL of the edictum-console server. */
  readonly url: string
  /** API key for authentication. */
  readonly apiKey: string
  /** Agent identifier registered with the server. */
  readonly agentId: string
  /** Environment name (default: "production"). */
  readonly environment?: string
  /** Named bundle to fetch. If null, waits for server assignment. */
  readonly bundleName?: string | null
  /** Tags for server-side filtering. */
  readonly tags?: Record<string, string> | null
  /** Override audit sink (default: ServerAuditSink). */
  readonly auditSink?: AuditSink
  /** Override approval backend (default: ServerApprovalBackend). */
  readonly approvalBackend?: ApprovalBackend
  /** Override storage backend (default: ServerBackend). */
  readonly storageBackend?: StorageBackend
  /** Guard mode. If omitted, uses bundle's defaults.mode (default: "enforce"). */
  readonly mode?: 'enforce' | 'observe'
  /** Callback on tool denial. */
  readonly onDeny?: (toolCall: ToolCall, reason: string, source: string | null) => void
  /** Callback on tool approval. */
  readonly onAllow?: (toolCall: ToolCall) => void
  /** Custom success check for tool results. */
  readonly successCheck?: (toolName: string, result: unknown) => boolean
  /** Default principal for all evaluations. */
  readonly principal?: Principal
  /** Resolve principal from tool call context. */
  readonly principalResolver?: (toolName: string, toolInput: Record<string, unknown>) => Principal
  /** Auto-start SSE watcher for hot-reload (default: true). */
  readonly autoWatch?: boolean
  /** Allow plaintext HTTP to non-loopback hosts (default: false). */
  readonly allowInsecure?: boolean
  /** Verify Ed25519 signatures on bundles (default: false). */
  readonly verifySignatures?: boolean
  /** Ed25519 public key (hex) for signature verification. */
  readonly signingPublicKey?: string | null
  /** HTTP client timeout in ms (default: 30_000). */
  readonly timeout?: number
  /** HTTP max retries (default: 3). */
  readonly maxRetries?: number
  /** Timeout for waiting for server assignment in ms (default: 30_000). */
  readonly assignmentTimeout?: number
  /** Callback for SSE watcher errors (signature rejections, parse failures). */
  readonly onWatchError?: WatchErrorHandler
}

/** Read-only view of the server client exposed via ServerGuard. */
export interface ServerGuardClient {
  readonly baseUrl: string
  readonly agentId: string
  readonly env: string
  readonly bundleName: string | null
  readonly tags: Readonly<Record<string, string>> | null
  readonly timeout: number
  readonly maxRetries: number
}

/** A server-connected guard with lifecycle management. */
export interface ServerGuard {
  /** The configured Edictum guard. */
  readonly guard: Edictum
  /** Read-only view of the server client (updateBundleName not exposed). */
  readonly client: ServerGuardClient
  /** Stop SSE watcher, flush audit events, close connections. */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ASSIGNMENT_TIMEOUT_MS = 30_000

/**
 * Max base64-encoded bundle size (682 KB ≈ 512 KB decoded).
 * Guards against unbounded memory allocation from a malicious server.
 * loadBundleString() applies its own MAX_BUNDLE_SIZE check on the decoded
 * YAML, but we reject oversized base64 before allocating the decode buffer.
 */
const MAX_BUNDLE_B64_LENGTH = Math.ceil((512 * 1024 * 4) / 3)

/** Max base64 signature length. Ed25519 sigs are 64 bytes = 88 chars base64. */
const MAX_SIGNATURE_LENGTH = 512

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Edictum guard connected to edictum-console.
 *
 * This is the TypeScript equivalent of Python's `Edictum.from_server()`.
 * It creates an HTTP client, fetches initial rules, starts an SSE
 * watcher for hot-reload, and wires up audit and approval backends.
 *
 * @example
 * ```ts
 * const { guard, close } = await createServerGuard({
 *   url: "https://console.edictum.ai",
 *   apiKey: "ed_live_...",
 *   agentId: "my-agent",
 *   bundleName: "production-rules",
 * });
 *
 * // Use the guard
 * const result = await guard.run("Bash", { command: "ls" }, execFn);
 *
 * // Cleanup
 * await close();
 * ```
 */
export async function createServerGuard(options: CreateServerGuardOptions): Promise<ServerGuard> {
  const {
    url,
    apiKey,
    agentId,
    environment = 'production',
    bundleName = null,
    tags = null,
    autoWatch = true,
    verifySignatures = false,
    signingPublicKey = null,
    assignmentTimeout = DEFAULT_ASSIGNMENT_TIMEOUT_MS,
    onWatchError,
  } = options

  // Do NOT destructure `mode` with a default — undefined means
  // "use the bundle's defaults.mode", falling back to "enforce".
  const explicitMode = options.mode

  // -----------------------------------------------------------------------
  // Validation
  // Note: TLS enforcement is validated inside EdictumServerClient constructor.
  // Application-level checks (bundleName, verifySignatures, assignmentTimeout)
  // are validated here first for clearer error messages on common misconfigurations.
  // -----------------------------------------------------------------------

  if (bundleName == null && !autoWatch) {
    throw new EdictumConfigError(
      'bundleName is required when autoWatch is false. ' +
        'Without a named bundle and no SSE watcher, the guard has no rules.',
    )
  }

  if (verifySignatures && !signingPublicKey) {
    throw new EdictumConfigError('signingPublicKey is required when verifySignatures is true')
  }

  if (!Number.isFinite(assignmentTimeout) || assignmentTimeout <= 0) {
    throw new EdictumConfigError(
      `assignmentTimeout must be a positive finite number, got ${assignmentTimeout}`,
    )
  }

  // -----------------------------------------------------------------------
  // Create server client
  // -----------------------------------------------------------------------

  const clientOpts: EdictumServerClientOptions = {
    baseUrl: url,
    apiKey,
    agentId,
    env: environment,
    bundleName,
    tags,
    allowInsecure: options.allowInsecure,
    ...(options.timeout !== undefined && { timeout: options.timeout }),
    ...(options.maxRetries !== undefined && { maxRetries: options.maxRetries }),
  }

  const client = new EdictumServerClient(clientOpts)

  // -----------------------------------------------------------------------
  // Create backends (use provided or server-backed defaults)
  // -----------------------------------------------------------------------

  const auditSink = options.auditSink ?? new ServerAuditSink(client)
  const approvalBackend = options.approvalBackend ?? new ServerApprovalBackend(client)
  const storageBackend = options.storageBackend ?? new ServerBackend(client)

  // -----------------------------------------------------------------------
  // SSE watcher state
  // -----------------------------------------------------------------------

  let contractSource: ServerRuleSource | null = null
  let watchAbort: AbortController | null = null
  let watchPromise: Promise<void> | null = null

  // -----------------------------------------------------------------------
  // Build guard — two paths based on bundleName
  // -----------------------------------------------------------------------

  let guard: Edictum

  try {
    if (bundleName != null) {
      // Path A: Named bundle — fetch initial rules from server
      guard = await _fetchAndBuildGuard(
        client,
        bundleName,
        environment,
        explicitMode,
        verifySignatures,
        signingPublicKey,
        auditSink,
        approvalBackend,
        storageBackend,
        options,
      )
    } else {
      // Path B: Server-assigned — create empty guard, wait for assignment
      guard = new Edictum({
        environment,
        mode: explicitMode ?? 'enforce',
        rules: [],
        auditSink,
        approvalBackend,
        backend: storageBackend,
        onDeny: options.onDeny,
        onAllow: options.onAllow,
        successCheck: options.successCheck,
        principal: options.principal,
        principalResolver: options.principalResolver,
      })
    }

    // -------------------------------------------------------------------
    // Start SSE watcher for hot-reload
    // -------------------------------------------------------------------

    if (autoWatch) {
      contractSource = new ServerRuleSource(client)
      watchAbort = new AbortController()
      watchPromise = _startSseWatcher(
        guard,
        client,
        contractSource,
        verifySignatures,
        signingPublicKey,
        watchAbort.signal,
        onWatchError ?? null,
      )
    }

    // -------------------------------------------------------------------
    // Wait for server assignment if no bundle name
    // -------------------------------------------------------------------

    if (bundleName == null) {
      const assigned = await _waitForAssignment(guard, assignmentTimeout, watchPromise)
      if (!assigned) {
        throw new EdictumConfigError(
          `Timed out waiting for server assignment after ${assignmentTimeout}ms. ` +
            'Ensure the server has an active assignment for this agent.',
        )
      }
    }
  } catch (err) {
    await _cleanupResources(watchAbort, watchPromise, contractSource, auditSink, client)
    throw err
  }

  // -----------------------------------------------------------------------
  // Return ServerGuard with lifecycle management
  // -----------------------------------------------------------------------

  let closed = false
  return {
    guard,
    client,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await _cleanupResources(watchAbort, watchPromise, contractSource, auditSink, client)
    },
  }
}

// ---------------------------------------------------------------------------
// Internal: decode and validate base64 YAML bundle
// ---------------------------------------------------------------------------

function _decodeYamlB64(yamlB64: string): Uint8Array {
  if (yamlB64.length > MAX_BUNDLE_B64_LENGTH) {
    throw new EdictumConfigError(
      `Bundle yaml_bytes exceeds maximum size (base64 length ${yamlB64.length} > ${MAX_BUNDLE_B64_LENGTH})`,
    )
  }
  // Validate base64 charset before decoding — Buffer.from silently
  // ignores invalid chars, producing garbage that causes misleading
  // YAML parse errors downstream. Round-trip check is O(n) and safe.
  const decoded = Buffer.from(yamlB64, 'base64')
  if (decoded.length === 0 && yamlB64.length > 0) {
    throw new EdictumConfigError('Bundle yaml_bytes contains invalid base64')
  }
  const reEncoded = decoded.toString('base64')
  // Strip trailing padding for comparison (some servers omit it)
  if (reEncoded.replace(/=+$/, '') !== yamlB64.replace(/=+$/, '')) {
    throw new EdictumConfigError('Bundle yaml_bytes contains invalid base64 characters')
  }
  return decoded
}

// ---------------------------------------------------------------------------
// Internal: fetch bundle and build guard
// ---------------------------------------------------------------------------

async function _fetchAndBuildGuard(
  client: EdictumServerClient,
  bundleName: string,
  environment: string,
  explicitMode: 'enforce' | 'observe' | undefined,
  verifySignatures: boolean,
  signingPublicKey: string | null,
  auditSink: AuditSink,
  approvalBackend: ApprovalBackend,
  storageBackend: StorageBackend,
  options: CreateServerGuardOptions,
): Promise<Edictum> {
  const params: Record<string, string> = { env: environment }
  const response = await client.get(
    `/api/v1/bundles/${encodeURIComponent(bundleName)}/current`,
    params,
  )

  const yamlB64 = response['yaml_bytes']
  if (typeof yamlB64 !== 'string') {
    throw new EdictumConfigError("Server response missing 'yaml_bytes' field")
  }

  const yamlBytes = _decodeYamlB64(yamlB64)

  // Verify signature if required
  if (verifySignatures) {
    const signature = response['signature']
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new EdictumConfigError('Bundle signature missing but verifySignatures is enabled')
    }
    if (signature.length > MAX_SIGNATURE_LENGTH) {
      throw new EdictumConfigError(
        `Bundle signature exceeds maximum length (${signature.length} > ${MAX_SIGNATURE_LENGTH})`,
      )
    }
    verifyBundleSignature(yamlBytes, signature, signingPublicKey as string)
  }

  // Compile rules
  const yamlContent = new TextDecoder().decode(yamlBytes)
  const [bundleData, bundleHash] = loadBundleString(yamlContent)
  const compiled = compileContracts(bundleData)

  // Prefer explicit mode, fall back to bundle's defaults.mode
  const rawMode = explicitMode ?? compiled.defaultMode ?? 'enforce'
  if (rawMode !== 'enforce' && rawMode !== 'observe') {
    throw new EdictumConfigError(
      `Invalid mode "${rawMode}" from bundle defaults. Expected "enforce" or "observe".`,
    )
  }
  const effectiveMode = rawMode

  const allRules = [
    ...compiled.preconditions,
    ...compiled.postconditions,
    ...compiled.sessionContracts,
    ...compiled.sandboxContracts,
  ]

  // Merge YAML tools
  const tools: Record<string, { side_effect?: string; idempotent?: boolean }> = {}
  for (const [name, cfg] of Object.entries(compiled.tools)) {
    tools[name] = cfg as { side_effect?: string; idempotent?: boolean }
  }

  return new Edictum({
    environment,
    mode: effectiveMode as 'enforce' | 'observe',
    limits: compiled.limits,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    // Cast note: compiled rules are internal types from the YAML engine
    // that satisfy the Edictum constructor's union type. The same cast is
    // used in core/factory.ts — no public union type exists yet.
    rules: allRules as never[],
    auditSink,
    approvalBackend,
    backend: storageBackend,
    policyVersion: bundleHash.hex,
    onDeny: options.onDeny,
    onAllow: options.onAllow,
    successCheck: options.successCheck,
    principal: options.principal,
    principalResolver: options.principalResolver,
  })
}

// ---------------------------------------------------------------------------
// Internal: SSE watcher
// ---------------------------------------------------------------------------

async function _startSseWatcher(
  guard: Edictum,
  client: EdictumServerClient,
  source: ServerRuleSource,
  verifySignatures: boolean,
  signingPublicKey: string | null,
  signal: AbortSignal,
  onWatchError: WatchErrorHandler | null,
): Promise<void> {
  // Safe wrapper: user callback must never crash the watcher or double-fire
  const safeNotify = (error: Parameters<WatchErrorHandler>[0]): void => {
    try {
      onWatchError?.(error)
    } catch {
      /* user callback error swallowed */
    }
  }

  // Fail-fast: validate preconditions within this function, not just the caller
  if (verifySignatures && signingPublicKey === null) {
    throw new EdictumConfigError('signingPublicKey is required when verifySignatures is true')
  }

  try {
    await source.connect()
    for await (const bundle of source.watch()) {
      if (signal.aborted) return

      let newBundleName: string | null = null
      try {
        let yamlContent: string

        if (bundle['_assignment_changed'] === true) {
          // Assignment changed — fetch the new bundle.
          // Belt-and-suspenders: ServerRuleSource._processEvent is the
          // authoritative validation. This guard protects against alternative
          // ContractSource implementations that skip validation.
          const rawName = bundle['bundle_name']
          if (
            typeof rawName !== 'string' ||
            rawName.length > 128 ||
            !SAFE_IDENTIFIER_RE.test(rawName)
          ) {
            safeNotify({
              type: 'parse_error',
              message: 'Invalid bundle_name in assignment_changed event',
            })
            continue
          }
          newBundleName = rawName

          // Early exit if close() was called during validation
          if (signal.aborted) return

          // Fetch new bundle — pass abort signal so close() cancels in-flight requests
          let response: Record<string, unknown>
          try {
            response = await client.get(
              `/api/v1/bundles/${encodeURIComponent(newBundleName)}/current`,
              { env: client.env },
              { signal },
            )
          } catch (err) {
            safeNotify({
              type: 'fetch_error',
              message: err instanceof Error ? err.message : String(err),
              bundleName: newBundleName,
            })
            continue
          }
          if (signal.aborted) return

          const yamlB64 = response['yaml_bytes']
          if (typeof yamlB64 !== 'string') {
            safeNotify({
              type: 'parse_error',
              message: "Bundle response missing 'yaml_bytes' field",
              bundleName: newBundleName,
            })
            continue
          }

          let yamlBytes: Uint8Array
          try {
            yamlBytes = _decodeYamlB64(yamlB64)
          } catch (err) {
            safeNotify({
              type: 'parse_error',
              message: err instanceof Error ? err.message : 'Base64 decode failed',
              bundleName: newBundleName,
            })
            continue
          }

          if (verifySignatures) {
            const signature = response['signature']
            if (typeof signature !== 'string' || signature.length === 0) {
              safeNotify({
                type: 'signature_rejected',
                message: 'Bundle signature missing but verifySignatures is enabled',
                bundleName: newBundleName,
              })
              continue
            }
            if (signature.length > MAX_SIGNATURE_LENGTH) {
              safeNotify({
                type: 'signature_rejected',
                message: `Bundle signature exceeds maximum length (${signature.length} > ${MAX_SIGNATURE_LENGTH})`,
                bundleName: newBundleName,
              })
              continue
            }
            try {
              verifyBundleSignature(yamlBytes, signature, signingPublicKey as string)
            } catch (err) {
              safeNotify({
                type: 'signature_rejected',
                message: err instanceof Error ? err.message : String(err),
                bundleName: newBundleName,
              })
              continue
            }
          }

          yamlContent = new TextDecoder().decode(yamlBytes)
        } else {
          // Rule update — extract YAML from SSE payload
          const yamlB64 = bundle['yaml_bytes']
          if (typeof yamlB64 !== 'string') {
            safeNotify({
              type: 'parse_error',
              message: "SSE bundle payload missing 'yaml_bytes' field",
            })
            continue
          }

          let yamlBytes: Uint8Array
          try {
            yamlBytes = _decodeYamlB64(yamlB64)
          } catch (err) {
            safeNotify({
              type: 'parse_error',
              message: err instanceof Error ? err.message : 'Base64 decode failed',
            })
            continue
          }

          if (verifySignatures) {
            const signature = bundle['signature']
            if (typeof signature !== 'string' || signature.length === 0) {
              safeNotify({
                type: 'signature_rejected',
                message: 'Bundle signature missing but verifySignatures is enabled',
              })
              continue
            }
            if (signature.length > MAX_SIGNATURE_LENGTH) {
              safeNotify({
                type: 'signature_rejected',
                message: `Bundle signature exceeds maximum length (${signature.length} > ${MAX_SIGNATURE_LENGTH})`,
              })
              continue
            }
            try {
              verifyBundleSignature(yamlBytes, signature, signingPublicKey as string)
            } catch (err) {
              safeNotify({
                type: 'signature_rejected',
                message: err instanceof Error ? err.message : String(err),
              })
              continue
            }
          }

          yamlContent = new TextDecoder().decode(yamlBytes)
        }

        // reload() is synchronous (returns void) — atomic state swap
        guard.reload(yamlContent)
      } catch (err) {
        safeNotify({
          type: 'reload_error',
          message: err instanceof Error ? err.message : String(err),
        })
        continue
      }

      // Update bundle name after successful reload to maintain consistency.
      if (newBundleName !== null) {
        _setClientBundleName(client, newBundleName)
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      safeNotify({
        type: 'fetch_error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: wait for server assignment
// ---------------------------------------------------------------------------

async function _waitForAssignment(
  guard: Edictum,
  timeoutMs: number,
  watchPromise: Promise<void> | null,
): Promise<boolean> {
  const start = Date.now()
  const pollInterval = 100
  let watcherDied = false

  // Detect early watcher exit so we fail fast instead of waiting full timeout
  if (watchPromise) {
    watchPromise.then(
      () => {
        watcherDied = true
      },
      () => {
        watcherDied = true
      },
    )
  }

  while (Date.now() - start < timeoutMs) {
    if (watcherDied) {
      return false // Watcher exited — no point waiting further
    }
    if (guard.policyVersion != null) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval))
  }

  // Final check: assignment may have arrived during the last sleep
  return guard.policyVersion != null
}

// ---------------------------------------------------------------------------
// Internal: cleanup
// ---------------------------------------------------------------------------

async function _cleanupResources(
  watchAbort: AbortController | null,
  watchPromise: Promise<void> | null,
  contractSource: ServerRuleSource | null,
  auditSink: AuditSink,
  client: EdictumServerClient,
): Promise<void> {
  if (watchAbort) {
    watchAbort.abort()
  }
  if (contractSource) {
    await contractSource.close()
  }

  if (watchPromise) {
    try {
      await watchPromise
    } catch {
      // Ignore errors during shutdown
    }
  }

  if ('close' in auditSink && typeof auditSink.close === 'function') {
    try {
      await (auditSink as { close(): Promise<void> }).close()
    } catch (err) {
      console.warn(
        '[edictum] WARNING: Failed to flush audit sink on shutdown. Some events may have been lost.',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  await client.close()
}
