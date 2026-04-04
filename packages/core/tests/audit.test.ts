/** Tests for AuditEvent, AuditAction, StdoutAuditSink, FileAuditSink. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'

import { AuditAction, createAuditEvent, StdoutAuditSink, FileAuditSink } from '../src/index.js'
import type { AuditEvent } from '../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return createAuditEvent({
    action: AuditAction.CALL_ALLOWED,
    toolName: 'TestTool',
    ...overrides,
  })
}

// ===========================================================================
// TestAuditEvent
// ===========================================================================

describe('TestAuditEvent', () => {
  test('defaults', () => {
    const event = createAuditEvent()
    expect(event.schemaVersion).toBe('0.3.0')
    expect(event.action).toBe(AuditAction.CALL_DENIED)
    expect(event.sessionId).toBeNull()
    expect(event.parentSessionId).toBeNull()
    expect(event.workflow).toBeNull()
    expect(event.mode).toBe('enforce')
    expect(event.toolSuccess).toBeNull()
    expect(event.hooksEvaluated).toEqual([])
    expect(event.contractsEvaluated).toEqual([])
    expect(event.policyVersion).toBeNull()
    expect(event.policyError).toBe(false)
  })

  test('customFields', () => {
    const event = createAuditEvent({
      action: AuditAction.CALL_EXECUTED,
      toolName: 'Bash',
      sessionId: 'child-session',
      parentSessionId: 'parent-session',
      toolSuccess: true,
      workflow: {
        name: 'coding-guard',
        activeStage: 'local-review',
        completedStages: ['read-context'],
        blockedReason: null,
        pendingApproval: { required: false },
      },
      mode: 'observe',
    })
    expect(event.action).toBe(AuditAction.CALL_EXECUTED)
    expect(event.toolName).toBe('Bash')
    expect(event.sessionId).toBe('child-session')
    expect(event.parentSessionId).toBe('parent-session')
    expect(event.toolSuccess).toBe(true)
    expect(event.workflow).toEqual({
      name: 'coding-guard',
      activeStage: 'local-review',
      completedStages: ['read-context'],
      blockedReason: null,
      pendingApproval: { required: false },
    })
    expect(event.mode).toBe('observe')
  })

  test('policyVersionField', () => {
    const event = createAuditEvent({
      action: AuditAction.CALL_ALLOWED,
      toolName: 'Read',
      policyVersion: 'sha256:abc123def456',
    })
    expect(event.policyVersion).toBe('sha256:abc123def456')
    expect(event.policyError).toBe(false)
  })

  test('policyErrorField', () => {
    const event = createAuditEvent({
      action: AuditAction.CALL_DENIED,
      toolName: 'Bash',
      policyVersion: 'sha256:abc123def456',
      policyError: true,
    })
    expect(event.policyVersion).toBe('sha256:abc123def456')
    expect(event.policyError).toBe(true)
  })
})

// ===========================================================================
// TestAuditAction
// ===========================================================================

describe('TestAuditAction', () => {
  test('values', () => {
    expect(AuditAction.CALL_DENIED).toBe('call_denied')
    expect(AuditAction.CALL_WOULD_DENY).toBe('call_would_deny')
    expect(AuditAction.CALL_ALLOWED).toBe('call_allowed')
    expect(AuditAction.CALL_EXECUTED).toBe('call_executed')
    expect(AuditAction.CALL_FAILED).toBe('call_failed')
    expect(AuditAction.WORKFLOW_STAGE_ADVANCED).toBe('workflow_stage_advanced')
    expect(AuditAction.WORKFLOW_COMPLETED).toBe('workflow_completed')
    expect(AuditAction.WORKFLOW_STATE_UPDATED).toBe('workflow_state_updated')
    expect(AuditAction.POSTCONDITION_WARNING).toBe('postcondition_warning')
  })
})

// ===========================================================================
// TestStdoutAuditSink
// ===========================================================================

describe('TestStdoutAuditSink', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    writeSpy.mockRestore()
  })

  test('emitPrintsJson', async () => {
    const sink = new StdoutAuditSink()
    const event = createAuditEvent({ action: AuditAction.CALL_ALLOWED, toolName: 'Test' })
    await sink.emit(event)

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const output = writeSpy.mock.calls[0]![0] as string
    const data = JSON.parse(output)
    expect(data['action']).toBe('call_allowed')
    expect(data['toolName']).toBe('Test')
  })

  test('emitIncludesPolicyVersion', async () => {
    const sink = new StdoutAuditSink()
    const event = createAuditEvent({
      action: AuditAction.CALL_ALLOWED,
      toolName: 'Read',
      policyVersion: 'sha256:abc123',
      policyError: false,
    })
    await sink.emit(event)

    const output = writeSpy.mock.calls[0]![0] as string
    const data = JSON.parse(output)
    expect(data['policyVersion']).toBe('sha256:abc123')
    expect(data['policyError']).toBe(false)
  })

  test('emitIncludesPolicyError', async () => {
    const sink = new StdoutAuditSink()
    const event = createAuditEvent({
      action: AuditAction.CALL_DENIED,
      toolName: 'Bash',
      policyVersion: 'sha256:abc123',
      policyError: true,
    })
    await sink.emit(event)

    const output = writeSpy.mock.calls[0]![0] as string
    const data = JSON.parse(output)
    expect(data['policyVersion']).toBe('sha256:abc123')
    expect(data['policyError']).toBe(true)
  })
})

// ===========================================================================
// TestFileAuditSink
// ===========================================================================

describe('TestFileAuditSink', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edictum-audit-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function tmpFile(): string {
    return path.join(tmpDir, `audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  }

  test('emitWritesJsonl', async () => {
    const filePath = tmpFile()
    const sink = new FileAuditSink(filePath)
    const event = createAuditEvent({ action: AuditAction.CALL_EXECUTED, toolName: 'Bash' })
    await sink.emit(event)

    const content = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(content.trim())
    expect(data['action']).toBe('call_executed')
    expect(data['toolName']).toBe('Bash')
  })

  test('emitAppends', async () => {
    const filePath = tmpFile()
    const sink = new FileAuditSink(filePath)
    await sink.emit(createAuditEvent({ action: AuditAction.CALL_ALLOWED }))
    await sink.emit(createAuditEvent({ action: AuditAction.CALL_EXECUTED }))

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(2)
  })

  test('emitIncludesPolicyFields', async () => {
    const filePath = tmpFile()
    const sink = new FileAuditSink(filePath)
    const event = createAuditEvent({
      action: AuditAction.CALL_DENIED,
      toolName: 'Bash',
      policyVersion: 'sha256:def789',
      policyError: true,
    })
    await sink.emit(event)

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8').trim())
    expect(data['policyVersion']).toBe('sha256:def789')
    expect(data['policyError']).toBe(true)
  })
})
