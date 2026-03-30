import type { FactEvaluator } from './evaluator.js'
import { type FactResult } from './evaluator.js'
import { joinWorkflowEvidence } from './runtime-helpers.js'

export const commandEvaluator: FactEvaluator = {
  evaluate(request): FactResult {
    const parsed = request.parsed
    const commands = request.state.evidence.stageCalls[request.stage.id] ?? []
    let passed = parsed.kind === 'command_not_matches'

    for (const command of commands) {
      const matched = parsed.regex?.test(command) ?? false
      if (parsed.kind === 'command_matches' && matched) {
        passed = true
        break
      }
      if (parsed.kind === 'command_not_matches' && matched) {
        passed = false
        break
      }
    }

    return {
      passed,
      evidence: joinWorkflowEvidence(commands),
      kind: parsed.kind,
      condition: parsed.condition,
      message: request.gate.message,
      stageId: request.stage.id,
      workflow: request.definition.metadata.name,
    }
  },
}
