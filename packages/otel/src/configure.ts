/** configureOtel — one-call OTel setup (TracerProvider + MeterProvider). */

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

  // Check if a real tracer provider is already set.
  // Only the TracerProvider guard uses this — MeterProvider is always set up
  // so that callers who pre-register tracing still get Edictum metrics.
  const current = trace.getTracerProvider()
  const tracerAlreadyConfigured = !(current instanceof ProxyTracerProvider)

  // Env overrides — sanitize all string inputs
  const actualService = sanitize(process.env['OTEL_SERVICE_NAME'] ?? serviceName)
  const rawEndpoint = (process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? endpoint).slice(0, 10_000)

  // Reject endpoints with control chars — fail-closed rather than silently rewriting
  if (CONTROL_CHAR_PATTERN.test(rawEndpoint)) {
    throw new EdictumConfigError(
      `OTel endpoint contains control characters: ${JSON.stringify(rawEndpoint.slice(0, 200))}`,
    )
  }
  const actualEndpoint = rawEndpoint

  // Validate endpoint scheme — only http:// and https:// are safe
  try {
    const scheme = new URL(actualEndpoint).protocol
    if (scheme !== 'http:' && scheme !== 'https:') {
      throw new EdictumConfigError(
        `Invalid OTel endpoint scheme: ${JSON.stringify(scheme.slice(0, 50))}. Must be http:// or https://`,
      )
    }
  } catch (e) {
    if (e instanceof EdictumConfigError) throw e
    throw new EdictumConfigError(
      `Invalid OTel endpoint URL: ${JSON.stringify(actualEndpoint.slice(0, 200))}`,
    )
  }
  const rawProtocol = (process.env['OTEL_EXPORTER_OTLP_PROTOCOL'] ?? protocol).slice(0, 100)

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
        const k = sanitize(pair.slice(0, eqIdx).trim(), 1000)
        const v = sanitize(pair.slice(eqIdx + 1).trim(), 10_000)
        if (!k) continue
        // OTEL_SERVICE_NAME takes precedence per OTel spec
        if (k === 'service.name' && envServiceNameSet) continue
        attrs[k] = v
      }
    }
  }

  const resource = new Resource(attrs)

  // --- Tracer Provider (skip if already configured, unless force) ---
  if (!tracerAlreadyConfigured || force) {
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
  }

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
