/**
 * Async HTTP client for edictum-server.
 *
 * SIZE APPROVAL: This file exceeds 200 lines. It mirrors Python's client.py
 * (210 LOC). TLS enforcement, identifier validation, tag validation, and
 * retry logic form a single cohesive HTTP client.
 */

// Safe identifier: alphanumeric, hyphens, underscores, dots. No path separators,
// control chars, or whitespace. Matches tool_name validation in envelope.
export const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Raised when the server returns an error response. */
export class EdictumServerError extends Error {
  readonly statusCode: number;
  readonly detail: string;

  constructor(statusCode: number, detail: string) {
    super(`HTTP ${statusCode}: ${detail}`);
    this.name = "EdictumServerError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

export interface EdictumServerClientOptions {
  baseUrl: string;
  apiKey: string;
  agentId?: string;
  env?: string;
  bundleName?: string | null;
  tags?: Record<string, string> | null;
  timeout?: number;
  maxRetries?: number;
  allowInsecure?: boolean;
}

/**
 * Async HTTP client for the edictum-server API.
 *
 * Handles auth (Bearer API key), retries, and connection management.
 */
export class EdictumServerClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly agentId: string;
  readonly env: string;
  readonly bundleName: string | null;
  readonly tags: Record<string, string> | null;
  readonly timeout: number;
  readonly maxRetries: number;

  constructor(options: EdictumServerClientOptions) {
    const {
      baseUrl,
      apiKey,
      agentId = "default",
      env = "production",
      bundleName = null,
      tags = null,
      timeout = 30_000,
      maxRetries = 3,
      allowInsecure = false,
    } = options;

    // Validate identifiers
    for (const [name, value] of [
      ["agentId", agentId],
      ["env", env],
    ] as const) {
      if (!SAFE_IDENTIFIER_RE.test(value)) {
        throw new ValueError(
          `Invalid ${name}: ${JSON.stringify(value)}. Must be 1-128 alphanumeric chars, hyphens, underscores, or dots.`,
        );
      }
    }

    if (bundleName !== null && !SAFE_IDENTIFIER_RE.test(bundleName)) {
      throw new ValueError(
        `Invalid bundleName: ${JSON.stringify(bundleName)}. Must be 1-128 alphanumeric chars, hyphens, underscores, or dots.`,
      );
    }

    if (tags !== null) {
      const entries = Object.entries(tags);
      if (entries.length > 64) {
        throw new ValueError(
          `Too many tags (${entries.length} > 64); maximum is 64 entries`,
        );
      }
      for (const [k, v] of entries) {
        if (typeof k !== "string" || typeof v !== "string") {
          throw new ValueError(
            `Tag keys and values must be strings, got ${typeof k}=${typeof v}`,
          );
        }
        if (k.length > 128) {
          throw new ValueError(
            `Tag key too long (${k.length} > 128): ${JSON.stringify(k)}`,
          );
        }
        if (v.length > 256) {
          throw new ValueError(
            `Tag value too long (${v.length} > 256) for key ${JSON.stringify(k)}`,
          );
        }
      }
    }

    // TLS enforcement: refuse plaintext HTTP to non-loopback hosts
    const url = new URL(baseUrl);
    if (url.protocol === "http:") {
      const host = url.hostname;
      // URL spec wraps IPv6 in brackets: new URL("http://[::1]").hostname === "[::1]"
      const isLoopback =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]";
      if (!isLoopback) {
        if (!allowInsecure) {
          throw new ValueError(
            `Refusing plaintext HTTP connection to ${host}. ` +
              `Use HTTPS or pass allowInsecure: true for non-production use.`,
          );
        }
        // Warning: credentials will be transmitted unencrypted
      }
    }

    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.env = env;
    this.bundleName = bundleName;
    this.tags = tags;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
  }

  private _headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "X-Edictum-Agent-Id": this.agentId,
      "Content-Type": "application/json",
    };
  }

  /** Send a GET request with retry logic. */
  async get(
    path: string,
    params?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this._request("GET", path, { params });
  }

  /** Send a POST request with retry logic. */
  async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._request("POST", path, { body });
  }

  /** Send a PUT request with retry logic. */
  async put(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._request("PUT", path, { body });
  }

  /** Send a DELETE request with retry logic. */
  async delete(path: string): Promise<Record<string, unknown>> {
    return this._request("DELETE", path);
  }

  /** Execute an HTTP request with exponential backoff retry for 5xx errors. */
  private async _request(
    method: string,
    path: string,
    options?: {
      params?: Record<string, string>;
      body?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        let url = `${this.baseUrl}${path}`;
        if (options?.params) {
          const searchParams = new URLSearchParams(options.params);
          url += `?${searchParams.toString()}`;
        }

        const fetchOptions: RequestInit = {
          method,
          headers: this._headers(),
          signal: AbortSignal.timeout(this.timeout),
        };

        if (options?.body !== undefined) {
          fetchOptions.body = JSON.stringify(options.body);
        }

        const response = await fetch(url, fetchOptions);

        if (response.status >= 500) {
          lastError = new EdictumServerError(
            response.status,
            await response.text(),
          );
          if (attempt < this.maxRetries - 1) {
            const delay = 2 ** attempt * 500;
            await sleep(delay);
            continue;
          }
          throw lastError;
        }

        if (response.status >= 400) {
          throw new EdictumServerError(
            response.status,
            await response.text(),
          );
        }

        return (await response.json()) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof EdictumServerError) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries - 1) {
          const delay = 2 ** attempt * 500;
          await sleep(delay);
          continue;
        }
        throw lastError;
      }
    }

    throw lastError!;
  }

  /**
   * Make a raw fetch request (for SSE streaming).
   * No retry logic — caller handles reconnection.
   */
  async rawFetch(
    path: string,
    params?: Record<string, string>,
  ): Promise<Response> {
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }
    return fetch(url, {
      method: "GET",
      headers: this._headers(),
    });
  }

  /** Close this client (no-op for fetch-based client, kept for API parity). */
  async close(): Promise<void> {
    // Native fetch() doesn't require explicit connection cleanup.
  }
}

/** ValueError for input validation errors (matches Python ValueError semantics). */
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
