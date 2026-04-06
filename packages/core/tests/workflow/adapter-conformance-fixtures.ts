import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as yaml from 'js-yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
const FIXTURE_SUBPATH = join('fixtures', 'workflow-adapter-conformance')

export interface WorkflowAdapterFixtureSuite {
  suite: string
  version: number
  description: string
  workflows: Record<string, Record<string, unknown>>
  fixtures: WorkflowAdapterFixture[]
}

export interface WorkflowAdapterFixture {
  id: string
  workflow: string
  description: string
  lineage?: {
    parent_session_id?: string
  }
  initial_state: Record<string, unknown>
  steps: WorkflowAdapterFixtureStep[]
}

export interface WorkflowAdapterFixtureStep {
  id: string
  call?: {
    tool: string
    args: Record<string, unknown>
  }
  set_stage_to?: string
  approval_outcomes?: Array<'approved' | 'rejected'>
  execution?: 'success' | 'error' | 'not_run'
  expect: Record<string, unknown>
}

export const workflowAdapterConformanceRequired =
  process.env.EDICTUM_WORKFLOW_ADAPTER_CONFORMANCE_REQUIRED === '1'

export function resolveWorkflowAdapterFixturesDir(): string | null {
  const fixturesEnv = process.env.EDICTUM_WORKFLOW_ADAPTER_FIXTURES_DIR
  if (fixturesEnv && existsSync(fixturesEnv)) {
    return fixturesEnv
  }

  const schemasEnv = process.env.EDICTUM_SCHEMAS_DIR
  if (schemasEnv) {
    const candidate = join(schemasEnv, FIXTURE_SUBPATH)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  const nested = join(REPO_ROOT, 'edictum-schemas', FIXTURE_SUBPATH)
  if (existsSync(nested)) {
    return nested
  }

  const sibling = resolve(REPO_ROOT, '..', 'edictum-schemas', FIXTURE_SUBPATH)
  if (existsSync(sibling)) {
    return sibling
  }

  return null
}

export function loadWorkflowAdapterFixtureSuites(
  dir: string,
): WorkflowAdapterFixtureSuite[] | null {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.workflow-adapter.yaml'))
    .sort()

  if (files.length === 0) {
    return null
  }

  return files.map((file) => {
    const content = readFileSync(join(dir, file), 'utf-8')
    let parsed: unknown

    try {
      parsed = yaml.load(content, { schema: yaml.CORE_SCHEMA })
    } catch (error) {
      throw new Error(`Failed to parse workflow adapter fixture ${file}: ${String(error)}`)
    }

    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as Record<string, unknown>).fixtures)
    ) {
      throw new Error(`Workflow adapter fixture ${file} is missing a fixtures array`)
    }

    return parsed as WorkflowAdapterFixtureSuite
  })
}
