/** Shared test helpers for @edictum/otel tests. */

import { MetricReader } from '@opentelemetry/sdk-metrics'

import type { TelemetryEnvelope } from '../src/types.js'

/** In-memory metric reader for test assertions. */
export class TestMetricReader extends MetricReader {
  protected onForceFlush(): Promise<void> {
    return Promise.resolve()
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve()
  }
}

/** Standard test toolCall fixture. */
export const ENVELOPE: TelemetryEnvelope = {
  toolName: 'Bash',
  sideEffect: 'irreversible',
  callIndex: 0,
  environment: 'test',
  runId: 'run-123',
}
