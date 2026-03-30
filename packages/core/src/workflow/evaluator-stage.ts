import type { FactEvaluator } from './evaluator.js'
import { type FactResult } from './evaluator.js'
import { workflowStateCompletedStage } from './result.js'

export const stageCompleteEvaluator: FactEvaluator = {
  evaluate(request): FactResult {
    const parsed = request.parsed
    return {
      passed: workflowStateCompletedStage(request.state, parsed.arg),
      evidence: parsed.arg,
      kind: 'stage_complete',
      condition: parsed.condition,
      message: request.gate.message,
      stageId: request.stage.id,
      workflow: request.definition.metadata.name,
    }
  },
}
