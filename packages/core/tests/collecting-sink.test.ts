/** Tests for CollectingAuditSink and CompositeSink. */

import { describe, test, expect } from "vitest";

import {
  AuditAction,
  createAuditEvent,
  CollectingAuditSink,
  CompositeSink,
  MarkEvictedError,
} from "../src/index.js";
import type { AuditEvent, AuditSink } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return createAuditEvent({
    action: AuditAction.CALL_ALLOWED,
    toolName: "TestTool",
    ...overrides,
  });
}

class CaptureSink implements AuditSink {
  events: AuditEvent[] = [];
  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

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
    const m = sink.mark();
    for (let i = 0; i < 3; i++) {
      await sink.emit(makeEvent());
    }
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
    sink.clear();
    expect(() => sink.sinceMark(3)).toThrow(MarkEvictedError);
  });

  test("clearAllowsPostClearMarks", async () => {
    const sink = new CollectingAuditSink();
    for (let i = 0; i < 5; i++) {
      await sink.emit(makeEvent());
    }
    sink.clear();
    const m = sink.mark();
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
    expect(() => sink.sinceMark(0)).toThrow(MarkEvictedError);
    expect(() => sink.sinceMark(10)).toThrow(MarkEvictedError);
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
      expect.unreachable("Expected AggregateError");
    } catch (e) {
      expect(e).toBeInstanceOf(AggregateError);
      const agg = e as AggregateError;
      expect(agg.errors.length).toBe(2);
      expect(agg.errors[0]).toBe(err1);
      expect(agg.errors[1]).toBe(err2);
    }
  });

  test("noErrorWhenAllSinksSucceed", async () => {
    const sinkA = new CaptureSink();
    const sinkB = new CaptureSink();
    const composite = new CompositeSink([sinkA, sinkB]);

    const event = createAuditEvent({ action: AuditAction.CALL_ALLOWED, toolName: "Read" });
    await composite.emit(event);

    expect(sinkA.events.length).toBe(1);
    expect(sinkB.events.length).toBe(1);
  });
});
