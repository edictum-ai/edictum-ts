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

import { EdictumServerClient } from "./client.js";
import type { EdictumServerClientOptions } from "./client.js";
import { ServerAuditSink } from "./audit-sink.js";
import { ServerApprovalBackend } from "./approval-backend.js";
import { ServerBackend } from "./backend.js";
import { ServerContractSource } from "./contract-source.js";
import { verifyBundleSignature } from "./verification.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** Guard mode (default: "enforce"). */
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
}

/** A server-connected guard with lifecycle management. */
export interface ServerGuard {
  /** The configured Edictum guard. */
  readonly guard: Edictum;
  /** The underlying server client. */
  readonly client: EdictumServerClient;
  /** Stop SSE watcher, flush audit events, close connections. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ASSIGNMENT_TIMEOUT_MS = 30_000;

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
    mode = "enforce",
    autoWatch = true,
    verifySignatures = false,
    signingPublicKey = null,
    assignmentTimeout = DEFAULT_ASSIGNMENT_TIMEOUT_MS,
  } = options;

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

  const contractSource = new ServerContractSource(client);
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
        mode,
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
        mode,
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
      watchAbort = new AbortController();
      watchPromise = _startSseWatcher(
        guard,
        client,
        contractSource,
        verifySignatures,
        signingPublicKey,
        watchAbort.signal,
      );
    }

    // -------------------------------------------------------------------
    // Wait for server assignment if no bundle name
    // -------------------------------------------------------------------

    if (bundleName == null) {
      // The SSE watcher will reload contracts when assignment arrives.
      // Wait for the first reload with a timeout.
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
    // Cleanup on failure
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

  return {
    guard,
    client,
    async close(): Promise<void> {
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
// Internal: fetch bundle and build guard
// ---------------------------------------------------------------------------

async function _fetchAndBuildGuard(
  client: EdictumServerClient,
  bundleName: string,
  environment: string,
  mode: string,
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

  // Decode base64 YAML
  const yamlBytes = Buffer.from(yamlB64, "base64");

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

  const effectiveMode = mode ?? compiled.defaultMode;

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
): Promise<void> {
  await source.connect();

  try {
    for await (const bundle of source.watch()) {
      if (signal.aborted) return;

      try {
        let yamlContent: string;

        if (bundle["_assignment_changed"] === true) {
          // Assignment changed — fetch the new bundle
          const newBundleName = bundle["bundle_name"] as string;
          const params: Record<string, string> = { env: client.env };
          const response = await client.get(
            `/api/v1/bundles/${encodeURIComponent(newBundleName)}/current`,
            params,
          );

          const yamlB64 = response["yaml_bytes"];
          if (typeof yamlB64 !== "string") continue;

          const yamlBytes = Buffer.from(yamlB64, "base64");

          if (verifySignatures) {
            const signature = response["signature"];
            if (typeof signature !== "string" || signature.length === 0) {
              continue; // Skip unsigned bundles when verification required
            }
            try {
              verifyBundleSignature(yamlBytes, signature, signingPublicKey as string);
            } catch {
              continue; // Skip bundles with invalid signatures
            }
          }

          yamlContent = new TextDecoder().decode(yamlBytes);

          // Update the client's effective bundle name.
          // bundleName is readonly on the client, so we use the internal
          // reference stored on the guard. The SSE source tracks it via
          // query params on reconnect.
          (client as { bundleName: string | null }).bundleName = newBundleName;
        } else {
          // Contract update — extract YAML from SSE payload
          const yamlB64 = bundle["yaml_bytes"];
          if (typeof yamlB64 !== "string") continue;

          const yamlBytes = Buffer.from(yamlB64, "base64");

          if (verifySignatures) {
            const signature = bundle["signature"];
            if (typeof signature !== "string" || signature.length === 0) {
              continue;
            }
            try {
              verifyBundleSignature(yamlBytes, signature, signingPublicKey as string);
            } catch {
              continue;
            }
          }

          yamlContent = new TextDecoder().decode(yamlBytes);
        }

        // Atomically reload contracts
        guard.reload(yamlContent);
      } catch {
        // Log but don't crash — keep existing contracts
        // In production, this should use a logger
      }
    }
  } catch {
    if (!signal.aborted) {
      // Unexpected error — SSE watcher died
      // In production, this should use a logger
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: wait for server assignment
// ---------------------------------------------------------------------------

/**
 * Wait for the guard to receive its first contracts via SSE.
 * Returns true if contracts were loaded, false on timeout.
 */
async function _waitForAssignment(
  guard: Edictum,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 100;

  while (Date.now() - start < timeoutMs) {
    // Check if the guard has received contracts (policyVersion is set on reload)
    if (guard.policyVersion != null) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false;
}

// ---------------------------------------------------------------------------
// Internal: cleanup
// ---------------------------------------------------------------------------

async function _cleanupResources(
  watchAbort: AbortController | null,
  watchPromise: Promise<void> | null,
  contractSource: ServerContractSource,
  auditSink: AuditSink,
  client: EdictumServerClient,
): Promise<void> {
  // Stop SSE watcher
  if (watchAbort) {
    watchAbort.abort();
  }
  await contractSource.close();

  // Wait for watcher to finish (it should exit quickly after abort)
  if (watchPromise) {
    try {
      await watchPromise;
    } catch {
      // Ignore errors during shutdown
    }
  }

  // Flush audit events
  if ("close" in auditSink && typeof auditSink.close === "function") {
    try {
      await (auditSink as { close(): Promise<void> }).close();
    } catch {
      // Ignore flush errors during shutdown
    }
  }

  // Close client
  await client.close();
}
