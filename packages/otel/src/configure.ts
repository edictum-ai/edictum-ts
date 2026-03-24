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
 *
 * TLS is controlled by the endpoint URL scheme (http:// = plaintext,
 * https:// = TLS). There is no separate `insecure` flag — unlike
 * Python's gRPC exporter, the JS SDK infers TLS from the URL.
 */

import { ProxyTracerProvider, trace } from "@opentelemetry/api";
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
}

/**
 * Check whether a real (non-proxy) TracerProvider is already set.
 *
 * ProxyTracerProvider is the default no-op delegate. Anything else means
 * the host app (or a prior configureOtel call) has registered a provider.
 */
function isProviderConfigured(): boolean {
  const current = trace.getTracerProvider();
  // ProxyTracerProvider is the default no-op wrapper. Any other type —
  // BasicTracerProvider, NodeTracerProvider, custom — means a real
  // provider has been registered.
  return !(current instanceof ProxyTracerProvider);
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

  // Build resource attributes.
  // Precedence (last wins): resourceAttributes < serviceName/edictumVersion < env vars
  const attrs: Record<string, string> = {};
  if (resourceAttributes) {
    Object.assign(attrs, resourceAttributes);
  }
  // serviceName (or its env override) always wins over resourceAttributes
  attrs["service.name"] = actualService;
  if (edictumVersion) {
    attrs["edictum.version"] = edictumVersion;
  }

  // OTEL_RESOURCE_ATTRIBUTES has highest precedence
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
