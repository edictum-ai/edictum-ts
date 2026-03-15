/** Tests for Session async counter operations — ported from test_session.py. */

import { describe, test, expect } from "vitest";
import { MemoryBackend, Session } from "../src/index.js";

describe("TestSession", () => {
  test("incrementAttempts", async () => {
    const session = new Session("test-sess", new MemoryBackend());
    let count = await session.incrementAttempts();
    expect(count).toBe(1);
    count = await session.incrementAttempts();
    expect(count).toBe(2);
  });

  test("attemptCount starts at zero", async () => {
    const session = new Session("test-sess", new MemoryBackend());
    const count = await session.attemptCount();
    expect(count).toBe(0);
  });

  test("attemptCount after increments", async () => {
    const session = new Session("test-sess", new MemoryBackend());
    await session.incrementAttempts();
    await session.incrementAttempts();
    const count = await session.attemptCount();
    expect(count).toBe(2);
  });

  test("recordExecution increments counts", async () => {
    const session = new Session("test-sess", new MemoryBackend());
    await session.recordExecution("Bash", true);
    expect(await session.executionCount()).toBe(1);
    expect(await session.toolExecutionCount("Bash")).toBe(1);
  });

  test("per-tool counts independent", async () => {
    const session = new Session("test-sess", new MemoryBackend());
    await session.recordExecution("Bash", true);
    await session.recordExecution("Read", true);
    await session.recordExecution("Bash", true);
    expect(await session.toolExecutionCount("Bash")).toBe(2);
    expect(await session.toolExecutionCount("Read")).toBe(1);
    expect(await session.executionCount()).toBe(3);
  });

  test("consecutiveFailures increments", async () => {
    const session = new Session("test-sess", new MemoryBackend());
    await session.recordExecution("Bash", false);
    expect(await session.consecutiveFailures()).toBe(1);
    await session.recordExecution("Bash", false);
    expect(await session.consecutiveFailures()).toBe(2);
  });

  test("consecutiveFailures resets on success", async () => {
    const session = new Session("test-sess", new MemoryBackend());
    await session.recordExecution("Bash", false);
    await session.recordExecution("Bash", false);
    expect(await session.consecutiveFailures()).toBe(2);
    await session.recordExecution("Bash", true);
    expect(await session.consecutiveFailures()).toBe(0);
  });

  test("consecutiveFailures reset then fail (regression)", async () => {
    // Regression: fail-fail-success-fail must return 1, not stale 0
    const session = new Session("test-sess", new MemoryBackend());
    await session.recordExecution("Bash", false);
    await session.recordExecution("Bash", false);
    expect(await session.consecutiveFailures()).toBe(2);
    await session.recordExecution("Bash", true);
    expect(await session.consecutiveFailures()).toBe(0);
    await session.recordExecution("Bash", false);
    expect(await session.consecutiveFailures()).toBe(1);
  });

  test("sessionId property", async () => {
    const session = new Session("test-sess", new MemoryBackend());
    expect(session.sessionId).toBe("test-sess");
  });

  test("key scheme validation", async () => {
    const backend = new MemoryBackend();
    const session = new Session("test-sess", backend);

    await session.incrementAttempts();
    // Verify the key exists in counters
    expect((backend as any)._counters.get("s:test-sess:attempts")).toBe(1);

    await session.recordExecution("Bash", true);
    expect((backend as any)._counters.get("s:test-sess:execs")).toBe(1);
    expect((backend as any)._counters.get("s:test-sess:tool:Bash")).toBe(1);
  });
});
