/**
 * Tests for AuditEvent, AuditAction, StdoutAuditSink, FileAuditSink,
 * CollectingAuditSink, and CompositeSink.
 *
 * Ported from Python test_audit.py (TestAuditEvent, TestAuditAction,
 * TestStdoutAuditSink, TestFileAuditSink) plus behavior tests from
 * test_collecting_sink_behavior.py and test_audit_behavior.py.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";

import {
  AuditAction,
  createAuditEvent,
  StdoutAuditSink,
  FileAuditSink,
  CollectingAuditSink,
  CompositeSink,
  MarkEvictedError,
  RedactionPolicy,
} from "../src/index.js";
import type { AuditEvent, AuditSink } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return createAuditEvent({
    action: AuditAction.CALL_ALLOWED,
    toolName: "TestTool",
    ...overrides,
  });
}

/** Minimal AuditSink that records emitted events. */
class CaptureSink implements AuditSink {
  events: AuditEvent[] = [];
  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

/** AuditSink that always raises on emit. */
class FailingSink implements AuditSink {
  private readonly error: Error;
  constructor(error?: Error) {
    this.error = error ?? new Error("sink failed");
  }
  async emit(_event: AuditEvent): Promise<void> {
    throw this.error;
  }
}

// ===========================================================================
// TestAuditEvent
// ===========================================================================

describe("TestAuditEvent", () => {
  test("defaults", () => {
    const event = createAuditEvent();
    expect(event.schemaVersion).toBe("0.3.0");
    expect(event.action).toBe(AuditAction.CALL_DENIED);
    expect(event.mode).toBe("enforce");
    expect(event.toolSuccess).toBeNull();
    expect(event.hooksEvaluated).toEqual([]);
    expect(event.contractsEvaluated).toEqual([]);
    expect(event.policyVersion).toBeNull();
    expect(event.policyError).toBe(false);
  });

  test("customFields", () => {
    const event = createAuditEvent({
      action: AuditAction.CALL_EXECUTED,
      toolName: "Bash",
      toolSuccess: true,
      mode: "observe",
    });
    expect(event.action).toBe(AuditAction.CALL_EXECUTED);
    expect(event.toolName).toBe("Bash");
    expect(event.toolSuccess).toBe(true);
    expect(event.mode).toBe("observe");
  });

  test("policyVersionField", () => {
    const event = createAuditEvent({
      action: AuditAction.CALL_ALLOWED,
      toolName: "Read",
      policyVersion: "sha256:abc123def456",
    });
    expect(event.policyVersion).toBe("sha256:abc123def456");
    expect(event.policyError).toBe(false);
  });

  test("policyErrorField", () => {
    const event = createAuditEvent({
      action: AuditAction.CALL_DENIED,
      toolName: "Bash",
      policyVersion: "sha256:abc123def456",
      policyError: true,
    });
    expect(event.policyVersion).toBe("sha256:abc123def456");
    expect(event.policyError).toBe(true);
  });
});

// ===========================================================================
// TestAuditAction
// ===========================================================================

describe("TestAuditAction", () => {
  test("values", () => {
    expect(AuditAction.CALL_DENIED).toBe("call_denied");
    expect(AuditAction.CALL_WOULD_DENY).toBe("call_would_deny");
    expect(AuditAction.CALL_ALLOWED).toBe("call_allowed");
    expect(AuditAction.CALL_EXECUTED).toBe("call_executed");
    expect(AuditAction.CALL_FAILED).toBe("call_failed");
    expect(AuditAction.POSTCONDITION_WARNING).toBe("postcondition_warning");
  });
});

// ===========================================================================
// TestStdoutAuditSink
// ===========================================================================

describe("TestStdoutAuditSink", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  test("emitPrintsJson", async () => {
    const sink = new StdoutAuditSink();
    const event = createAuditEvent({ action: AuditAction.CALL_ALLOWED, toolName: "Test" });
    await sink.emit(event);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const output = writeSpy.mock.calls[0]![0] as string;
    const data = JSON.parse(output);
    expect(data["action"]).toBe("call_allowed");
    expect(data["toolName"]).toBe("Test");
  });

  test("emitIncludesPolicyVersion", async () => {
    const sink = new StdoutAuditSink();
    const event = createAuditEvent({
      action: AuditAction.CALL_ALLOWED,
      toolName: "Read",
      policyVersion: "sha256:abc123",
      policyError: false,
    });
    await sink.emit(event);

    const output = writeSpy.mock.calls[0]![0] as string;
    const data = JSON.parse(output);
    expect(data["policyVersion"]).toBe("sha256:abc123");
    expect(data["policyError"]).toBe(false);
  });

  test("emitIncludesPolicyError", async () => {
    const sink = new StdoutAuditSink();
    const event = createAuditEvent({
      action: AuditAction.CALL_DENIED,
      toolName: "Bash",
      policyVersion: "sha256:abc123",
      policyError: true,
    });
    await sink.emit(event);

    const output = writeSpy.mock.calls[0]![0] as string;
    const data = JSON.parse(output);
    expect(data["policyVersion"]).toBe("sha256:abc123");
    expect(data["policyError"]).toBe(true);
  });
});

// ===========================================================================
// TestFileAuditSink
// ===========================================================================

describe("TestFileAuditSink", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edictum-audit-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function tmpFile(): string {
    return path.join(tmpDir, `audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  }

  test("emitWritesJsonl", async () => {
    const filePath = tmpFile();
    const sink = new FileAuditSink(filePath);
    const event = createAuditEvent({ action: AuditAction.CALL_EXECUTED, toolName: "Bash" });
    await sink.emit(event);

    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content.trim());
    expect(data["action"]).toBe("call_executed");
    expect(data["toolName"]).toBe("Bash");
  });

  test("emitAppends", async () => {
    const filePath = tmpFile();
    const sink = new FileAuditSink(filePath);
    await sink.emit(createAuditEvent({ action: AuditAction.CALL_ALLOWED }));
    await sink.emit(createAuditEvent({ action: AuditAction.CALL_EXECUTED }));

    const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  test("emitIncludesPolicyFields", async () => {
    const filePath = tmpFile();
    const sink = new FileAuditSink(filePath);
    const event = createAuditEvent({
      action: AuditAction.CALL_DENIED,
      toolName: "Bash",
      policyVersion: "sha256:def789",
      policyError: true,
    });
    await sink.emit(event);

    const data = JSON.parse(fs.readFileSync(filePath, "utf-8").trim());
    expect(data["policyVersion"]).toBe("sha256:def789");
    expect(data["policyError"]).toBe(true);
  });
});

// ===========================================================================
// CollectingAuditSink — Emit and Query
// ===========================================================================

describe("CollectingAuditSink — EmitAndQuery", () => {
  test("emitCollectsEvents", async () => {
    const sink = new CollectingAuditSink();
    for (let i = 0; i < 3; i++) {
      await sink.emit(makeEvent());
    }
    expect(sink.events.length).toBe(3);
  });

  test("filterByAction", async () => {
    const sink = new CollectingAuditSink();
    await sink.emit(makeEvent({ action: AuditAction.CALL_ALLOWED }));
    await sink.emit(makeEvent({ action: AuditAction.CALL_DENIED }));
    await sink.emit(makeEvent({ action: AuditAction.CALL_ALLOWED }));

    const denied = sink.filter(AuditAction.CALL_DENIED);
    expect(denied.length).toBe(1);
    expect(denied[0]!.action).toBe(AuditAction.CALL_DENIED);
  });

  test("lastReturnsMostRecent", async () => {
    const sink = new CollectingAuditSink();
    for (let i = 0; i < 3; i++) {
      await sink.emit(makeEvent({ toolName: `tool_${i}` }));
    }
    expect(sink.last().toolName).toBe("tool_2");
  });

  test("lastThrowsOnEmpty", () => {
    const sink = new CollectingAuditSink();
    expect(() => sink.last()).toThrow();
  });
});

// ===========================================================================
// CollectingAuditSink — Mark and Window
// ===========================================================================

describe("CollectingAuditSink — MarkAndWindow", () => {
  test("markReturnsCurrentPosition", async () => {
    const sink = new CollectingAuditSink();
    expect(sink.mark()).toBe(0);
    await sink.emit(makeEvent());
    await sink.emit(makeEvent());
    expect(sink.mark()).toBe(2);
  });

  test("sinceMarkReturnsWindow", async () => {
    const sink = new CollectingAuditSink();
    await sink.emit(makeEvent({ toolName: "before_1" }));
    await sink.emit(makeEvent({ toolName: "before_2" }));
    const m = sink.mark();
    await sink.emit(makeEvent({ toolName: "after_1" }));
    await sink.emit(makeEvent({ toolName: "after_2" }));
    await sink.emit(makeEvent({ toolName: "after_3" }));

    const window = sink.sinceMark(m);
    expect(window.length).toBe(3);
    expect(window.map((e) => e.toolName)).toEqual(["after_1", "after_2", "after_3"]);
  });

  test("sinceMarkRaisesOnEviction", async () => {
    const sink = new CollectingAuditSink(5);
    for (let i = 0; i < 10; i++) {
      await sink.emit(makeEvent());
    }
    expect(() => sink.sinceMark(0)).toThrow(MarkEvictedError);
  });

  test("sinceMarkValidAfterPartialEviction", async () => {
    const sink = new CollectingAuditSink(5);
    for (let i = 0; i < 7; i++) {
      await sink.emit(makeEvent());
    }
    // Buffer now holds events 2-6. Total emitted = 7, evicted = 2.
    const m = sink.mark(); // m = 7
    for (let i = 0; i < 3; i++) {
      await sink.emit(makeEvent());
    }
    // Total emitted = 10, buffer holds events 5-9, evicted = 5.
    // m=7 >= evicted=5, so sinceMark should work.
    const window = sink.sinceMark(m);
    expect(window.length).toBe(3);
  });

  test("sinceMarkRejectsFutureMark", async () => {
    const sink = new CollectingAuditSink();
    await sink.emit(makeEvent());
    expect(() => sink.sinceMark(999)).toThrow(/ahead of total emitted/);
  });
});

// ===========================================================================
// CollectingAuditSink — Clear
// ===========================================================================

describe("CollectingAuditSink — Clear", () => {
  test("clearRemovesAllKeepsCounter", async () => {
    const sink = new CollectingAuditSink();
    for (let i = 0; i < 5; i++) {
      await sink.emit(makeEvent());
    }
    sink.clear();
    expect(sink.events).toEqual([]);
    expect(sink.mark()).toBe(5);
  });

  test("clearInvalidatesPreClearMarks", async () => {
    const sink = new CollectingAuditSink();
    for (let i = 0; i < 5; i++) {
      await sink.emit(makeEvent());
    }
    sink.mark();
    // Use mark at 3 (before clear) to test invalidation
    sink.clear();
    expect(() => sink.sinceMark(3)).toThrow(MarkEvictedError);
  });

  test("clearAllowsPostClearMarks", async () => {
    const sink = new CollectingAuditSink();
    for (let i = 0; i < 5; i++) {
      await sink.emit(makeEvent());
    }
    sink.clear();
    const m = sink.mark(); // m = 5
    for (let i = 0; i < 3; i++) {
      await sink.emit(makeEvent());
    }
    const window = sink.sinceMark(m);
    expect(window.length).toBe(3);
  });
});

// ===========================================================================
// CollectingAuditSink — Overflow
// ===========================================================================

describe("CollectingAuditSink — Overflow", () => {
  test("maxEventsTruncatesOldest", async () => {
    const sink = new CollectingAuditSink(3);
    for (let i = 0; i < 5; i++) {
      await sink.emit(makeEvent({ toolName: `tool_${i}` }));
    }
    const events = sink.events;
    expect(events.length).toBe(3);
    expect(events.map((e) => e.toolName)).toEqual(["tool_2", "tool_3", "tool_4"]);
  });

  test("maxEventsZeroRejected", () => {
    expect(() => new CollectingAuditSink(0)).toThrow(/must be >= 1/);
  });

  test("maxEventsNegativeRejected", () => {
    expect(() => new CollectingAuditSink(-1)).toThrow(/must be >= 1/);
  });
});

// ===========================================================================
// CollectingAuditSink — Defensive Copy
// ===========================================================================

describe("CollectingAuditSink — DefensiveCopy", () => {
  test("eventsReturnsDefensiveCopy", async () => {
    const sink = new CollectingAuditSink();
    await sink.emit(makeEvent());
    const returned = sink.events;
    returned.push(makeEvent());
    expect(sink.events.length).toBe(1);
  });
});

// ===========================================================================
// CollectingAuditSink — Security
// ===========================================================================

describe("CollectingAuditSink — security", () => {
  test("noEventLeak", async () => {
    const sink = new CollectingAuditSink();
    await sink.emit(makeEvent());
    // Two calls to .events must return distinct arrays
    const a = sink.events;
    const b = sink.events;
    expect(a).not.toBe(b);
  });

  test("maxEventsPreventsOom", async () => {
    const sink = new CollectingAuditSink(10);
    for (let i = 0; i < 1000; i++) {
      await sink.emit(makeEvent());
    }
    expect(sink.events.length).toBe(10);
  });

  test("markEvictedNotSilent", async () => {
    const sink = new CollectingAuditSink(5);
    for (let i = 0; i < 20; i++) {
      await sink.emit(makeEvent());
    }
    // Buffer holds events 15-19. Evicted = 15.
    expect(() => sink.sinceMark(0)).toThrow(MarkEvictedError);
    expect(() => sink.sinceMark(10)).toThrow(MarkEvictedError);
    // Mark 15 is at buffer start — should work (returns events 15-19)
    const result = sink.sinceMark(15);
    expect(result.length).toBe(5);
  });
});

// ===========================================================================
// CompositeSink — Behavior
// ===========================================================================

describe("CompositeSink — Behavior", () => {
  test("eventsReachAllSinks", async () => {
    const sinkA = new CaptureSink();
    const sinkB = new CaptureSink();
    const composite = new CompositeSink([sinkA, sinkB]);

    const event = createAuditEvent({ action: AuditAction.CALL_ALLOWED, toolName: "Read" });
    await composite.emit(event);

    expect(sinkA.events.length).toBe(1);
    expect(sinkB.events.length).toBe(1);
    expect(sinkA.events[0]).toBe(event);
    expect(sinkB.events[0]).toBe(event);
  });

  test("multipleEventsAccumulateInAllSinks", async () => {
    const sinkA = new CaptureSink();
    const sinkB = new CaptureSink();
    const composite = new CompositeSink([sinkA, sinkB]);

    for (let i = 0; i < 3; i++) {
      await composite.emit(
        createAuditEvent({ action: AuditAction.CALL_ALLOWED, toolName: `tool_${i}` }),
      );
    }

    expect(sinkA.events.length).toBe(3);
    expect(sinkB.events.length).toBe(3);
  });

  test("sinksPropertyReturnsCopy", () => {
    const sinkA = new CaptureSink();
    const composite = new CompositeSink([sinkA]);
    const returned = composite.sinks;
    returned.push(new CaptureSink());
    expect(composite.sinks.length).toBe(1);
  });

  test("emptyListRaises", () => {
    expect(() => new CompositeSink([])).toThrow(/at least one sink/);
  });
});

// ===========================================================================
// CompositeSink — Error Handling
// ===========================================================================

describe("CompositeSink — ErrorHandling", () => {
  test("allSinksReceiveEventsEvenWhenOneFails", async () => {
    const failing = new FailingSink();
    const collector = new CaptureSink();
    const composite = new CompositeSink([failing, collector]);

    const event = createAuditEvent({ action: AuditAction.CALL_ALLOWED, toolName: "Read" });
    await expect(composite.emit(event)).rejects.toThrow(AggregateError);

    expect(collector.events.length).toBe(1);
    expect(collector.events[0]).toBe(event);
  });

  test("errorsAreAggregated", async () => {
    const err1 = new Error("sink A broke");
    const err2 = new Error("sink B broke");
    const failingA = new FailingSink(err1);
    const failingB = new FailingSink(err2);
    const collector = new CaptureSink();
    const composite = new CompositeSink([failingA, collector, failingB]);

    const event = createAuditEvent({ action: AuditAction.CALL_ALLOWED, toolName: "Read" });

    try {
      await composite.emit(event);
      // Should not reach here
      expect.unreachable("Expected AggregateError");
    } catch (e) {
      expect(e).toBeInstanceOf(AggregateError);
      const agg = e as AggregateError;
      expect(agg.errors.length).toBe(2);
      expect(agg.errors[0]).toBe(err1);
      expect(agg.errors[1]).toBe(err2);
      expect(agg.message).toContain("one or more sinks failed");
    }
  });

  test("noErrorWhenAllSinksSucceed", async () => {
    const sinkA = new CaptureSink();
    const sinkB = new CaptureSink();
    const composite = new CompositeSink([sinkA, sinkB]);

    const event = createAuditEvent({ action: AuditAction.CALL_ALLOWED, toolName: "Read" });
    await composite.emit(event); // should not throw

    expect(sinkA.events.length).toBe(1);
    expect(sinkB.events.length).toBe(1);
  });
});
