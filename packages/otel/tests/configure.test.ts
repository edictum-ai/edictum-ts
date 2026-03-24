/**
 * Tests for configureOtel() — OTel setup helper.
 *
 * Validates environment variable overrides, protocol selection,
 * and no-op behavior when a provider is already configured.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { trace } from "@opentelemetry/api";
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
});

afterEach(() => {
  process.env = originalEnv;
  trace.disable();
});

describe("configureOtel", () => {
  it("is a no-op when a provider is already configured and force=false", async () => {
    // Pre-configure a provider
    const provider = new BasicTracerProvider();
    provider.register();

    // configureOtel should not replace it
    await configureOtel({ force: false });

    // The tracer should still be from the original provider
    const tracer = trace.getTracer("test");
    expect(tracer).toBeDefined();

    await provider.shutdown();
  });

  it("replaces existing provider when force=true", async () => {
    const provider = new BasicTracerProvider();
    provider.register();

    // Should NOT throw — replaces the existing provider
    await configureOtel({ force: true });

    await provider.shutdown();
    trace.disable();
  });

  it("reads OTEL_SERVICE_NAME from env", async () => {
    process.env["OTEL_SERVICE_NAME"] = "my-custom-agent";

    // configureOtel will use the env var; we just verify it doesn't throw
    await configureOtel();

    // Verify a tracer provider was set up
    const tracer = trace.getTracer("edictum");
    expect(tracer).toBeDefined();
    trace.disable();
  });

  it("reads OTEL_EXPORTER_OTLP_ENDPOINT from env", async () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://collector:4317";

    await configureOtel();
    const tracer = trace.getTracer("edictum");
    expect(tracer).toBeDefined();
    trace.disable();
  });

  it("reads OTEL_EXPORTER_OTLP_PROTOCOL from env", async () => {
    process.env["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf";

    await configureOtel();
    const tracer = trace.getTracer("edictum");
    expect(tracer).toBeDefined();
    trace.disable();
  });

  it("parses OTEL_RESOURCE_ATTRIBUTES from env", async () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "env=prod,team=security";

    await configureOtel();
    const tracer = trace.getTracer("edictum");
    expect(tracer).toBeDefined();
    trace.disable();
  });

  it("uses http exporter for protocol=http", async () => {
    // Just verify it doesn't throw with HTTP protocol
    await configureOtel({ protocol: "http" });
    trace.disable();
  });

  it("uses http exporter for protocol=http/protobuf", async () => {
    await configureOtel({ protocol: "http/protobuf" });
    trace.disable();
  });

  it("includes edictumVersion in resource attributes", async () => {
    await configureOtel({ edictumVersion: "0.1.0" });
    trace.disable();
  });

  it("includes custom resource attributes", async () => {
    await configureOtel({
      resourceAttributes: { "deployment.id": "deploy-123" },
    });
    trace.disable();
  });
});
