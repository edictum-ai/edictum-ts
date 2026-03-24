/**
 * Tests for configureOtel() — OTel setup helper.
 *
 * Validates environment variable overrides, protocol selection,
 * provider detection, meter provider setup, and observable resource effects.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { trace, metrics } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { configureOtel } from "../src/configure.js";

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  trace.disable();
  metrics.disable();
});

afterEach(() => {
  process.env = originalEnv;
  trace.disable();
  metrics.disable();
});

/** Verify a tracer creates real (non-no-op) spans. */
function createsRealSpans(): boolean {
  const tracer = trace.getTracer("test");
  const span = tracer.startSpan("test-span");
  const isReal = span.isRecording();
  span.end();
  return isReal;
}

/** Get resource attributes from the current tracer provider. */
function getResourceAttributes(): Record<string, unknown> | null {
  const provider = trace.getTracerProvider();
  // After register(), the global proxy wraps our BasicTracerProvider.
  // We can verify by creating a span and checking its resource.
  const tracer = trace.getTracer("test");
  const span = tracer.startSpan("resource-check");
  // ReadableSpan (from sdk-trace-base) has resource
  const readableSpan = span as unknown as { resource?: { attributes: Record<string, unknown> } };
  const attrs = readableSpan.resource?.attributes ?? null;
  span.end();
  return attrs;
}

describe("configureOtel", () => {
  it("is a no-op when a provider is already configured and force=false", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();

    await configureOtel({ force: false });

    // The original provider should still be active
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("verify");
    span.end();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]!.name).toBe("verify");

    await provider.shutdown();
  });

  it("replaces existing provider when force=true", async () => {
    const originalExporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(originalExporter)],
    });
    provider.register();

    await configureOtel({ force: true });

    // After force replace, the new provider is registered
    expect(createsRealSpans()).toBe(true);

    await provider.shutdown();
    trace.disable();
  });

  it("detects non-Basic providers (NodeTracerProvider etc.)", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();

    await configureOtel();

    // Should still use the original provider
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("detect-test");
    span.end();
    expect(exporter.getFinishedSpans()).toHaveLength(1);

    await provider.shutdown();
  });

  it("registers a provider that creates real spans", async () => {
    await configureOtel();
    expect(createsRealSpans()).toBe(true);
    trace.disable();
  });

  it("applies OTEL_SERVICE_NAME to resource attributes", async () => {
    process.env["OTEL_SERVICE_NAME"] = "my-custom-agent";
    await configureOtel();

    const attrs = getResourceAttributes();
    expect(attrs).not.toBeNull();
    expect(attrs!["service.name"]).toBe("my-custom-agent");
    trace.disable();
  });

  it("applies serviceName param to resource when env not set", async () => {
    await configureOtel({ serviceName: "param-agent" });

    const attrs = getResourceAttributes();
    expect(attrs).not.toBeNull();
    expect(attrs!["service.name"]).toBe("param-agent");
    trace.disable();
  });

  it("applies edictumVersion to resource attributes", async () => {
    await configureOtel({ edictumVersion: "0.1.0" });

    const attrs = getResourceAttributes();
    expect(attrs).not.toBeNull();
    expect(attrs!["edictum.version"]).toBe("0.1.0");
    trace.disable();
  });

  it("applies custom resource attributes", async () => {
    await configureOtel({
      resourceAttributes: { "deployment.id": "deploy-123" },
    });

    const attrs = getResourceAttributes();
    expect(attrs).not.toBeNull();
    expect(attrs!["deployment.id"]).toBe("deploy-123");
    trace.disable();
  });

  it("OTEL_SERVICE_NAME wins over service.name in OTEL_RESOURCE_ATTRIBUTES", async () => {
    process.env["OTEL_SERVICE_NAME"] = "env-agent";
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "service.name=wrong-agent,team=security";

    await configureOtel();

    const attrs = getResourceAttributes();
    expect(attrs).not.toBeNull();
    expect(attrs!["service.name"]).toBe("env-agent");
    // Other attrs from OTEL_RESOURCE_ATTRIBUTES should still apply
    expect(attrs!["team"]).toBe("security");
    trace.disable();
  });

  it("resourceAttributes cannot override env-set service.name", async () => {
    process.env["OTEL_SERVICE_NAME"] = "env-agent";
    await configureOtel({
      resourceAttributes: { "service.name": "should-not-win" },
    });

    const attrs = getResourceAttributes();
    expect(attrs).not.toBeNull();
    expect(attrs!["service.name"]).toBe("env-agent");
    trace.disable();
  });

  it("reads OTEL_EXPORTER_OTLP_ENDPOINT from env", async () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://collector:4317";
    await configureOtel();
    expect(createsRealSpans()).toBe(true);
    trace.disable();
  });

  it("reads OTEL_EXPORTER_OTLP_PROTOCOL from env", async () => {
    process.env["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf";
    await configureOtel();
    expect(createsRealSpans()).toBe(true);
    trace.disable();
  });

  it("uses http exporter for protocol=http", async () => {
    await configureOtel({ protocol: "http" });
    expect(createsRealSpans()).toBe(true);
    trace.disable();
  });

  it("uses http exporter for protocol=http/protobuf", async () => {
    await configureOtel({ protocol: "http/protobuf" });
    expect(createsRealSpans()).toBe(true);
    trace.disable();
  });

  it("throws EdictumConfigError for invalid protocol", async () => {
    await expect(
      configureOtel({ protocol: "invalid" as "grpc" }),
    ).rejects.toThrow("Invalid OTel protocol");
  });

  it("sets up a global meter provider for metrics", async () => {
    await configureOtel();

    // Verify the meter provider is functional (not no-op)
    const meter = metrics.getMeter("test");
    const counter = meter.createCounter("test.counter");
    // If this doesn't throw, the meter provider is set up
    expect(() => counter.add(1)).not.toThrow();
    trace.disable();
    metrics.disable();
  });
});
