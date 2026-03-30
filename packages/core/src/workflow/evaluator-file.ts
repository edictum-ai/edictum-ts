import type { FactEvaluator } from './evaluator.js'
import { type FactResult } from './evaluator.js'

export const fileReadEvaluator: FactEvaluator = {
  evaluate(request): FactResult {
    const parsed = request.parsed
    return {
      passed: request.state.evidence.reads.includes(parsed.arg),
      evidence: parsed.arg,
      kind: 'file_read',
      condition: parsed.condition,
      message: request.gate.message,
      stageId: request.stage.id,
      workflow: request.definition.metadata.name,
    }
  },
}
