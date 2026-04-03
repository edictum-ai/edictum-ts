import { createEnvelope, MemoryBackend, Session } from '../../src/index.js'
import type { ApprovalBackend, ApprovalDecision, ApprovalRequest } from '../../src/index.js'
import { ApprovalStatus, WorkflowRuntime, loadWorkflowString } from '../../src/index.js'
import type { WorkflowRuntimeOptions } from '../../src/index.js'

export function makeWorkflowRuntime(
  content: string,
  options?: WorkflowRuntimeOptions,
): WorkflowRuntime {
  return new WorkflowRuntime(loadWorkflowString(content), options)
}

export function makeWorkflowSession(id: string): Session {
  return new Session(id, new MemoryBackend())
}

export function makeCall(toolName: string, args: Record<string, unknown>) {
  return createEnvelope(toolName, args)
}

export class AutoApprovalBackend implements ApprovalBackend {
  async requestApproval(
    toolName: string,
    toolArgs: Record<string, unknown>,
    message: string,
  ): Promise<ApprovalRequest> {
    return {
      approvalId: `approval:${toolName}`,
      toolName,
      toolArgs,
      message,
      timeout: 60,
      timeoutEffect: 'deny',
      principal: null,
      metadata: {},
      sessionId: null,
      createdAt: new Date(),
    }
  }

  async waitForDecision(_approvalId: string): Promise<ApprovalDecision> {
    return {
      approved: true,
      approver: 'test',
      reason: null,
      status: ApprovalStatus.APPROVED,
      timestamp: new Date(),
    }
  }
}
