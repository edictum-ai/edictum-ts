/**
 * configureOtel — one-call OTel setup for Edictum.
 *
 * Call once at startup. If a TracerProvider is already configured (e.g. by
 * the host application), this is a no-op unless `force` is true.
 *
 * Sets up both a TracerProvider (for spans) and a MeterProvider (for
 * counters like edictum.calls.denied / edictum.calls.allowed).
 *
 * Standard OTel env vars take precedence over arguments:
 * - OTEL_SERVICE_NAME overrides `serviceName`
 * - OTEL_EXPORTER_OTLP_ENDPOINT overrides `endpoint`
 * - OTEL_EXPORTER_OTLP_PROTOCOL overrides `protocol`
 * - OTEL_RESOURCE_ATTRIBUTES merged with `resourceAttributes`
 *   (but `OTEL_SERVICE_NAME` always wins over `service.name` in
 *   `OTEL_RESOURCE_ATTRIBUTES`, per the OTel spec)
 *
 * TLS is controlled by the endpoint URL scheme (http:// = plaintext,
 * https:// = TLS). There is no separate `insecure` flag — unlike
 * Python's gRPC exporter, the JS SDK infers TLS from the URL.
 *
 * Required packages for configureOtel():
 *   @opentelemetry/api
 *   @opentelemetry/resources
 *   @opentelemetry/sdk-trace-base
 *   @opentelemetry/sdk-metrics
 *   @opentelemetry/exporter-trace-otlp-grpc (for protocol "grpc")
 *   @opentelemetry/exporter-trace-otlp-http (for protocol "http"/"http/protobuf")
 *
 * These are NOT required if you only use GovernanceTelemetry/createTelemetry
 * (which need only @opentelemetry/api).
 */

import { EdictumConfigError } from '@edictum/core'
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'

/** Valid export protocols. */
const VALID_PROTOCOLS = ['grpc', 'http', 'http/protobuf'] as const
type OtelProtocol = (typeof VALID_PROTOCOLS)[number]

export interface ConfigureOtelOptions {
  /** Service name reported in traces. Default: "edictum-agent" */
  serviceName?: string
  /** Collector endpoint. Default: "http://localhost:4317" */
  endpoint?: string
  /** Export protocol: "grpc" | "http" | "http/protobuf". Default: "grpc" */
  protocol?: OtelProtocol
  /** Extra resource attributes merged into the Resource. */
  resourceAttributes?: Record<string, string>
  /** Edictum version to include as `edictum.version` attribute. */
  edictumVersion?: string
  /** Override an existing provider. Default: false */
  force?: boolean
}

export async function configureOtel(options: ConfigureOtelOptions = {}): Promise<void> {
  const {
    serviceName = 'edictum-agent',
    endpoint = 'http://localhost:4317',
    protocol = 'grpc',
    resourceAttributes,
    edictumVersion,
    force = false,
  } = options

  // All imports are dynamic so that importing @edictum/otel does not crash
  // when the SDK packages are not installed. Only configureOtel() needs them.
  const { ProxyTracerProvider, trace, metrics } = await import('@opentelemetry/api')
  const { Resource } = await import('@opentelemetry/resources')
  const { BasicTracerProvider, BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base')

  // Check if a real provider is already set
  const current = trace.getTracerProvider()
  const isConfigured = !(current instanceof ProxyTracerProvider)
  if (isConfigured && !force) {
    return
  }

  // Env overrides
  const actualService = (process.env['OTEL_SERVICE_NAME'] ?? serviceName).slice(0, 10_000)
  const actualEndpoint = (process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? endpoint).slice(0, 10_000)
  const rawProtocol = process.env['OTEL_EXPORTER_OTLP_PROTOCOL'] ?? protocol

  // Validate protocol
  const validSet: ReadonlySet<string> = new Set(VALID_PROTOCOLS)
  if (!validSet.has(rawProtocol)) {
    throw new EdictumConfigError(
      `Invalid OTel protocol: ${JSON.stringify(rawProtocol)}. ` +
        `Must be one of: ${VALID_PROTOCOLS.join(', ')}`,
    )
  }
  const actualProtocol = rawProtocol as OtelProtocol

  // "http/protobuf" and "http" both select HTTP exporter
  const useGrpc = actualProtocol === 'grpc'

  // Adjust default endpoint for HTTP when the caller didn't override.
  // Normalize via URL to handle trailing slashes and case differences.
  const DEFAULT_GRPC_ORIGIN = 'http://localhost:4317'
  const isDefaultEndpoint = (() => {
    try {
      return (
        new URL(actualEndpoint).origin === new URL(DEFAULT_GRPC_ORIGIN).origin &&
        new URL(actualEndpoint).pathname.replace(/\/$/, '') === ''
      )
    } catch {
      return false
    }
  })()

  let resolvedEndpoint = actualEndpoint
  if (!useGrpc && isDefaultEndpoint) {
    resolvedEndpoint = 'http://localhost:4318/v1/traces'
  }

  // Build resource attributes.
  // Precedence: resourceAttributes < serviceName/edictumVersion < env vars
  // Exception: OTEL_SERVICE_NAME always wins over service.name in
  // OTEL_RESOURCE_ATTRIBUTES (per OTel spec).
  const attrs: Record<string, string> = {}
  if (resourceAttributes) {
    Object.assign(attrs, resourceAttributes)
  }
  // serviceName (or its env override) always wins over resourceAttributes
  attrs['service.name'] = actualService
  if (edictumVersion) {
    attrs['edictum.version'] = edictumVersion
  }

  // OTEL_RESOURCE_ATTRIBUTES — highest precedence for all keys EXCEPT
  // service.name when OTEL_SERVICE_NAME is explicitly set.
  const envServiceNameSet = process.env['OTEL_SERVICE_NAME'] !== undefined
  // Cap env input per CLAUDE.md input validation policy
  const envAttrs = (process.env['OTEL_RESOURCE_ATTRIBUTES'] ?? '').slice(0, 10_000)
  if (envAttrs) {
    for (const pair of envAttrs.split(',')) {
      if (pair.includes('=')) {
        const eqIdx = pair.indexOf('=')
        const k = pair.slice(0, eqIdx).trim()
        const v = pair.slice(eqIdx + 1).trim()
        if (!k) continue
        // Skip keys/values with control characters to prevent injection
        const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/
        if (CONTROL_CHAR_RE.test(k) || CONTROL_CHAR_RE.test(v)) continue
        // OTEL_SERVICE_NAME takes precedence per OTel spec
        if (k === 'service.name' && envServiceNameSet) continue
        attrs[k] = v
      }
    }
  }

  const resource = new Resource(attrs)

  // --- Tracer Provider ---
  const provider = new BasicTracerProvider({ resource })

  if (useGrpc) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc')
    const exporter = new OTLPTraceExporter({
      url: resolvedEndpoint,
    })
    provider.addSpanProcessor(new BatchSpanProcessor(exporter))
  } else {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
    const exporter = new OTLPTraceExporter({
      url: resolvedEndpoint,
    })
    provider.addSpanProcessor(new BatchSpanProcessor(exporter))
  }

  provider.register()

  // --- Meter Provider ---
  const { MeterProvider, PeriodicExportingMetricReader } =
    await import('@opentelemetry/sdk-metrics')

  // Adjust default metrics endpoint for HTTP — mirror the trace endpoint logic
  let metricsEndpoint = actualEndpoint
  if (!useGrpc && isDefaultEndpoint) {
    metricsEndpoint = 'http://localhost:4318/v1/metrics'
  }

  let metricExporter: PushMetricExporter
  if (useGrpc) {
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-grpc')
    metricExporter = new OTLPMetricExporter({ url: metricsEndpoint })
  } else {
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http')
    metricExporter = new OTLPMetricExporter({ url: metricsEndpoint })
  }

  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: metricExporter })],
  })
  metrics.setGlobalMeterProvider(meterProvider)
}
