import type { FactEvaluator } from './evaluator.js'
import { type FactResult } from './evaluator.js'
import { WORKFLOW_APPROVED_STATUS } from './state.js'

export const approvalEvaluator: FactEvaluator = {
  evaluate(request): FactResult {
    const parsed = request.parsed
    const stageId = parsed.arg || request.stage.id
    return {
      passed: request.state.approvals[stageId] === WORKFLOW_APPROVED_STATUS,
      evidence: request.state.approvals[stageId] ?? '',
      kind: 'approval',
      condition: parsed.condition,
      message: request.gate.message,
      stageId: request.stage.id,
      workflow: request.definition.metadata.name,
    }
  },
}
