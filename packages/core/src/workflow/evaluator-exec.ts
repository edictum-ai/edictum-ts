import { spawn } from 'node:child_process'

import type { FactEvaluator } from './evaluator.js'
import { type FactResult } from './evaluator.js'

const MAX_EXEC_EVIDENCE_OUTPUT = 4096

export interface ExecEvaluatorOptions {
  readonly timeoutMs: number
}

function truncateExecOutput(output: Buffer): string {
  if (output.length <= MAX_EXEC_EVIDENCE_OUTPUT) {
    return output.toString('utf8')
  }
  return `${output.subarray(0, MAX_EXEC_EVIDENCE_OUTPUT).toString('utf8')}...[truncated]`
}

export function createExecEvaluator(options: ExecEvaluatorOptions): FactEvaluator {
  return {
    async evaluate(request): Promise<FactResult> {
      const shell = process.platform === 'win32' ? 'cmd' : 'sh'
      const flag = process.platform === 'win32' ? '/C' : '-c'
      const child = spawn(shell, [flag, request.parsed.arg], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const chunks: Buffer[] = []
      let exitCode = 0
      let timedOut = false

      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          timedOut = true
          child.kill()
        }, options.timeoutMs)

        child.on('error', (error) => {
          clearTimeout(timeout)
          reject(
            new Error(
              `workflow: exec evaluator ${JSON.stringify(request.parsed.arg)} failed: ${error}`,
            ),
          )
        })
        child.on('close', (code) => {
          clearTimeout(timeout)
          if (timedOut) {
            reject(
              new Error(
                `workflow: exec evaluator ${JSON.stringify(request.parsed.arg)} timed out after ${options.timeoutMs}ms`,
              ),
            )
            return
          }
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
}
