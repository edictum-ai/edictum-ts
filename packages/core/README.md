# @edictum/core

Version `0.3.2`.

Rules engine and workflow runtime for Edictum. Write rules and workflows in YAML. Enforce them at the tool-call boundary.

## Install

```bash
pnpm add @edictum/core
```

## Run a ruleset

```typescript
import { readFile } from 'node:fs/promises'
import { Edictum, EdictumDenied } from '@edictum/core'

const guard = Edictum.fromYaml('rules.yaml')
const governedReadFile = (args: Record<string, unknown>) => readFile(args.path as string, 'utf8')

try {
  await guard.run('readFile', { path: '.env' }, governedReadFile)
} catch (error) {
  if (error instanceof EdictumDenied) {
    console.log(error.reason)
  }
}
```

```yaml
apiVersion: edictum/v1
kind: Ruleset
metadata:
  name: file-safety
rules:
  - id: block-sensitive-reads
    type: pre
    tool: readFile
    when:
      args.path:
        contains_any: ['.env', '.pem', 'id_rsa']
    then:
      action: block
      message: 'Blocked sensitive file read: {args.path}'
```

## Add Workflow Gates

```typescript
import { readFile } from 'node:fs/promises'
import { Edictum, WorkflowRuntime, loadWorkflowString } from '@edictum/core'

const workflow = loadWorkflowString(await readFile('workflow.yaml', 'utf8'))
const workflowRuntime = new WorkflowRuntime(workflow, {
  execEvaluatorEnabled: true,
})

const guard = Edictum.fromYaml('rules.yaml', { workflowRuntime })
```

Workflow Gates use `kind: Workflow` documents with `stages`, `entry`, `exit`, `checks`, and optional `approval`.

## Key Exports

- `Edictum`, `EdictumDenied`, `EdictumConfigError`, `EdictumToolError`
- `Decision`, `CheckPipeline`, `run`
- `Session`, `MemoryBackend`, `LocalApprovalBackend`, `RedactionPolicy`
- `CollectingAuditSink`, `StdoutAuditSink`, `FileAuditSink`, `CompositeSink`
- `WorkflowRuntime`, `loadWorkflow`, `loadWorkflowString`, `WorkflowAction`
- Workflow definition types: `WorkflowDefinition`, `WorkflowStage`, `WorkflowGate`, `WorkflowCheck`, `WorkflowApproval`, `WorkflowRuntimeOptions`
- Workflow state types: `WorkflowContext`, `WorkflowEvaluation`, `WorkflowState`, `WorkflowPendingApproval`, `WorkflowRecordedEvidence`, `WorkflowBlockedAction`
- YAML engine helpers: `fromYaml`, `fromYamlString`, `reload`, `loadBundle`, `loadBundleString`, `composeBundles`

## What Core Includes

- Deterministic ruleset evaluation with pre, post, session, and sandbox rules
- Workflow Gates with stage state, approvals, and recorded evidence
- Decision log helpers and redaction support
- Framework-agnostic tool wrapping through `guard.run()` and `run()`

## Links

- [Full documentation](https://docs.edictum.ai)
- [GitHub](https://github.com/edictum-ai/edictum-ts)
- [All packages](https://github.com/edictum-ai/edictum-ts#packages)
