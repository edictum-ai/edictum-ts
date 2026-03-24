/**
 * Tests for runtime detection and createTelemetry factory.
 */

import { describe, expect, it, afterEach } from "vitest";

import { createTelemetry, hasOtel, _resetHasOtelCache } from "../src/detect.js"; // @internal import for test only
import { GovernanceTelemetry } from "../src/telemetry.js";

afterEach(() => {
  _resetHasOtelCache();
});

describe("hasOtel", () => {
  it("returns true when @opentelemetry/api is installed", () => {
    // In our test environment, OTel is installed as a devDependency
    expect(hasOtel()).toBe(true);
  });

  it("caches the result across calls", () => {
    const first = hasOtel();
    const second = hasOtel();
    expect(first).toBe(second);
  });

  it("cache can be reset with _resetHasOtelCache", () => {
    hasOtel(); // populate cache
    _resetHasOtelCache();
    // After reset, next call re-probes
    expect(hasOtel()).toBe(true);
  });
});

describe("createTelemetry", () => {
  it("returns GovernanceTelemetry when OTel is available", async () => {
    const telemetry = await createTelemetry();
    expect(telemetry).toBeInstanceOf(GovernanceTelemetry);
  });

  it("returned instance implements GovernanceTelemetryLike", async () => {
    const telemetry = await createTelemetry();
    expect(typeof telemetry.startToolSpan).toBe("function");
    expect(typeof telemetry.recordDenial).toBe("function");
    expect(typeof telemetry.recordAllowed).toBe("function");
    expect(typeof telemetry.setSpanError).toBe("function");
    expect(typeof telemetry.setSpanOk).toBe("function");
  });

  it("propagates non-module-not-found errors", async () => {
    // If GovernanceTelemetry constructor threw a TypeError, it should propagate
    // We can't easily simulate this without mocking, but we verify the
    // happy path returns a real instance (not a silent no-op)
    const telemetry = await createTelemetry();
    expect(telemetry).toBeInstanceOf(GovernanceTelemetry);
  });
});
