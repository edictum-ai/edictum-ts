/**
 * Tests for Principal Enhancement (Stream B).
 *
 * Covers:
 * - Principal creation with new fields (role, ticketRef, claims)
 * - Principal creation without new fields (backwards compat)
 * - Frozen behavior with claims dict
 * - Envelope propagation of new fields
 * - Audit event serialization includes new fields
 *
 * Ported from: edictum/tests/test_principal.py
 */

import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  createAuditEvent,
  createEnvelope,
  createPrincipal,
  FileAuditSink,
  StdoutAuditSink,
} from "../src/index.js";

describe("TestPrincipalNewFields", () => {
  test("principal_with_all_new_fields", () => {
    const p = createPrincipal({
      userId: "alice",
      serviceId: "svc-1",
      orgId: "org-1",
      role: "sre",
      ticketRef: "JIRA-1234",
      claims: { department: "platform", clearance: "high" },
    });
    expect(p.userId).toBe("alice");
    expect(p.serviceId).toBe("svc-1");
    expect(p.orgId).toBe("org-1");
    expect(p.role).toBe("sre");
    expect(p.ticketRef).toBe("JIRA-1234");
    expect(p.claims).toEqual({ department: "platform", clearance: "high" });
  });

  test("principal_backwards_compat_no_new_fields", () => {
    /** Existing code that only uses userId/serviceId/orgId still works. */
    const p = createPrincipal({
      userId: "bob",
      serviceId: "svc-2",
      orgId: "org-2",
    });
    expect(p.userId).toBe("bob");
    expect(p.role).toBeNull();
    expect(p.ticketRef).toBeNull();
    expect(p.claims).toEqual({});
  });

  test("principal_defaults", () => {
    /** All fields are optional with defaults. */
    const p = createPrincipal();
    expect(p.userId).toBeNull();
    expect(p.serviceId).toBeNull();
    expect(p.orgId).toBeNull();
    expect(p.role).toBeNull();
    expect(p.ticketRef).toBeNull();
    expect(p.claims).toEqual({});
  });

  test("principal_role_only", () => {
    const p = createPrincipal({ role: "admin" });
    expect(p.role).toBe("admin");
    expect(p.userId).toBeNull();
  });

  test("principal_ticket_ref_only", () => {
    const p = createPrincipal({ ticketRef: "INC-5678" });
    expect(p.ticketRef).toBe("INC-5678");
  });

  test("principal_claims_only", () => {
    const p = createPrincipal({ claims: { team: "backend" } });
    expect(p.claims).toEqual({ team: "backend" });
  });
});

describe("TestPrincipalFrozen", () => {
  test("cannot_reassign_role", () => {
    const p = createPrincipal({ role: "sre" });
    expect(() => {
      (p as Record<string, unknown>).role = "admin";
    }).toThrow(TypeError);
  });

  test("cannot_reassign_ticket_ref", () => {
    const p = createPrincipal({ ticketRef: "JIRA-1" });
    expect(() => {
      (p as Record<string, unknown>).ticketRef = "JIRA-2";
    }).toThrow(TypeError);
  });

  test("cannot_reassign_claims_reference", () => {
    /** The claims dict reference itself is frozen. */
    const p = createPrincipal({ claims: { k: "v" } });
    expect(() => {
      (p as Record<string, unknown>).claims = { new: "dict" };
    }).toThrow(TypeError);
  });

  test("claims_dict_contents_are_frozen", () => {
    /**
     * In TS with Object.freeze via createPrincipal, the claims object
     * is also frozen. This differs from Python where frozen dataclass
     * only freezes the reference. In TS we freeze everything.
     */
    const p = createPrincipal({ claims: { k: "v" } });
    expect(() => {
      (p.claims as Record<string, unknown>).k2 = "v2";
    }).toThrow(TypeError);
  });

  test("empty_claims_instances_are_independent", () => {
    /**
     * Each createPrincipal call gets its own claims dict.
     * Since claims are frozen, we verify independence by checking
     * that two principals do not share the same claims reference.
     */
    const p1 = createPrincipal();
    const p2 = createPrincipal();
    expect(p1.claims).not.toBe(p2.claims);
    expect(p1.claims).toEqual({});
    expect(p2.claims).toEqual({});
  });
});

describe("TestPrincipalAsDict", () => {
  test("as_dict_full", () => {
    const p = createPrincipal({
      userId: "alice",
      role: "sre",
      ticketRef: "JIRA-1234",
      claims: { dept: "platform" },
    });
    const d = { ...p };
    expect(d).toEqual({
      userId: "alice",
      serviceId: null,
      orgId: null,
      role: "sre",
      ticketRef: "JIRA-1234",
      claims: { dept: "platform" },
    });
  });

  test("as_dict_defaults", () => {
    const p = createPrincipal();
    const d = { ...p };
    expect(d.role).toBeNull();
    expect(d.ticketRef).toBeNull();
    expect(d.claims).toEqual({});
  });
});

describe("TestEnvelopePropagation", () => {
  test("envelope_with_enhanced_principal", () => {
    const principal = createPrincipal({
      userId: "arnold",
      role: "sre",
      ticketRef: "JIRA-1234",
      claims: { department: "platform" },
    });
    const envelope = createEnvelope("TestTool", { key: "value" }, {
      principal,
    });
    // Deep-copied, not identity — but values match
    expect(envelope.principal).toEqual(principal);
    expect(envelope.principal!.role).toBe("sre");
    expect(envelope.principal!.ticketRef).toBe("JIRA-1234");
    expect(envelope.principal!.claims).toEqual({ department: "platform" });
  });

  test("envelope_without_principal", () => {
    /** Backwards compat: envelope without principal still works. */
    const envelope = createEnvelope("TestTool", { key: "value" });
    expect(envelope.principal).toBeNull();
  });

  test("envelope_with_legacy_principal", () => {
    /** Backwards compat: principal without new fields still works. */
    const principal = createPrincipal({ userId: "bob" });
    const envelope = createEnvelope("TestTool", {}, { principal });
    expect(envelope.principal!.userId).toBe("bob");
    expect(envelope.principal!.role).toBeNull();
    expect(envelope.principal!.ticketRef).toBeNull();
    expect(envelope.principal!.claims).toEqual({});
  });
});

describe("TestAuditEventPrincipalSerialization", () => {
  test("audit_event_with_enhanced_principal", () => {
    const principalDict = {
      userId: "alice",
      serviceId: null,
      orgId: null,
      role: "sre",
      ticketRef: "JIRA-1234",
      claims: { department: "platform" },
    };
    const event = createAuditEvent({
      toolName: "TestTool",
      principal: principalDict,
    });
    expect(event.principal!.userId).toBe("alice");
    expect(event.principal!.role).toBe("sre");
    expect(event.principal!.ticketRef).toBe("JIRA-1234");
    expect(event.principal!.claims).toEqual({ department: "platform" });
  });

  test("audit_event_principal_none", () => {
    const event = createAuditEvent({ toolName: "TestTool" });
    expect(event.principal).toBeNull();
  });

  test("stdout_sink_serializes_principal", async () => {
    /** StdoutAuditSink includes principal fields in JSON output. */
    const principalDict = {
      userId: "alice",
      serviceId: null,
      orgId: null,
      role: "admin",
      ticketRef: null,
      claims: { env: "prod" },
    };
    const sink = new StdoutAuditSink();
    const event = createAuditEvent({
      toolName: "TestTool",
      principal: principalDict,
    });

    let captured = "";
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        captured += String(chunk);
        return true;
      });

    try {
      await sink.emit(event);
      const data = JSON.parse(captured.trim());
      expect(data.principal.userId).toBe("alice");
      expect(data.principal.role).toBe("admin");
      expect(data.principal.claims).toEqual({ env: "prod" });
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("file_sink_serializes_principal", async () => {
    /** FileAuditSink includes principal fields in JSONL output. */
    const principalDict = {
      userId: "bob",
      serviceId: null,
      orgId: null,
      role: "developer",
      ticketRef: "INC-99",
      claims: { team: "backend" },
    };
    const path = join(
      tmpdir(),
      `edictum-test-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const sink = new FileAuditSink(path);
    const event = createAuditEvent({
      toolName: "TestTool",
      principal: principalDict,
    });

    try {
      await sink.emit(event);
      const contents = await readFile(path, "utf-8");
      const data = JSON.parse(contents.trim());
      expect(data.principal.userId).toBe("bob");
      expect(data.principal.role).toBe("developer");
      expect(data.principal.ticketRef).toBe("INC-99");
      expect(data.principal.claims).toEqual({ team: "backend" });
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  test("file_sink_principal_none", async () => {
    /** FileAuditSink handles null principal. */
    const path = join(
      tmpdir(),
      `edictum-test-audit-none-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const sink = new FileAuditSink(path);
    const event = createAuditEvent({ toolName: "TestTool" });

    try {
      await sink.emit(event);
      const contents = await readFile(path, "utf-8");
      const data = JSON.parse(contents.trim());
      expect(data.principal).toBeNull();
    } finally {
      await unlink(path).catch(() => {});
    }
  });
});
