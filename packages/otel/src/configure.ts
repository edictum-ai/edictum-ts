/**
 * configureOtel — one-call OTel setup for Edictum.
 *
 * Call once at startup. No-op if a TracerProvider is already registered
 * (unless `force` is true). Sets up TracerProvider + MeterProvider.
 *
 * Env var precedence: OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT,
 * OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_RESOURCE_ATTRIBUTES all override
 * their corresponding option arguments. OTEL_SERVICE_NAME always wins
 * over service.name in OTEL_RESOURCE_ATTRIBUTES (per OTel spec).
 *
 * TLS is inferred from the endpoint URL scheme (http:// vs https://).
 *
 * Required: @opentelemetry/api, /resources, /sdk-trace-base,
 * /sdk-metrics, plus exporter-trace-otlp-grpc or -http.
 */

import { EdictumConfigError } from '@edictum/core'
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'

import { CONTROL_CHAR_PATTERN, VALID_PROTOCOLS, sanitize } from './sanitize.js'
import type { OtelProtocol } from './sanitize.js'

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

  // Env overrides — sanitize all string inputs
  const actualService = sanitize(process.env['OTEL_SERVICE_NAME'] ?? serviceName)
  const actualEndpoint = (process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? endpoint).slice(0, 10_000)

  // Validate endpoint scheme — only http:// and https:// are safe
  try {
    const scheme = new URL(actualEndpoint).protocol
    if (scheme !== 'http:' && scheme !== 'https:') {
      throw new EdictumConfigError(
        `Invalid OTel endpoint scheme: ${JSON.stringify(scheme)}. Must be http:// or https://`,
      )
    }
  } catch (e) {
    if (e instanceof EdictumConfigError) throw e
    throw new EdictumConfigError(`Invalid OTel endpoint URL: ${JSON.stringify(actualEndpoint)}`)
  }
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
    // Sanitize caller-supplied attribute keys and values
    for (const [k, v] of Object.entries(resourceAttributes)) {
      const sk = sanitize(k, 1000)
      if (!sk) continue
      attrs[sk] = sanitize(v, 10_000)
    }
  }
  // serviceName (or its env override) always wins over resourceAttributes
  attrs['service.name'] = actualService
  if (edictumVersion) {
    attrs['edictum.version'] = sanitize(edictumVersion)
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
        if (CONTROL_CHAR_PATTERN.test(k) || CONTROL_CHAR_PATTERN.test(v)) continue
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
