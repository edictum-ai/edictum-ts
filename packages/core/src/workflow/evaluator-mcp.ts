import type { FactEvaluator, EvaluateRequest, FactResult } from './evaluator.js'

export const mcpResultMatchesEvaluator: FactEvaluator = {
  evaluate(req: EvaluateRequest): FactResult {
    const [tool, fieldName, value] = req.parsed.extra
    const mcpResults = req.state.evidence.mcpResults ?? {}
    const resultsForTool = mcpResults[tool ?? ''] ?? []
    const passed = resultsForTool.some((result) => {
      const fieldValue = result[fieldName ?? '']
      return typeof fieldValue === 'string' && fieldValue === (value ?? '')
    })
    return {
      passed,
      evidence: tool ?? '',
      kind: 'mcp_result_matches',
      condition: req.parsed.condition,
      message: req.gate.message,
      stageId: req.stage.id,
      workflow: req.definition.metadata.name,
    }
  },
}
