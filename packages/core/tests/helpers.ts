/** Shared test fixtures — equivalent to conftest.py. */

import {
  createEnvelope,
  MemoryBackend,
  Session,
  type AuditEvent,
  type AuditAction,
  type AuditSink,
} from "../src/index.js";

/** Audit sink that records all events for assertions. */
export class CapturingAuditSink implements AuditSink {
  events: AuditEvent[] = [];

  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  get actions(): AuditAction[] {
    return this.events.map((e) => e.action);
  }

  getByAction(action: AuditAction): AuditEvent[] {
    return this.events.filter((e) => e.action === action);
  }

  assertActionEmitted(action: AuditAction, times: number = 1): void {
    const actual = this.getByAction(action).length;
    if (actual !== times) {
      throw new Error(
        `Expected ${action} emitted ${times} time(s), got ${actual}. ` +
          `Actions emitted: ${JSON.stringify(this.actions)}`,
      );
    }
  }

  assertActionNotEmitted(action: AuditAction): void {
    const matches = this.getByAction(action);
    if (matches.length > 0) {
      throw new Error(
        `Expected ${action} NOT emitted, but found ${matches.length} event(s)`,
      );
    }
  }

  reset(): void {
    this.events = [];
  }
}

/** Audit sink that discards all events. */
export class NullAuditSink implements AuditSink {
  events: AuditEvent[] = [];

  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Factory for common test fixtures. */
export function createBackend(): MemoryBackend {
  return new MemoryBackend();
}

export function createSession(
  sessionId: string = "test-session",
  backend?: MemoryBackend,
): Session {
  return new Session(sessionId, backend ?? createBackend());
}

export function createTestEnvelope() {
  return createEnvelope("TestTool", { key: "value" });
}

export function createBashEnvelope() {
  return createEnvelope("Bash", { command: "ls -la" });
}

export function createReadEnvelope() {
  return createEnvelope("Read", { file_path: "/tmp/test.txt" });
}
