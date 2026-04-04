import { describe, expect, test } from 'vitest'

import { Edictum } from '../../src/guard.js'
import { Decision } from '../../src/rules.js'
import { ApprovalStatus } from '../../src/approval.js'
import { MemoryBackend } from '../../src/storage.js'
import { NullAuditSink } from '../helpers.js'
import type {
  ApprovalBackend,
  ApprovalDecision,
  ApprovalRequest,
  Precondition,
} from '../../src/index.js'

class CaptureApprovalBackend implements ApprovalBackend {
  request: ApprovalRequest | null = null

  async requestApproval(
    toolName: string,
    toolArgs: Record<string, unknown>,
    message: string,
    options?: {
      timeout?: number
      timeoutEffect?: string
      principal?: Record<string, unknown> | null
      metadata?: Record<string, unknown> | null
      sessionId?: string | null
    },
  ): Promise<ApprovalRequest> {
    this.request = Object.freeze({
      approvalId: 'approval-1',
      toolName,
      toolArgs: Object.freeze({ ...toolArgs }),
      message,
      timeout: options?.timeout ?? 300,
      timeoutEffect: options?.timeoutEffect ?? 'deny',
      principal: options?.principal ?? null,
      metadata: Object.freeze({ ...(options?.metadata ?? {}) }),
      sessionId: options?.sessionId ?? null,
      createdAt: new Date(),
    })
    return this.request
  }

  async waitForDecision(_approvalId: string, _timeout?: number | null): Promise<ApprovalDecision> {
    return Object.freeze({
      approved: true,
      approver: 'tests',
      reason: null,
      status: ApprovalStatus.APPROVED,
      timestamp: new Date(),
    })
  }
}

function approvalRule(): Precondition {
  return {
    name: 'approval-required',
    type: 'precondition',
    tool: '*',
    effect: 'approve',
    timeout: 60,
    timeoutEffect: 'deny',
    check: () => Decision.fail('Approval required'),
    _edictum_type: 'precondition',
  } as unknown as Precondition
}

describe('ApprovalSessionBehavior', () => {
  test('run forwards sessionId to approval backend', async () => {
    const backend = new CaptureApprovalBackend()
    const guard = new Edictum({
      rules: [approvalRule()],
      auditSink: new NullAuditSink(),
      backend: new MemoryBackend(),
      approvalBackend: backend,
    })

    await guard.run('TestTool', {}, async () => 'ok', { sessionId: 'workflow-session-123' })

    expect(backend.request).not.toBeNull()
    expect(backend.request?.sessionId).toBe('workflow-session-123')
  })
})
