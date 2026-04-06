# CLAUDE.md — Edictum TypeScript

> Developer agent behavior platform for TypeScript. Write rules and workflows in YAML. Enforce them at the tool-call boundary.

## What Is In This Repo

Edictum for TypeScript ships the core rules engine, Workflow Gates runtime, server integration, and adapter packages for Vercel AI SDK, LangChain.js, OpenAI Agents SDK, and Claude Agent SDK. OpenClaw support lives in the separate `edictum-openclaw` repo.

Current package versions: `@edictum/core` 0.3.2, `@edictum/server` 0.3.1, `@edictum/vercel-ai` 0.2.0, `@edictum/claude-sdk` 0.2.0, `@edictum/langchain` 0.2.0, `@edictum/openai-agents` 0.2.0, `@edictum/otel` 0.2.0

## The One Rule

**`@edictum/core` stays standalone. No server dependency. No adapter dependency. No framework dependency.**

Core owns the rules engine and workflow runtime. The server package provides HTTP-backed implementations. Adapters are thin translation layers. Enforcement logic stays in the pipeline.

## Monorepo Layout

```text
packages/
├── core/              # @edictum/core — pipeline, rules, decision log, session, YAML engine
├── vercel-ai/         # @edictum/vercel-ai — Vercel AI SDK adapter
├── openai-agents/     # @edictum/openai-agents — OpenAI Agents SDK adapter
├── claude-sdk/        # @edictum/claude-sdk — Claude Agent SDK adapter
├── langchain/         # @edictum/langchain — LangChain.js adapter
├── otel/              # @edictum/otel — OpenTelemetry integration
└── server/            # @edictum/server — server SDK (HTTP client, SSE, decision-log sink)
```

## Tech Stack

| Layer           | Technology          | Why                                                 |
| --------------- | ------------------- | --------------------------------------------------- |
| Language        | TypeScript (strict) | Type safety matters for an enforcement library      |
| Runtime         | Node 22+            | Required by OpenClaw target and modern runtime APIs |
| Build           | tsup                | Dual ESM + CJS output                               |
| Test            | Vitest              | Fast and ESM-native                                 |
| Lint            | ESLint              | Mature tooling and custom rule support              |
| Package manager | pnpm                | Workspace monorepo support                          |

## Non-Negotiable Principles

1. **Full feature parity with Python.** If Python passes and TypeScript fails, it is a bug.
2. **Fail closed.** Invalid input, storage errors, and evaluation errors must not silently allow tool calls.
3. **Minimal runtime deps in core.** `js-yaml` is the only direct runtime dependency in `@edictum/core`.
4. **Plain objects for rules.** No builders, decorators, or hidden metadata.
5. **Async everywhere.** Pipeline, session, storage, approvals, and decision-log sinks are async.
6. **Immutability by default.** Tool calls and snapshots are frozen.
7. **Adapters stay thin.** They translate SDK callbacks to `CheckPipeline`; they do not invent new enforcement behavior.
8. **Adversarial tests before ship.** Boundaries need bypass tests, not just happy-path tests.

## Coding Standards

### TypeScript

- **Strict mode.** No `any` unless unavoidable and documented.
- **`Readonly<T>` for immutable data.** Tool-call, decision, and violation types are readonly.
- **String literal unions over `enum`.**
- **Interfaces for protocols.** `StorageBackend`, `AuditSink`, and `ApprovalBackend` stay interface-based.
- **Async everywhere.**
- **Classes only for stateful concerns.** `Edictum`, `Session`, and pipeline/runtime classes are fine.
- **Use `structuredClone()` and deep freeze** for immutable snapshots.

### General

- **Keep files focused.** Split large files unless there is a good reason to keep the unit together.
- **Use conventional commits.**
- **Do not build abstraction for its own sake.**
- **Make the smallest change that actually solves the problem.**

## Terminology

In prose, use these terms:

- `rule`, `ruleset`, `tool call`, `blocked`, `violation`, `observe mode`
- `Workflow Gates`, `decision log`, `dashboard`, `enforcement`

When you refer to code, use the real exported identifier names from the repo.

## API Design Checklist

Before adding a public API:

- Every accepted parameter must have an observable effect
- Document collection merge semantics
- Block decisions must propagate through every adapter path
- Callbacks must fire exactly once
- Shared behavior changes must be covered in adapter parity tests

## Review Checklist

Before merging changes that touch boundary behavior:

- Path handling must use real-path aware logic where needed
- Shell command classification must cover metacharacters and edge cases
- Backend errors must stay fail-closed
- Decision-log action values must match what actually happened
- Storage keys and identifiers must reject control characters
- Regex inputs must stay size-limited
- Deep freeze must be used for nested immutable objects

## Behavior Test Requirement

Every public API parameter needs a behavior test:

- The test goes through the public API
- The test proves a real behavioral difference
- Core behavior tests live in `packages/core/tests/behavior/`

## Boundary Test Requirement

Every boundary needs bypass tests. Examples:

- Sandbox path escape attempts
- Bash metacharacter coverage
- Session-limit edge cases
- Identifier validation with null bytes and control characters

## Build And Test

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm --filter @edictum/core test
pnpm --filter @edictum/core build
```

## Pre-Merge Verification

```bash
pnpm -r build
pnpm -r test
pnpm -r lint
pnpm -r typecheck
pnpm --filter @edictum/core test -- --grep "adapter parity"
```

## YAML Shapes

The schema lives in `edictum-schemas`.

- `apiVersion: edictum/v1`, `kind: Ruleset`
- Rule types: `pre`, `post`, `session`, `sandbox`
- Actions: `block`, `ask`, `warn`, `redact`
- Conditions live under `when:`
- `kind: Workflow` uses `stages`, `entry`, `exit`, `checks`, `tools`, and optional `approval`
- Use `exec(...)` conditions only when `WorkflowRuntime` is created with `execEvaluatorEnabled: true`

## Ecosystem Context

- `edictum`: Python SDK
- `edictum-ts`: this repo
- `edictum-go`: Go SDK
- `edictum-openclaw`: OpenClaw adapter
- `edictum-console`: self-hosted dashboard
- `edictum-schemas`: shared YAML schema

## Cross-SDK Conformance Workflow

When a change affects shared semantics, YAML validation, fixture behavior, wire format, or policy evaluation:

1. Update shared fixtures in `edictum-schemas`
2. Update canonical Python behavior in `edictum` if needed
3. Ensure Python, Go, and TypeScript shared-fixture runners all pass with `EDICTUM_CONFORMANCE_REQUIRED=1`
4. Do not merge parity-affecting behavior until the parity workflow passes

The TypeScript conformance runner lives at `packages/core/tests/yaml-engine/shared-fixtures.test.ts`.
