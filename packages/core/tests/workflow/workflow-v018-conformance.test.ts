/**
 * Conformance runner for v0.18 workflow fixtures from edictum-schemas.
 *
 * Fixture discovery (first match wins):
 *   1. EDICTUM_SCHEMAS_DIR env var / fixtures/workflow-v0.18/. A relative
 *      value is resolved against cwd and then the repo root.
 *   2. <repo-root>/edictum-schemas/fixtures/workflow-v0.18/
 *   3. <repo-root>/../edictum-schemas/fixtures/workflow-v0.18/
 *
 * Missing-fixture behavior — gated on each named suite's loaded fixture
 * list, not on the directory existing or on the union of the four lists
 * (matches edictum#242):
 *   - EDICTUM_CONFORMANCE_REQUIRED=1 with any of the four named suites
 *     empty (missing directory, empty directory, or a missing/empty
 *     suite file) → fail the test run
 *   - Otherwise → skip the empty suite cleanly (a named skip, never a pass)
 *
 * An explicitly-set EDICTUM_SCHEMAS_DIR whose workflow-v0.18 subdirectory
 * does not exist refuses fallthrough in required mode.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  createEnvelope,
  Edictum,
  MemoryBackend,
  resolveRulesetExtends,
  Session,
  WorkflowRuntime,
} from '../../src/index.js'
import { loadWorkflowString } from '../../src/workflow/index.js'
import { saveWorkflowState } from '../../src/workflow/state.js'
import { ensureWorkflowState } from '../../src/workflow/result.js'
import type { MutableWorkflowState, MutableWorkflowEvidence } from '../../src/workflow/result.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')

const V018_SUBPATH = join('fixtures', 'workflow-v0.18')
const V018_SUITE_FILES = [
  ['wildcard-tools', 'wildcard-tools.workflow-v0.18.yaml'],
  ['terminal-stage', 'terminal-stage.workflow-v0.18.yaml'],
  ['mcp-result-evidence', 'mcp-result-evidence.workflow-v0.18.yaml'],
  ['extends-inheritance', 'extends-inheritance.workflow-v0.18.yaml'],
] as const

const FALLBACK_V018_DIRS = [
  join(REPO_ROOT, 'edictum-schemas', V018_SUBPATH),
  resolve(REPO_ROOT, '..', 'edictum-schemas', V018_SUBPATH),
]

function firstExisting(paths: readonly string[]): string | null {
  for (const candidate of paths) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function envV018Candidates(schemasEnv: string): string[] {
  const fromCwd = resolve(process.cwd(), schemasEnv, V018_SUBPATH)
  const fromRoot = resolve(REPO_ROOT, schemasEnv, V018_SUBPATH)
  return fromCwd === fromRoot ? [fromCwd] : [fromCwd, fromRoot]
}

const schemasEnv = process.env.EDICTUM_SCHEMAS_DIR
const conformanceRequired = process.env.EDICTUM_CONFORMANCE_REQUIRED === '1'
const envCandidates = schemasEnv ? envV018Candidates(schemasEnv) : []
const envHit = firstExisting(envCandidates)
const fallbackHit = firstExisting(FALLBACK_V018_DIRS)

if (schemasEnv && !envHit) {
  if (conformanceRequired) {
    throw new Error(
      `EDICTUM_SCHEMAS_DIR is set to "${schemasEnv}" but none of the resolved ` +
        `${V018_SUBPATH} directories exist — refusing to fall through to ` +
        `repo-relative discovery. Tried: ${envCandidates.join(', ')}. ` +
        'Fix the schemas checkout or unset the variable.',
    )
  }
  console.warn(
    `[edictum] EDICTUM_SCHEMAS_DIR="${schemasEnv}" has no ${V018_SUBPATH} ` +
      `at tried paths [${envCandidates.join(', ')}]; falling back to repo-relative discovery.`,
  )
}

const v018Dir = envHit ?? fallbackHit

function loadSuite(filename: string): Record<string, unknown> | null {
  if (!v018Dir) return null
  const path = join(v018Dir, filename)
  if (!existsSync(path)) return null
  return yaml.load(readFileSync(path, 'utf-8'), { schema: yaml.CORE_SCHEMA }) as Record<
    string,
    unknown
  >
}

function suiteFixtures(suite: Record<string, unknown> | null): Record<string, unknown>[] {
  if (suite == null || !Array.isArray(suite.fixtures)) return []
  return suite.fixtures as Record<string, unknown>[]
}

const loadedSuites = V018_SUITE_FILES.map(([name, file]) => {
  const suite = loadSuite(file)
  return { name, file, suite, fixtures: suiteFixtures(suite) }
})
const emptySuites = loadedSuites
  .filter((entry) => entry.fixtures.length === 0)
  .map((entry) => entry.name)

if (conformanceRequired && emptySuites.length > 0) {
  const location = v018Dir ? ` from ${v018Dir}` : ' — the fixtures directory was not found'
  const alreadySet = schemasEnv
    ? `EDICTUM_SCHEMAS_DIR is already set to "${schemasEnv}"`
    : 'Set EDICTUM_SCHEMAS_DIR or check out edictum-schemas as a sibling'
  throw new Error(
    'EDICTUM_CONFORMANCE_REQUIRED=1 but no workflow-v0.18 fixtures were loaded' +
      ` (empty suites: ${emptySuites.join(', ')})` +
      location +
      `. ${alreadySet}.`,
  )
}

// ---------------------------------------------------------------------------
// State seeding helper
// ---------------------------------------------------------------------------

function seedState(initial: Record<string, unknown>): MutableWorkflowState {
  const evidenceRaw = (initial.evidence ?? {}) as Record<string, unknown>
  const stageCallsRaw = (evidenceRaw.stage_calls ?? evidenceRaw.stageCalls ?? {}) as Record<
    string,
    unknown
  >
  const mcpResultsRaw = (evidenceRaw.mcp_results ?? evidenceRaw.mcpResults ?? {}) as Record<
    string,
    unknown
  >

  const stageCalls: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(stageCallsRaw)) {
    if (Array.isArray(v)) {
      stageCalls[k] = v.filter((x): x is string => typeof x === 'string')
    }
  }

  const mcpResults: Record<string, Record<string, unknown>[]> = {}
  for (const [k, v] of Object.entries(mcpResultsRaw)) {
    if (Array.isArray(v)) {
      mcpResults[k] = v
        .filter((x) => typeof x === 'object' && x != null && !Array.isArray(x))
        .map((x) => ({ ...(x as Record<string, unknown>) }))
    }
  }

  const evidence: MutableWorkflowEvidence = {
    reads: Array.isArray(evidenceRaw.reads)
      ? evidenceRaw.reads.filter((x): x is string => typeof x === 'string')
      : [],
    stageCalls,
    mcpResults,
  }

  return ensureWorkflowState({
    sessionId: String(initial.session_id ?? ''),
    activeStage: String(initial.active_stage ?? ''),
    completedStages: Array.isArray(initial.completed_stages)
      ? initial.completed_stages.filter((x): x is string => typeof x === 'string')
      : [],
    approvals: {},
    evidence,
    blockedReason: null,
    pendingApproval: { required: false },
    lastBlockedAction: null,
    lastRecordedEvidence: null,
  })
}

// ---------------------------------------------------------------------------
// Workflow fixture runner (wildcard-tools, terminal-stage, mcp-result-evidence)
// ---------------------------------------------------------------------------

async function runWorkflowFixture(
  suite: Record<string, unknown>,
  fixture: Record<string, unknown>,
): Promise<void> {
  const workflows = (suite.workflows ?? {}) as Record<string, Record<string, unknown>>
  const workflowName = String(fixture.workflow)
  const wfDict = workflows[workflowName]
  if (wfDict == null) {
    throw new Error(`Workflow '${workflowName}' not found in suite`)
  }
  const wfYaml = yaml.dump(wfDict)
  const runtime = new WorkflowRuntime(loadWorkflowString(wfYaml))

  const initial = fixture.initial_state as Record<string, unknown>
  const sessionId = String(initial.session_id)
  const session = new Session(sessionId, new MemoryBackend())

  const state = seedState(initial)
  await saveWorkflowState(session, runtime.definition, state)

  const steps = Array.isArray(fixture.steps) ? (fixture.steps as Record<string, unknown>[]) : []
  for (const step of steps) {
    const stepId = String(step.id)
    const callData = step.call as Record<string, unknown>
    const tool = String(callData.tool)
    const args = (callData.args ?? {}) as Record<string, unknown>
    const execution = String(step.execution ?? 'success')
    const mcpResult = step.mcp_result as Record<string, unknown> | undefined
    const expect_ = step.expect as Record<string, unknown>

    const envelope = createEnvelope(tool, args)
    const evaluation = await runtime.evaluate(session, envelope)

    // Fixture format uses 'deny' as the blocked-decision string (cross-SDK convention from
    // edictum-schemas). This repo uses WorkflowAction.BLOCK ('block') internally.
    // Assert on the raw action to prevent terminology regressions.
    if (expect_.decision === 'deny') {
      expect(evaluation.action, `step ${stepId}: decision`).toBe('block')
    } else {
      expect(evaluation.action, `step ${stepId}: decision`).toBe(expect_.decision)
    }

    if (typeof expect_.message_contains === 'string') {
      expect(evaluation.reason.toLowerCase(), `step ${stepId}: message_contains`).toContain(
        expect_.message_contains.toLowerCase(),
      )
    }

    if (execution === 'success') {
      await runtime.recordResult(session, evaluation.stageId, envelope, mcpResult)
    }

    const finalState = await runtime.state(session)

    expect(finalState.activeStage, `step ${stepId}: active_stage`).toBe(
      String(expect_.active_stage ?? ''),
    )

    if (Array.isArray(expect_.completed_stages)) {
      const expectedCompleted = expect_.completed_stages.filter(
        (x): x is string => typeof x === 'string',
      )
      expect([...finalState.completedStages], `step ${stepId}: completed_stages`).toEqual(
        expectedCompleted,
      )
    }

    // Evidence checks
    const expectEvidence = expect_.evidence as Record<string, unknown> | undefined
    if (expectEvidence != null) {
      if (Array.isArray(expectEvidence.reads)) {
        expect([...finalState.evidence.reads], `step ${stepId}: evidence.reads`).toEqual(
          expectEvidence.reads,
        )
      }
      if (typeof expectEvidence.stage_calls === 'object' && expectEvidence.stage_calls != null) {
        const expectedStageCalls = expectEvidence.stage_calls as Record<string, string[]>
        expect(
          Object.fromEntries(
            Object.entries(finalState.evidence.stageCalls).map(([k, v]) => [k, [...v]]),
          ),
          `step ${stepId}: evidence.stage_calls`,
        ).toEqual(expectedStageCalls)
      }
      if (typeof expectEvidence.mcp_results === 'object' && expectEvidence.mcp_results != null) {
        const expectedMcp = expectEvidence.mcp_results as Record<string, Record<string, unknown>[]>
        expect(
          Object.fromEntries(
            Object.entries(finalState.evidence.mcpResults).map(([k, v]) => [
              k,
              v.map((r) => ({ ...r })),
            ]),
          ),
          `step ${stepId}: evidence.mcp_results`,
        ).toEqual(expectedMcp)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Extends-inheritance fixture runner
// ---------------------------------------------------------------------------

async function runExtendsFixture(
  suite: Record<string, unknown>,
  fixture: Record<string, unknown>,
): Promise<void> {
  const rulesets = (suite.rulesets ?? {}) as Record<string, Record<string, unknown>>
  const rulesetRef = String(fixture.contract)
  const envelopeData = fixture.envelope as Record<string, unknown>
  const expected = fixture.expected as Record<string, unknown>
  const verdict = expected.verdict
  if (
    verdict !== 'denied' &&
    verdict !== 'block' &&
    verdict !== 'blocked' &&
    verdict !== 'allowed'
  ) {
    throw new Error(
      `fixture ${String(fixture.id)}: unknown expected verdict ${JSON.stringify(verdict)}`,
    )
  }

  const merged = resolveRulesetExtends(rulesets, rulesetRef)
  const mergedYaml = yaml.dump(merged)
  const guard = Edictum.fromYamlString(mergedYaml)

  const toolName = String(envelopeData.tool_name)
  const args = (envelopeData.arguments ?? {}) as Record<string, unknown>
  const result = await guard.evaluate(toolName, args)

  // Known verdicts match edictum#242: allowed / block|blocked|denied.
  // Anything else is a hard failure — an unknown verdict must not pass as
  // "not deny".
  if (verdict === 'denied' || verdict === 'block' || verdict === 'blocked') {
    expect(result.decision, `fixture ${String(fixture.id)}: verdict`).toBe('deny')
    if (typeof expected.message_contains === 'string') {
      const allReasons = result.denyReasons.join(' ').toLowerCase()
      expect(allReasons, `fixture ${String(fixture.id)}: message_contains`).toContain(
        expected.message_contains.toLowerCase(),
      )
    }
  } else if (verdict === 'allowed') {
    expect(result.decision, `fixture ${String(fixture.id)}: verdict`).not.toBe('deny')
  } else {
    throw new Error(
      `fixture ${String(fixture.id)}: unknown expected verdict ${JSON.stringify(verdict)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

if (emptySuites.length === 4) {
  it.skip('workflow-v0.18 conformance — edictum-schemas not found or empty', () => {})
} else {
  describe('workflow-v0.18 conformance', () => {
    for (const entry of loadedSuites) {
      describe(entry.name, () => {
        if (entry.suite == null || entry.fixtures.length === 0) {
          it.skip('fixture file not found or empty', () => {})
          return
        }
        const run = entry.name === 'extends-inheritance' ? runExtendsFixture : runWorkflowFixture
        for (const fixture of entry.fixtures) {
          it(`${String(entry.suite.suite ?? entry.name)}/${String(fixture.id)}: ${String(
            fixture.description ?? '',
          )}`, async () => {
            await run(entry.suite as Record<string, unknown>, fixture)
          })
        }
      })
    }
  })
}
