# Cross-Repo Feature Implementation Guide

You are implementing a feature that affects multiple edictum repos. This repo (edictum-ts) is a PORT — Python is the reference implementation.

## Step 1: Check the Reference

Before writing code, check the Python implementation:

```bash
# What does the Python version look like?
ls ../edictum/src/edictum/
# What tests exist?
ls ../edictum/tests/test_behavior/
```

## Step 2: Check Shared Fixtures

Verify behavioral fixtures exist for this feature:

```bash
ls ../edictum-schemas/fixtures/behavioral/
ls ../edictum-schemas/fixtures/adversarial/
```

If fixtures don't exist, **they must be created in edictum-schemas first** before porting. The fixtures are the parity spec — they define "correct behavior."

## Step 3: Implement the Port

1. Match the Python API surface (method names use camelCase, not snake_case)
2. Write TypeScript-native tests in `packages/core/tests/`
3. Verify shared fixtures pass
4. Run full suite: `pnpm -r test`
5. Create PR referencing the tracking issue

## Step 4: Fixture Runner

Run shared fixtures against your implementation:

```bash
pnpm --filter @edictum/core test -- --grep "behavioral fixtures"
```

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
- [ ] TypeScript-native tests written
- [ ] Security tests in `describe("security")` blocks
- [ ] Security review: path handling, shell classification, fail-closed errors, input validation
- [ ] Terminology matches `CLAUDE.md` Terminology Enforcement section
- [ ] If touching adapters: `pnpm --filter @edictum/core test -- --grep "adapter parity"`
- [ ] Tracking issue updated with PR link
