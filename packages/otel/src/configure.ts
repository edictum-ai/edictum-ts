/**
 * configureOtel — one-call OTel setup for Edictum.
 *
 * Call once at startup. If a TracerProvider is already configured (e.g. by
 * the host application), this is a no-op unless `force` is true.
 *
 * Standard OTel env vars take precedence over arguments:
 * - OTEL_SERVICE_NAME overrides `serviceName`
 * - OTEL_EXPORTER_OTLP_ENDPOINT overrides `endpoint`
 * - OTEL_EXPORTER_OTLP_PROTOCOL overrides `protocol`
 * - OTEL_RESOURCE_ATTRIBUTES merged with `resourceAttributes`
 */

import { trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export interface ConfigureOtelOptions {
  /** Service name reported in traces. Default: "edictum-agent" */
  serviceName?: string;
  /** Collector endpoint. Default: "http://localhost:4317" */
  endpoint?: string;
  /** Export protocol: "grpc" | "http" | "http/protobuf". Default: "grpc" */
  protocol?: string;
  /** Extra resource attributes merged into the Resource. */
  resourceAttributes?: Record<string, string>;
  /** Edictum version to include as `edictum.version` attribute. */
  edictumVersion?: string;
  /** Override an existing provider. Default: false */
  force?: boolean;
  /** Use plaintext for gRPC. Default: true. No effect on HTTP. */
  insecure?: boolean;
}

/** Check whether a non-proxy TracerProvider is already set. */
function isProviderConfigured(): boolean {
  const current = trace.getTracerProvider();
  return current instanceof BasicTracerProvider;
}

export async function configureOtel(
  options: ConfigureOtelOptions = {},
): Promise<void> {
  const {
    serviceName = "edictum-agent",
    endpoint = "http://localhost:4317",
    protocol = "grpc",
    resourceAttributes,
    edictumVersion,
    force = false,
    // `insecure` is accepted for API parity with Python but has no effect
    // in the JS OTel SDK — use http:// vs https:// in the endpoint instead.
  } = options;

  if (isProviderConfigured() && !force) {
    return;
  }

  // Env overrides
  const actualService =
    process.env["OTEL_SERVICE_NAME"] ?? serviceName;
  const actualEndpoint =
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? endpoint;
  const actualProtocol =
    process.env["OTEL_EXPORTER_OTLP_PROTOCOL"] ?? protocol;

  // "http/protobuf" and "http" both select HTTP exporter
  const useGrpc = actualProtocol === "grpc";

  // Adjust default endpoint for HTTP when the caller didn't override
  let resolvedEndpoint = actualEndpoint;
  if (!useGrpc && actualEndpoint === "http://localhost:4317") {
    resolvedEndpoint = "http://localhost:4318/v1/traces";
  }

  // Build resource attributes — env OTEL_RESOURCE_ATTRIBUTES merged last
  const attrs: Record<string, string> = {
    "service.name": actualService,
  };
  if (edictumVersion) {
    attrs["edictum.version"] = edictumVersion;
  }
  if (resourceAttributes) {
    Object.assign(attrs, resourceAttributes);
  }

  const envAttrs = process.env["OTEL_RESOURCE_ATTRIBUTES"] ?? "";
  if (envAttrs) {
    for (const pair of envAttrs.split(",")) {
      if (pair.includes("=")) {
        const eqIdx = pair.indexOf("=");
        const k = pair.slice(0, eqIdx).trim();
        const v = pair.slice(eqIdx + 1).trim();
        if (k) {
          attrs[k] = v;
        }
      }
    }
  }

  const resource = new Resource(attrs);
  const provider = new BasicTracerProvider({ resource });

  if (useGrpc) {
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-grpc"
    );
    // In the JS OTel SDK, the gRPC exporter infers TLS from the URL scheme:
    // http:// = plaintext (insecure), https:// = TLS.
    // The `insecure` option controls the Python exporter but has no direct
    // equivalent here. If insecure=false, callers should use https:// in the endpoint.
    const exporter = new OTLPTraceExporter({
      url: resolvedEndpoint,
    });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  } else {
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    );
    const exporter = new OTLPTraceExporter({
      url: resolvedEndpoint,
    });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  }

  provider.register();
}
