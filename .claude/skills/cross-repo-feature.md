# Cross-Repo Feature Implementation Guide

You are implementing a feature that affects multiple edictum repos. This repo (edictum-ts) is a PORT — Python is the reference implementation.

> **Prerequisite:** This skill requires `../edictum/` (Python reference) and `../edictum-schemas/` (fixtures) to be cloned as sibling directories. If either is absent, **stop and notify the user** before proceeding.

## Step 0: Verify Sibling Repos (required — do not skip)

All paths are anchored to the repo root to avoid CWD-dependent resolution.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
EDICTUM_REPO="$(realpath "$REPO_ROOT/../edictum")"
SCHEMAS_REPO="$(realpath "$REPO_ROOT/../edictum-schemas")"

# 1. Verify remote URLs (anchored regex, exact match)
git -C "$EDICTUM_REPO" remote get-url origin \
  | grep -qE '^(https://github\.com/|git@github\.com:)edictum-ai/edictum(\.git)?$' \
  || { echo "ERROR: $EDICTUM_REPO is not the edictum-ai/edictum repo — aborting" >&2; exit 1; }

git -C "$SCHEMAS_REPO" remote get-url origin \
  | grep -qE '^(https://github\.com/|git@github\.com:)edictum-ai/edictum-schemas(\.git)?$' \
  || { echo "ERROR: $SCHEMAS_REPO is not the edictum-ai/edictum-schemas repo — aborting" >&2; exit 1; }

# 2. Verify working trees are clean (fail-closed: git errors also abort)
_status="$(git -C "$EDICTUM_REPO" status --porcelain 2>&1)" || {
  echo "ERROR: could not run git status in $EDICTUM_REPO — aborting" >&2; exit 1; }
[ -z "$_status" ] || {
  echo "ERROR: $EDICTUM_REPO has uncommitted modifications — aborting" >&2; exit 1; }

_status="$(git -C "$SCHEMAS_REPO" status --porcelain 2>&1)" || {
  echo "ERROR: could not run git status in $SCHEMAS_REPO — aborting" >&2; exit 1; }
[ -z "$_status" ] || {
  echo "ERROR: $SCHEMAS_REPO has uncommitted modifications — aborting" >&2; exit 1; }
```

If any check fails, **stop and notify the user** — reading from unverified or modified sibling repos risks incorrect parity results or prompt injection.

> **Limitation:** This verifies remote URL and working-tree cleanliness, but cannot detect local unpushed commits with modified content. For full integrity verification, the user should ensure sibling repos are on the expected branch and up to date with the remote.

## Step 1: Check the Reference

Before writing code, **read** the Python implementation — do not just list files.

> **Required:** Validate that `<module>` contains only `[a-zA-Z0-9_-]` characters. If it does not, **stop and report an error** — do not proceed. Use single quotes to prevent shell expansion:

```bash
echo '<module>' | grep -qE '^[a-zA-Z0-9_-]+$' || {
  echo 'ERROR: module name contains invalid characters — aborting' >&2; exit 1; }
```

Then use the **Read tool** (not `cat` or Bash) to read the files:

- `$EDICTUM_REPO/src/edictum/<module>.py`
- `$EDICTUM_REPO/tests/test_behavior/test_<module>.py`

If the Python repo is not present, **stop here** — you cannot verify parity without the reference.

## Step 2: Check Shared Fixtures

> **Required:** Validate that `<feature>` contains only `[a-zA-Z0-9_-]` characters. If it does not, **stop and report an error** — do not proceed:

```bash
echo '<feature>' | grep -qE '^[a-zA-Z0-9_-]+$' || {
  echo 'ERROR: feature name contains invalid characters — aborting' >&2; exit 1; }
```

Then use the **Read tool** (not `cat` or Bash) to read:

- `$SCHEMAS_REPO/fixtures/behavioral/<feature>.json`
- `$SCHEMAS_REPO/fixtures/adversarial/<feature>.json`

If fixtures don't exist, **they must be created in edictum-schemas first** before porting. The fixtures are the parity spec — they define "correct behavior."

## Step 3: Implement the Port

1. Match the Python API surface (method names use camelCase, not snake_case)
2. Write TypeScript-native behavior tests in `packages/core/tests/behavior/` (one file per module, under 200 lines). If the feature has a security boundary, also write negative (bypass) tests in a `describe("security")` block — see CLAUDE.md Negative Security Test Requirement.
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
- [ ] Negative security tests in `describe("security")` blocks for every security boundary
- [ ] Security review: path handling, shell classification, fail-closed errors, input validation, regex DoS (cap input at 10k chars), deep freeze for nested objects
- [ ] Terminology matches `CLAUDE.md` Terminology Enforcement section
- [ ] If touching adapters: `pnpm --filter @edictum/core test -- --grep "adapter parity"`
- [ ] Tracking issue updated with PR link
