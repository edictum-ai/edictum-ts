/**
 * Tests for runtime detection and createTelemetry factory.
 */

import { describe, expect, it } from "vitest";

import { createTelemetry, hasOtel } from "../src/detect.js";
import { GovernanceTelemetry } from "../src/telemetry.js";

describe("hasOtel", () => {
  it("returns true when @opentelemetry/api is installed", () => {
    // In our test environment, OTel is installed as a devDependency
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
});
