# CLAUDE.md — Edictum JS

> Runtime rule enforcement for AI agent tool calls. TypeScript port of the edictum Python library with full feature parity.

## What is Edictum

Runtime rule enforcement for AI agent tool calls. Deterministic pipeline: checks before execution, output checks after execution, session rules, principal-aware enforcement. Framework adapters (Vercel AI SDK, OpenAI Agents SDK, OpenClaw, Claude Agent SDK, LangChain.js). One runtime dep in core (js-yaml). Full feature parity with the Python library (`edictum` on PyPI, v0.15.0).

Current version: 0.3.0 (npm: `@edictum/core`)

## THE ONE RULE

**`@edictum/core` runs fully standalone. No server dependency. No adapter dependency. No framework dependency.**

Core provides interfaces and implementations. The server package provides HTTP-backed implementations. Adapters are thin translation layers — rule enforcement logic stays in the pipeline.

## Architecture: Monorepo

```
packages/
├── core/              # @edictum/core — pipeline, rules, audit, session, YAML engine
├── vercel-ai/         # @edictum/vercel-ai — Vercel AI SDK adapter
├── openai-agents/     # @edictum/openai-agents — OpenAI Agents SDK adapter
├── openclaw/          # @edictum/openclaw — OpenClaw adapter
├── claude-sdk/        # @edictum/claude-sdk — Claude Agent SDK adapter
├── langchain/         # @edictum/langchain — LangChain.js adapter
└── server/            # @edictum/server — Server SDK (HTTP client, SSE, audit sink)
```

## Tech Stack

| Layer           | Technology          | Rationale                                                      |
| --------------- | ------------------- | -------------------------------------------------------------- |
| Language        | TypeScript (strict) | Security product — type safety is non-negotiable               |
| Runtime         | Node 22+ (LTS)      | Required by OpenClaw (P0 target), native fetch/structuredClone |
| Build           | tsup (esbuild)      | Dual ESM+CJS output, ~10 lines config                          |
| Test            | Vitest              | ESM-native, fast, good DX                                      |
| Lint            | ESLint              | Largest plugin ecosystem, best for security rules              |
| Package manager | pnpm                | Workspace monorepo support                                     |
| Module format   | Dual ESM + CJS      | Maximum compatibility via tsup                                 |

## Non-Negotiable Principles

1. **Full feature parity with Python.** 147 features across 12 categories. Every feature has a parity test ID. If Python passes and TS fails, it's a bug.
2. **Security is non-negotiable.** This is a security product. No shortcuts, no "good enough", no deferred fixes for vulnerabilities. Fail closed on every error path.
3. **Minimal runtime deps in core.** js-yaml is a direct dependency. Optional: ajv, @opentelemetry/\*, @noble/ed25519.
4. **Plain objects for rules.** Interfaces define the shape. TypeScript validates at compile time. No decorators, no builders, no hidden metadata.
5. **All async.** Every pipeline, session, and audit sink method is async. No sync variants.
6. **Immutability by default.** `ToolCall` is `Readonly<T>` + `Object.freeze()` + deep freeze. Principal is frozen. Rule state swaps atomically.
7. **Adapters are thin.** All rule enforcement logic lives in `CheckPipeline`. Adapters only translate between framework input/output and the pipeline.
8. **Adversarial tests before ship.** Every security boundary has bypass tests. Positive tests prove it works. Adversarial tests prove it doesn't break.

## Coding Standards

### TypeScript

- **TypeScript strict mode.** No `any` unless genuinely unavoidable and documented with a comment explaining why.
- **`Readonly<T>` for immutable data.** All tool-call, decision, and violation types are readonly.
- **`as const` + string literal unions** for enums. No TypeScript `enum` keyword.
- **`interface` for protocols.** StorageBackend, AuditSink, ApprovalBackend are all interfaces.
- **Async everywhere.** All pipeline, session, and audit sink methods are async.
- **No classes unless necessary.** Prefer plain objects + functions. Use classes only for stateful things (Edictum, Session, Pipeline).
- **Error hierarchy:** `EdictumError` (base) → `EdictumDenied`, `EdictumConfigError`, `EdictumToolError`.
- **`structuredClone()`** for deep copy. No JSON roundtrip, no lodash.
- **`Object.freeze()` + deep freeze** for immutable snapshots. Shallow freeze is insufficient for nested objects.
- **No `asyncio.Lock` equivalent needed.** Node is single-threaded — Map operations are atomic.

### General

- **Small, focused files (< 200 lines).** If a file grows past 200 lines, split it. Violations need explicit approval.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- **No premature abstraction.** Don't build extension points until there's a second user.
- **No over-engineering.** Only make changes that are directly requested or clearly necessary.

## Rule API Design

Rules use **plain objects** with TypeScript interfaces. This is the most AI-friendly and most explicit API:

```typescript
import { Decision, Edictum } from '@edictum/core'
import type { Precondition } from '@edictum/core'

const noRm: Precondition = {
  tool: 'Bash',
  check: async (toolCall) => {
    if (toolCall.bashCommand?.includes('rm -rf')) return Decision.fail('Cannot run rm -rf')
    return Decision.pass_()
  },
}

const guard = new Edictum({ rules: [noRm] })
```

Why plain objects: full autocomplete, compile-time validation, no hidden state, serializable, most reliable for AI-generated code.

## Terminology Enforcement

Inherited from the M1 terminology guide. ALL code, comments, docstrings, CLI output, and docs MUST use canonical terms in prose:

| Banned                   | Canonical              |
| ------------------------ | ---------------------- |
| contract / contracts     | rule / rules           |
| denied                   | blocked                |
| finding / findings       | violation / violations |
| engine / workflow / flow | pipeline               |
| shadow mode              | observe mode           |
| function call / action   | tool call              |
| contract bundle          | ruleset                |

**No exceptions in prose.**

For code identifiers, use the actual exported symbol names from the repo.

## API Design Checklist

Before adding any new public API:

- **Every accepted parameter has an observable effect.** If unimplemented, throw — never silently ignore.
- **Collection parameters have documented merge semantics.** Document whether it EXTENDS or REPLACES defaults.
- **Block decisions propagate end-to-end.** Trace block through every adapter. Never return "allow" after a blocked decision.
- **Callbacks fire exactly once.** Assert `callback.call_count === 1` in tests.
- **All adapters handle the new feature.** Run adapter parity tests after any change.

## Security Review Checklist

Before merging ANY code that touches these areas:

- **Path handling**: Uses `fs.realpathSync()` not just `path.normalize()`. Test with symlinks.
- **Shell command classification**: All shell metacharacters enumerated. Test with: `\n`, `\r`, `|`, `;`, `&&`, `||`, `$()`, `` ` ``, `${}`, `<()`, `<<`, `>`, `>>`
- **Error handling in backends**: `get()` and `increment()` fail-closed. Network errors propagate, only 404/missing returns null.
- **Audit action accuracy**: Audit events reflect what actually happened. Timeouts emit TIMEOUT, not GRANTED.
- **Input validation**: tool_name, session_id, any string used in storage keys validated for control characters.
- **Regex DoS**: All regex input capped at 10,000 characters.
- **Deep freeze**: Any frozen object with nested properties must use deep freeze, not just `Object.freeze()`.

## Behavior Test Requirement

Every public API parameter MUST have a behavior test.

A behavior test answers: "What observable effect does this parameter have?"

- Tests the parameter's effect through the public API
- Asserts a concrete difference between passing and not passing the parameter
- Lives in `packages/core/tests/behavior/`
- Keep test files focused: one file per module, under 200 lines

## Negative Security Test Requirement

Every security boundary MUST have bypass tests — tests that attempt to circumvent the boundary and verify the attempt is caught. Marked with `test.describe("security")` or equivalent.

Examples:

- Sandbox: symlink escape, double-encoding, null byte injection
- BashClassifier: every shell metacharacter individually
- Session limits: concurrent access patterns
- Input validation: null bytes, control characters, path separators in tool_name

## Feature Parity Matrix

147 features across 12 categories must pass in both Python and TypeScript. See memory file `project_parity_matrix_detail.md` for the full matrix with test IDs.

Cross-language validation: shared YAML rulesets + JSON input/output fixtures. Same input → same output → parity proven.

## Bug & Issue Triage Rule

When working in the project, if a bug, security issue, or problem is detected that was NOT in the initial prompt:

1. Triage — assess severity and whether it blocks current work
2. If fixable now without derailing the task → fix immediately and mention it
3. If not fixable now → create a GitHub issue in the repo with proper labels
4. **Never silently ignore a discovered issue**

## Build & Test

```bash
pnpm install                           # install all workspace deps
pnpm -r build                          # build all packages
pnpm -r test                           # test all packages
pnpm --filter @edictum/core test       # test core only
pnpm --filter @edictum/core build      # build core only
```

## Pre-Merge Verification

Every change MUST pass these checks before committing:

```bash
pnpm -r build                    # all packages build
pnpm -r test                     # full test suite
pnpm -r lint                     # eslint
pnpm -r typecheck                # tsc --noEmit
# If touching adapters:
pnpm --filter @edictum/core test -- --grep "adapter parity"
```

## YAML Schema

The ruleset schema lives in the `edictum-schemas` repo — single source of truth. Both this repo and the Python repo consume it as a dependency.

- `apiVersion: edictum/v1`, `kind: Ruleset`
- Rule types: `type: pre` (`action: block` / `action: ask`), `type: post` (`action: warn` / `action: redact` / `action: block`), `type: session` (`action: block` only), `type: sandbox` (allowlist-based)
- Conditions: `when:` with boolean AST (`all/any/not`) and leaves (`selector: {operator: value}`)
- 15 operators: exists, equals, not_equals, in, not_in, contains, contains_any, starts_with, ends_with, matches, matches_any, gt, gte, lt, lte
- Missing fields evaluate to `false`. Type mismatches yield block/warn + `policyError: true`

## Ecosystem Context

Edictum is four repos that work together:

- **edictum** (core Python): `edictum-ai/edictum` — MIT Python library. PyPI: `edictum`.
- **edictum-ts** (core TypeScript): THIS REPO — MIT TypeScript library. npm: `@edictum/core`.
- **edictum-console** (server): `edictum-ai/edictum-console` — Self-hostable FastAPI + React SPA.
- **edictum-schemas** (shared): `edictum-ai/edictum-schemas` — Shared YAML ruleset schema.

Both core libraries (Python and TS) work standalone. Console is an optional enhancement. Schema repo is the single source of truth for the ruleset format.

## Cross-SDK Conformance Workflow

When a change affects shared semantics, YAML validation, fixture behavior, audit/envelope wire format, or policy evaluation behavior, you MUST follow this workflow before merging:

1. **Update shared fixtures** in `edictum-schemas` — add or modify `fixtures/rejection/*.rejection.yaml` files as needed
2. **Update canonical Python behavior** in `edictum` if the change originates there
3. **Ensure all three SDKs pass** — Python (`edictum`), Go (`edictum-go`), and TypeScript (this repo) shared-fixture runners must all pass with `EDICTUM_CONFORMANCE_REQUIRED=1`
4. **Do not merge** parity-affecting behavior without the Parity Check workflow passing in all affected repos

The conformance runner in this repo lives at `packages/core/tests/yaml-engine/shared-fixtures.test.ts` and is executed in CI by:

```bash
EDICTUM_SCHEMAS_DIR=edictum-schemas EDICTUM_CONFORMANCE_REQUIRED=1 \
  pnpm --filter @edictum/core test -- --grep "shared rejection fixtures"
```

The `Parity Check` workflow (`.github/workflows/parity-check.yml`) runs on PRs to main, pushes to main, and weekly. It is intended to be a required status check.
