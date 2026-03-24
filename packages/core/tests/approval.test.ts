/** Tests for the approval protocol types and LocalApprovalBackend. */

import { describe, expect, test, vi } from 'vitest'

import { ApprovalStatus, AuditAction, LocalApprovalBackend } from '../src/index.js'
import type { ApprovalBackend, ApprovalDecision, ApprovalRequest } from '../src/index.js'

describe('TestApprovalRequestFrozen', () => {
  test('frozen', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Bash', { command: 'ls' }, 'Approve bash?', {
      timeout: 60,
    })
    expect(() => {
      ;(req as any).toolName = 'Other'
    }).toThrow(TypeError)
  })

  test('defaults', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Bash', {}, 'msg', {
      timeout: 60,
    })
    expect(req.timeoutEffect).toBe('deny')
    expect(req.principal).toBeNull()
    expect(req.metadata).toEqual({})
    expect(req.createdAt).toBeInstanceOf(Date)
  })
})

describe('TestApprovalDecisionFrozen', () => {
  test('frozen', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Tool', {}, 'msg')

    vi.spyOn(backend as any, '_readStdin').mockResolvedValue('y')
    const dec = await backend.waitForDecision(req.approvalId)

    expect(() => {
      ;(dec as any).approved = false
    }).toThrow(TypeError)
  })

  test('defaults', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Tool', {}, 'msg')

    vi.spyOn(backend as any, '_readStdin').mockResolvedValue('n')
    const dec = await backend.waitForDecision(req.approvalId)

    expect(dec.approved).toBe(false)
    // When stdin responds (not timeout), status is DENIED for "n"
    expect(dec.status).toBe(ApprovalStatus.DENIED)
    expect(dec.approver).toBe('local')
    expect(dec.timestamp).toBeInstanceOf(Date)
  })
})

describe('TestApprovalBackendProtocol', () => {
  test('has_required_methods', () => {
    const backend = new LocalApprovalBackend()
    expect(typeof backend.requestApproval).toBe('function')
    expect(typeof backend.waitForDecision).toBe('function')
  })

  test('satisfies_interface', () => {
    // Structural compatibility: LocalApprovalBackend satisfies ApprovalBackend
    const backend: ApprovalBackend = new LocalApprovalBackend()
    expect(backend).toBeDefined()
  })
})

describe('TestLocalApprovalBackendRequestApproval', () => {
  test('returns_approval_request', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval(
      'Bash',
      { command: 'rm -rf /' },
      'Dangerous command detected',
      { timeout: 120 },
    )
    expect(req.toolName).toBe('Bash')
    expect(req.toolArgs).toEqual({ command: 'rm -rf /' })
    expect(req.message).toBe('Dangerous command detected')
    expect(req.timeout).toBe(120)
    expect(req.approvalId.length).toBeGreaterThan(0)
  })

  test('generates_unique_ids', async () => {
    const backend = new LocalApprovalBackend()
    const req1 = await backend.requestApproval('T1', {}, 'msg1')
    const req2 = await backend.requestApproval('T2', {}, 'msg2')
    expect(req1.approvalId).not.toBe(req2.approvalId)
  })

  test('stores_pending_request', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('T1', {}, 'msg')
    expect((backend as any)._pending.has(req.approvalId)).toBe(true)
  })

  test('passes_optional_params', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Tool', { a: 1 }, 'msg', {
      timeoutEffect: 'allow',
      principal: { role: 'admin' },
      metadata: { ticket: 'T-123' },
    })
    expect(req.timeoutEffect).toBe('allow')
    expect(req.principal).toEqual({ role: 'admin' })
    expect(req.metadata).toEqual({ ticket: 'T-123' })
  })
})

describe('TestLocalApprovalBackendTimeout', () => {
  test('timeout_deny', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Tool', {}, 'msg', {
      timeout: 1,
      timeoutEffect: 'deny',
    })

    // Mock _readStdin to reject with a timeout error, simulating what the
    // real implementation does when its internal setTimeout fires.
    vi.spyOn(backend as any, '_readStdin').mockRejectedValue(new Error('Approval timed out'))

    const decision = await backend.waitForDecision(req.approvalId, 0.05)
    expect(decision.approved).toBe(false)
    expect(decision.status).toBe(ApprovalStatus.TIMEOUT)
  })

  test('timeout_allow', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Tool', {}, 'msg', {
      timeout: 1,
      timeoutEffect: 'allow',
    })

    // Mock _readStdin to reject with a timeout error, simulating what the
    // real implementation does when its internal setTimeout fires.
    vi.spyOn(backend as any, '_readStdin').mockRejectedValue(new Error('Approval timed out'))

    const decision = await backend.waitForDecision(req.approvalId, 0.05)
    expect(decision.approved).toBe(true)
    expect(decision.status).toBe(ApprovalStatus.TIMEOUT)
  })
})

describe('TestLocalApprovalBackendStdinResponse', () => {
  test('approve_yes', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Tool', {}, 'msg')

    vi.spyOn(backend as any, '_readStdin').mockResolvedValue('y')
    const decision = await backend.waitForDecision(req.approvalId)

    expect(decision.approved).toBe(true)
    expect(decision.status).toBe(ApprovalStatus.APPROVED)
    expect(decision.approver).toBe('local')
  })

  test('approve_full_word', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Tool', {}, 'msg')

    vi.spyOn(backend as any, '_readStdin').mockResolvedValue('yes')
    const decision = await backend.waitForDecision(req.approvalId)

    expect(decision.approved).toBe(true)
  })

  test('deny_no', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Tool', {}, 'msg')

    vi.spyOn(backend as any, '_readStdin').mockResolvedValue('n')
    const decision = await backend.waitForDecision(req.approvalId)

    expect(decision.approved).toBe(false)
    expect(decision.status).toBe(ApprovalStatus.DENIED)
  })

  test('deny_empty', async () => {
    const backend = new LocalApprovalBackend()
    const req = await backend.requestApproval('Tool', {}, 'msg')

    vi.spyOn(backend as any, '_readStdin').mockResolvedValue('')
    const decision = await backend.waitForDecision(req.approvalId)

    expect(decision.approved).toBe(false)
    expect(decision.status).toBe(ApprovalStatus.DENIED)
  })
})

describe('TestAuditActionApprovalEvents', () => {
  test('approval_requested', () => {
    expect(AuditAction.CALL_APPROVAL_REQUESTED).toBe('call_approval_requested')
  })

  test('approval_granted', () => {
    expect(AuditAction.CALL_APPROVAL_GRANTED).toBe('call_approval_granted')
  })

  test('approval_denied', () => {
    expect(AuditAction.CALL_APPROVAL_DENIED).toBe('call_approval_denied')
  })

  test('approval_timeout', () => {
    expect(AuditAction.CALL_APPROVAL_TIMEOUT).toBe('call_approval_timeout')
  })
})

describe('security', () => {
  test('C1 control char in message is stripped from terminal output', async () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s))
      return true
    })
    try {
      const backend = new LocalApprovalBackend()
      await backend.requestApproval('Tool', {}, 'approve\u0085this')
    } finally {
      spy.mockRestore()
    }
    const combined = writes.join('')
    expect(combined).not.toContain('\u0085')
    expect(combined).toContain('approvethis')
  })

  test('U+2028 line separator in toolArgs is stripped from terminal output', async () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s))
      return true
    })
    try {
      const backend = new LocalApprovalBackend()
      await backend.requestApproval('Tool', { cmd: 'val\u2028ue' }, 'msg')
    } finally {
      spy.mockRestore()
    }
    expect(writes.join('')).not.toContain('\u2028')
  })

  test('U+2029 paragraph separator in toolName is stripped from terminal output', async () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s))
      return true
    })
    try {
      const backend = new LocalApprovalBackend()
      await backend.requestApproval('Tool\u2029Name', {}, 'msg')
    } finally {
      spy.mockRestore()
    }
    expect(writes.join('')).not.toContain('\u2029')
    expect(writes.join('')).toContain('ToolName')
  })
})
