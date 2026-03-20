/**
 * Server guard factory — connects an Edictum guard to edictum-console.
 *
 * This is the TypeScript equivalent of Python's Edictum.from_server().
 * It lives in @edictum/server (not @edictum/core) because core has zero
 * runtime deps and cannot import server classes.
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's
 * _server_factory.py (228 LOC) — validation, bundle fetch, SSE watcher
 * startup, assignment waiting, and cleanup form a cohesive factory.
 */

import {
  Edictum,
  EdictumConfigError,
  compileContracts,
  loadBundleString,
} from "@edictum/core";
import type {
  AuditSink,
  ApprovalBackend,
  StorageBackend,
  Principal,
  ToolEnvelope,
} from "@edictum/core";

import { EdictumServerClient, SAFE_IDENTIFIER_RE, _setClientBundleName } from "./client.js";
import type { EdictumServerClientOptions } from "./client.js";
import { ServerAuditSink } from "./audit-sink.js";
import { ServerApprovalBackend } from "./approval-backend.js";
import { ServerBackend } from "./backend.js";
import { ServerContractSource } from "./contract-source.js";
import { verifyBundleSignature } from "./verification.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback for SSE watcher errors (signature rejections, parse failures). */
export type WatchErrorHandler = (error: {
  readonly type: "signature_rejected" | "parse_error" | "fetch_error";
  readonly message: string;
  readonly bundleName?: string;
}) => void;

/** Options for createServerGuard(). */
export interface CreateServerGuardOptions {
  /** Base URL of the edictum-console server. */
  readonly url: string;
  /** API key for authentication. */
  readonly apiKey: string;
  /** Agent identifier registered with the server. */
  readonly agentId: string;
  /** Environment name (default: "production"). */
  readonly environment?: string;
  /** Named bundle to fetch. If null, waits for server assignment. */
  readonly bundleName?: string | null;
  /** Tags for server-side filtering. */
  readonly tags?: Record<string, string> | null;
  /** Override audit sink (default: ServerAuditSink). */
  readonly auditSink?: AuditSink;
  /** Override approval backend (default: ServerApprovalBackend). */
  readonly approvalBackend?: ApprovalBackend;
  /** Override storage backend (default: ServerBackend). */
  readonly storageBackend?: StorageBackend;
  /** Guard mode. If omitted, uses bundle's defaults.mode (default: "enforce"). */
  readonly mode?: "enforce" | "observe";
  /** Callback on tool denial. */
  readonly onDeny?: (
    envelope: ToolEnvelope,
    reason: string,
    source: string | null,
  ) => void;
  /** Callback on tool approval. */
  readonly onAllow?: (envelope: ToolEnvelope) => void;
  /** Custom success check for tool results. */
  readonly successCheck?: (toolName: string, result: unknown) => boolean;
  /** Default principal for all evaluations. */
  readonly principal?: Principal;
  /** Resolve principal from tool call context. */
  readonly principalResolver?: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Principal;
  /** Auto-start SSE watcher for hot-reload (default: true). */
  readonly autoWatch?: boolean;
  /** Allow plaintext HTTP to non-loopback hosts (default: false). */
  readonly allowInsecure?: boolean;
  /** Verify Ed25519 signatures on bundles (default: false). */
  readonly verifySignatures?: boolean;
  /** Ed25519 public key (hex) for signature verification. */
  readonly signingPublicKey?: string | null;
  /** HTTP client timeout in ms (default: 30_000). */
  readonly timeout?: number;
  /** HTTP max retries (default: 3). */
  readonly maxRetries?: number;
  /** Timeout for waiting for server assignment in ms (default: 30_000). */
  readonly assignmentTimeout?: number;
  /** Callback for SSE watcher errors (signature rejections, parse failures). */
  readonly onWatchError?: WatchErrorHandler;
}

/** Read-only view of the server client exposed via ServerGuard. */
export interface ServerGuardClient {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly env: string;
  readonly bundleName: string | null;
  readonly tags: Readonly<Record<string, string>> | null;
  readonly timeout: number;
  readonly maxRetries: number;
}

/** A server-connected guard with lifecycle management. */
export interface ServerGuard {
  /** The configured Edictum guard. */
  readonly guard: Edictum;
  /** Read-only view of the server client (updateBundleName not exposed). */
  readonly client: ServerGuardClient;
  /** Stop SSE watcher, flush audit events, close connections. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ASSIGNMENT_TIMEOUT_MS = 30_000;

/**
 * Max base64-encoded bundle size (682 KB ≈ 512 KB decoded).
 * Guards against unbounded memory allocation from a malicious server.
 * loadBundleString() applies its own MAX_BUNDLE_SIZE check on the decoded
 * YAML, but we reject oversized base64 before allocating the decode buffer.
 */
const MAX_BUNDLE_B64_LENGTH = Math.ceil(512 * 1024 * 4 / 3);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Edictum guard connected to edictum-console.
 *
 * This is the TypeScript equivalent of Python's `Edictum.from_server()`.
 * It creates an HTTP client, fetches initial contracts, starts an SSE
 * watcher for hot-reload, and wires up audit and approval backends.
 *
 * @example
 * ```ts
 * const { guard, close } = await createServerGuard({
 *   url: "https://console.edictum.ai",
 *   apiKey: "ed_live_...",
 *   agentId: "my-agent",
 *   bundleName: "production-contracts",
 * });
 *
 * // Use the guard
 * const result = await guard.run("Bash", { command: "ls" }, execFn);
 *
 * // Cleanup
 * await close();
 * ```
 */
export async function createServerGuard(
  options: CreateServerGuardOptions,
): Promise<ServerGuard> {
  const {
    url,
    apiKey,
    agentId,
    environment = "production",
    bundleName = null,
    tags = null,
    autoWatch = true,
    verifySignatures = false,
    signingPublicKey = null,
    assignmentTimeout = DEFAULT_ASSIGNMENT_TIMEOUT_MS,
    onWatchError,
  } = options;

  // Do NOT destructure `mode` with a default — undefined means
  // "use the bundle's defaults.mode", falling back to "enforce".
  const explicitMode = options.mode;

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  if (bundleName == null && !autoWatch) {
    throw new EdictumConfigError(
      "bundleName is required when autoWatch is false. " +
        "Without a named bundle and no SSE watcher, the guard has no contracts.",
    );
  }

  if (verifySignatures && !signingPublicKey) {
    throw new EdictumConfigError(
      "signingPublicKey is required when verifySignatures is true",
    );
  }

  if (!Number.isFinite(assignmentTimeout) || assignmentTimeout <= 0) {
    throw new EdictumConfigError(
      `assignmentTimeout must be a positive finite number, got ${assignmentTimeout}`,
    );
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
  };
  if (options.timeout !== undefined) clientOpts.timeout = options.timeout;
  if (options.maxRetries !== undefined) clientOpts.maxRetries = options.maxRetries;

  const client = new EdictumServerClient(clientOpts);

  // -----------------------------------------------------------------------
  // Create backends (use provided or server-backed defaults)
  // -----------------------------------------------------------------------

  const auditSink = options.auditSink ?? new ServerAuditSink(client);
  const approvalBackend =
    options.approvalBackend ?? new ServerApprovalBackend(client);
  const storageBackend = options.storageBackend ?? new ServerBackend(client);

  // -----------------------------------------------------------------------
  // SSE watcher state
  // -----------------------------------------------------------------------

  let contractSource: ServerContractSource | null = null;
  let watchAbort: AbortController | null = null;
  let watchPromise: Promise<void> | null = null;

  // -----------------------------------------------------------------------
  // Build guard — two paths based on bundleName
  // -----------------------------------------------------------------------

  let guard: Edictum;

  try {
    if (bundleName != null) {
      // Path A: Named bundle — fetch initial contracts from server
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
      );
    } else {
      // Path B: Server-assigned — create empty guard, wait for assignment
      guard = new Edictum({
        environment,
        mode: explicitMode ?? "enforce",
        contracts: [],
        auditSink,
        approvalBackend,
        backend: storageBackend,
        onDeny: options.onDeny,
        onAllow: options.onAllow,
        successCheck: options.successCheck,
        principal: options.principal,
        principalResolver: options.principalResolver,
      });
    }

    // -------------------------------------------------------------------
    // Start SSE watcher for hot-reload
    // -------------------------------------------------------------------

    if (autoWatch) {
      contractSource = new ServerContractSource(client);
      watchAbort = new AbortController();
      watchPromise = _startSseWatcher(
        guard,
        client,
        contractSource,
        verifySignatures,
        signingPublicKey,
        watchAbort.signal,
        onWatchError ?? null,
      );
    }

    // -------------------------------------------------------------------
    // Wait for server assignment if no bundle name
    // -------------------------------------------------------------------

    if (bundleName == null) {
      const assigned = await _waitForAssignment(
        guard,
        assignmentTimeout,
      );
      if (!assigned) {
        throw new EdictumConfigError(
          `Timed out waiting for server assignment after ${assignmentTimeout}ms. ` +
            "Ensure the server has an active assignment for this agent.",
        );
      }
    }
  } catch (err) {
    await _cleanupResources(
      watchAbort,
      watchPromise,
      contractSource,
      auditSink,
      client,
    );
    throw err;
  }

  // -----------------------------------------------------------------------
  // Return ServerGuard with lifecycle management
  // -----------------------------------------------------------------------

  let closed = false;
  return {
    guard,
    client,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await _cleanupResources(
        watchAbort,
        watchPromise,
        contractSource,
        auditSink,
        client,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: decode and validate base64 YAML bundle
// ---------------------------------------------------------------------------

function _decodeYamlB64(yamlB64: string): Uint8Array {
  if (yamlB64.length > MAX_BUNDLE_B64_LENGTH) {
    throw new EdictumConfigError(
      `Bundle yaml_bytes exceeds maximum size (base64 length ${yamlB64.length} > ${MAX_BUNDLE_B64_LENGTH})`,
    );
  }
  return Buffer.from(yamlB64, "base64");
}

// ---------------------------------------------------------------------------
// Internal: fetch bundle and build guard
// ---------------------------------------------------------------------------

async function _fetchAndBuildGuard(
  client: EdictumServerClient,
  bundleName: string,
  environment: string,
  explicitMode: "enforce" | "observe" | undefined,
  verifySignatures: boolean,
  signingPublicKey: string | null,
  auditSink: AuditSink,
  approvalBackend: ApprovalBackend,
  storageBackend: StorageBackend,
  options: CreateServerGuardOptions,
): Promise<Edictum> {
  const params: Record<string, string> = { env: environment };
  const response = await client.get(
    `/api/v1/bundles/${encodeURIComponent(bundleName)}/current`,
    params,
  );

  const yamlB64 = response["yaml_bytes"];
  if (typeof yamlB64 !== "string") {
    throw new EdictumConfigError(
      "Server response missing 'yaml_bytes' field",
    );
  }

  const yamlBytes = _decodeYamlB64(yamlB64);

  // Verify signature if required
  if (verifySignatures) {
    const signature = response["signature"];
    if (typeof signature !== "string" || signature.length === 0) {
      throw new EdictumConfigError(
        "Bundle signature missing but verifySignatures is enabled",
      );
    }
    verifyBundleSignature(yamlBytes, signature, signingPublicKey as string);
  }

  // Compile contracts
  const yamlContent = new TextDecoder().decode(yamlBytes);
  const [bundleData, bundleHash] = loadBundleString(yamlContent);
  const compiled = compileContracts(bundleData);

  // Prefer explicit mode, fall back to bundle's defaults.mode
  const effectiveMode = explicitMode ?? compiled.defaultMode ?? "enforce";

  const allContracts = [
    ...compiled.preconditions,
    ...compiled.postconditions,
    ...compiled.sessionContracts,
    ...compiled.sandboxContracts,
  ];

  // Merge YAML tools
  const tools: Record<string, { side_effect?: string; idempotent?: boolean }> =
    {};
  for (const [name, cfg] of Object.entries(compiled.tools)) {
    tools[name] = cfg as { side_effect?: string; idempotent?: boolean };
  }

  return new Edictum({
    environment,
    mode: effectiveMode as "enforce" | "observe",
    limits: compiled.limits,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    // Cast note: compiled contracts are internal types from the YAML engine
    // that satisfy the Edictum constructor's union type. The same cast is
    // used in core/factory.ts — no public union type exists yet.
    contracts: allContracts as never[],
    auditSink,
    approvalBackend,
    backend: storageBackend,
    policyVersion: bundleHash.hex,
    onDeny: options.onDeny,
    onAllow: options.onAllow,
    successCheck: options.successCheck,
    principal: options.principal,
    principalResolver: options.principalResolver,
  });
}

// ---------------------------------------------------------------------------
// Internal: SSE watcher
// ---------------------------------------------------------------------------

async function _startSseWatcher(
  guard: Edictum,
  client: EdictumServerClient,
  source: ServerContractSource,
  verifySignatures: boolean,
  signingPublicKey: string | null,
  signal: AbortSignal,
  onWatchError: WatchErrorHandler | null,
): Promise<void> {
  try {
    await source.connect();
    for await (const bundle of source.watch()) {
      if (signal.aborted) return;

      try {
        let yamlContent: string;
        let newBundleName: string | null = null;

        if (bundle["_assignment_changed"] === true) {
          // Assignment changed — fetch the new bundle
          // Inline validation: _processEvent already validates, but we
          // guard here to avoid implicit cross-file safety dependency.
          const rawName = bundle["bundle_name"];
          if (typeof rawName !== "string" || !SAFE_IDENTIFIER_RE.test(rawName)) {
            onWatchError?.({ type: "parse_error", message: "Invalid bundle_name in assignment_changed event" });
            continue;
          }
          newBundleName = rawName;

          // Fetch new bundle — network errors are fetch_error, not parse_error
          let response: Record<string, unknown>;
          try {
            response = await client.get(
              `/api/v1/bundles/${encodeURIComponent(newBundleName)}/current`,
              { env: client.env },
            );
          } catch (err) {
            onWatchError?.({ type: "fetch_error", message: err instanceof Error ? err.message : String(err), bundleName: newBundleName });
            continue;
          }

          const yamlB64 = response["yaml_bytes"];
          if (typeof yamlB64 !== "string") {
            onWatchError?.({ type: "parse_error", message: "Bundle response missing 'yaml_bytes' field", bundleName: newBundleName });
            continue;
          }

          let yamlBytes: Uint8Array;
          try {
            yamlBytes = _decodeYamlB64(yamlB64);
          } catch {
            onWatchError?.({ type: "parse_error", message: "Bundle exceeds maximum size", bundleName: newBundleName });
            continue;
          }

          if (verifySignatures) {
            const signature = response["signature"];
            if (typeof signature !== "string" || signature.length === 0) {
              onWatchError?.({ type: "signature_rejected", message: "Bundle signature missing", bundleName: newBundleName });
              continue;
            }
            try {
              verifyBundleSignature(yamlBytes, signature, signingPublicKey as string);
            } catch (err) {
              onWatchError?.({ type: "signature_rejected", message: err instanceof Error ? err.message : String(err), bundleName: newBundleName });
              continue;
            }
          }

          yamlContent = new TextDecoder().decode(yamlBytes);
        } else {
          // Contract update — extract YAML from SSE payload
          const yamlB64 = bundle["yaml_bytes"];
          if (typeof yamlB64 !== "string") {
            onWatchError?.({ type: "parse_error", message: "SSE bundle payload missing 'yaml_bytes' field" });
            continue;
          }

          let yamlBytes: Uint8Array;
          try {
            yamlBytes = _decodeYamlB64(yamlB64);
          } catch {
            onWatchError?.({ type: "parse_error", message: "Bundle exceeds maximum size" });
            continue;
          }

          if (verifySignatures) {
            const signature = bundle["signature"];
            if (typeof signature !== "string" || signature.length === 0) {
              onWatchError?.({ type: "signature_rejected", message: "Bundle signature missing" });
              continue;
            }
            try {
              verifyBundleSignature(yamlBytes, signature, signingPublicKey as string);
            } catch (err) {
              onWatchError?.({ type: "signature_rejected", message: err instanceof Error ? err.message : String(err) });
              continue;
            }
          }

          yamlContent = new TextDecoder().decode(yamlBytes);
        }

        guard.reload(yamlContent);

        // Update bundle name only after reload succeeds — keeps client
        // state consistent with what the guard is actually enforcing.
        if (newBundleName !== null) {
          _setClientBundleName(client, newBundleName);
        }
      } catch (err) {
        onWatchError?.({ type: "parse_error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      onWatchError?.({
        type: "fetch_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: wait for server assignment
// ---------------------------------------------------------------------------

async function _waitForAssignment(
  guard: Edictum,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 100;

  while (Date.now() - start < timeoutMs) {
    if (guard.policyVersion != null) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Final check: assignment may have arrived during the last sleep
  return guard.policyVersion != null;
}

// ---------------------------------------------------------------------------
// Internal: cleanup
// ---------------------------------------------------------------------------

async function _cleanupResources(
  watchAbort: AbortController | null,
  watchPromise: Promise<void> | null,
  contractSource: ServerContractSource | null,
  auditSink: AuditSink,
  client: EdictumServerClient,
): Promise<void> {
  if (watchAbort) {
    watchAbort.abort();
  }
  if (contractSource) {
    await contractSource.close();
  }

  if (watchPromise) {
    try {
      await watchPromise;
    } catch {
      // Ignore errors during shutdown
    }
  }

  if ("close" in auditSink && typeof auditSink.close === "function") {
    try {
      await (auditSink as { close(): Promise<void> }).close();
    } catch {
      // Ignore flush errors during shutdown
    }
  }

  await client.close();
}
