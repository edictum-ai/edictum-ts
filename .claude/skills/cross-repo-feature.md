# Cross-Repo Feature Implementation Guide

You are implementing a feature that affects multiple edictum repos. This repo (edictum-ts) is a PORT — Python is the reference implementation.

> **Prerequisite:** This skill requires `../edictum/` (Python reference) and `../edictum-schemas/` (fixtures) to be cloned as sibling directories. If either is absent, **stop and notify the user** before proceeding.

## Step 1: Check the Reference

Before writing code, **read** the Python implementation — do not just list files:

```bash
# Read the module source
cat ../edictum/src/edictum/<module>.py
# Read the behavior tests
cat ../edictum/tests/test_behavior/test_<module>.py
```

If `../edictum/` is not present, **stop here** — you cannot verify parity without the reference.

## Step 2: Check Shared Fixtures

Read the behavioral fixtures for this feature:

```bash
cat ../edictum-schemas/fixtures/behavioral/<feature>.json
cat ../edictum-schemas/fixtures/adversarial/<feature>.json
```

If fixtures don't exist, **they must be created in edictum-schemas first** before porting. The fixtures are the parity spec — they define "correct behavior."

## Step 3: Implement the Port

1. Match the Python API surface (method names use camelCase, not snake_case)
2. Write TypeScript-native behavior tests in `packages/core/tests/behavior/` (one file per module, under 200 lines)
3. Verify shared fixtures pass
4. Run full suite: `pnpm -r test`
5. Create PR referencing the tracking issue

## Step 4: Fixture Runner

Run shared fixtures against your implementation:

```bash
pnpm --filter @edictum/core test -- --grep "behavioral fixtures"
```

If any fixture fails, **stop** — do not open a PR. Fix the implementation until all fixtures pass.

If the fixture runner doesn't exist yet, create it in `packages/core/tests/behavioral-fixtures.test.ts`.

## Step 5: Cross-Repo Issues

If you find a bug that exists in multiple repos, file ONE issue in `edictum-ai/.github` with the `cross-repo` label.

## Checklist Before Merging

- [ ] `pnpm -r build` — all packages build
- [ ] `pnpm -r test` — full test suite passes
- [ ] `pnpm -r lint` — ESLint clean
- [ ] `pnpm -r typecheck` — tsc --noEmit passes
- [ ] Shared fixtures pass
- [ ] Python parity verified (same inputs → same outputs)
- [ ] Behavior tests in `packages/core/tests/behavior/` cover every public API parameter
- [ ] Security tests in `describe("security")` blocks
- [ ] Security review: path handling, shell classification, fail-closed errors, input validation
- [ ] Terminology matches `CLAUDE.md` Terminology Enforcement section
- [ ] If touching adapters: `pnpm --filter @edictum/core test -- --grep "adapter parity"`
- [ ] Tracking issue updated with PR link
