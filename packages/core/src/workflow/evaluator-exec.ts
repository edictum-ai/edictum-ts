import { spawn } from 'node:child_process'

import type { FactEvaluator } from './evaluator.js'
import { type FactResult } from './evaluator.js'

const MAX_EXEC_EVIDENCE_OUTPUT = 4096

export const execEvaluator: FactEvaluator = {
  async evaluate(request): Promise<FactResult> {
    const shell = process.platform === 'win32' ? 'cmd' : 'sh'
    const flag = process.platform === 'win32' ? '/C' : '-c'
    const child = spawn(shell, [flag, request.parsed.arg], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const chunks: Buffer[] = []
    let exitCode = 0

    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })

    await new Promise<void>((resolve, reject) => {
      child.on('error', (error) => {
        reject(
          new Error(
            `workflow: exec evaluator ${JSON.stringify(request.parsed.arg)} failed: ${error}`,
          ),
        )
      })
      child.on('close', (code) => {
        exitCode = code ?? 0
        resolve()
      })
    })

    return {
      passed: exitCode === request.parsed.exitCode,
      evidence: `exit_code=${exitCode} output=${truncateExecOutput(Buffer.concat(chunks))}`,
      kind: 'exec',
      condition: request.parsed.condition,
      message: request.gate.message,
      stageId: request.stage.id,
      workflow: request.definition.metadata.name,
    }
  },
}

function truncateExecOutput(output: Buffer): string {
  if (output.length <= MAX_EXEC_EVIDENCE_OUTPUT) {
    return output.toString('utf8')
  }
  return `${output.subarray(0, MAX_EXEC_EVIDENCE_OUTPUT).toString('utf8')}...[truncated]`
}
