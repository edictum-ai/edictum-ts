import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import type { FactEvaluator } from './evaluator.js'
import { type FactResult } from './evaluator.js'

const MAX_EXEC_EVIDENCE_OUTPUT = 4096
const MAX_EXEC_BUFFER_BYTES = MAX_EXEC_EVIDENCE_OUTPUT

export interface ExecEvaluatorOptions {
  readonly timeoutMs: number
}

function truncateExecOutput(output: Buffer, truncated: boolean): string {
  if (!truncated && output.length <= MAX_EXEC_EVIDENCE_OUTPUT) {
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
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const chunks: Buffer[] = []
      let bufferedBytes = 0
      let exitCode = 0
      let outputTruncated = false
      let timedOut = false
      let terminatedByTimeout = false

      child.stdout.on('data', (chunk: Buffer) => {
        const capture = captureExecOutputChunk(chunk, bufferedBytes)
        bufferedBytes += capture.bufferedBytes
        outputTruncated ||= capture.truncated
        if (capture.chunk.length > 0) {
          chunks.push(capture.chunk)
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        const capture = captureExecOutputChunk(chunk, bufferedBytes)
        bufferedBytes += capture.bufferedBytes
        outputTruncated ||= capture.truncated
        if (capture.chunk.length > 0) {
          chunks.push(capture.chunk)
        }
      })

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timeout = setTimeout(() => {
          if (settled) {
            return
          }
          timedOut = true
          terminatedByTimeout = terminateExecChild(child)
        }, options.timeoutMs)

        const settle = (fn: () => void) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timeout)
          fn()
        }

        child.once('error', (error) => {
          settle(() => {
            reject(
              new Error(
                `workflow: exec evaluator ${JSON.stringify(request.parsed.arg)} failed: ${error}`,
              ),
            )
          })
        })
        child.once('close', (code) => {
          settle(() => {
            if (timedOut && terminatedByTimeout) {
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
      })

      return {
        passed: exitCode === request.parsed.exitCode,
        evidence: `exit_code=${exitCode} output=${truncateExecOutput(Buffer.concat(chunks), outputTruncated)}`,
        kind: 'exec',
        condition: request.parsed.condition,
        message: request.gate.message,
        stageId: request.stage.id,
        workflow: request.definition.metadata.name,
      }
    },
  }
}

function captureExecOutputChunk(
  chunk: Buffer,
  bufferedBytes: number,
): { chunk: Buffer; bufferedBytes: number; truncated: boolean } {
  if (bufferedBytes >= MAX_EXEC_BUFFER_BYTES) {
    return { chunk: Buffer.alloc(0), bufferedBytes: 0, truncated: true }
  }

  const remaining = MAX_EXEC_BUFFER_BYTES - bufferedBytes
  if (chunk.length <= remaining) {
    return { chunk, bufferedBytes: chunk.length, truncated: false }
  }

  return {
    chunk: chunk.subarray(0, remaining),
    bufferedBytes: remaining,
    truncated: true,
  }
}

function terminateExecChild(child: ChildProcess): boolean {
  if (child.killed) {
    return true
  }

  if (process.platform === 'win32') {
    return child.kill('SIGKILL')
  }

  const pid = child.pid
  if (pid == null) {
    return child.kill('SIGKILL')
  }

  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch {
    return child.kill('SIGKILL')
  }
}
