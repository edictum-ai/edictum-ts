# Review Template Instructions

Read `.github/review-template.md` and fill in the placeholders.

## Placeholder values

### Status

- `{status}`: One of `pass`, `warn`, `fail`
- `{status_icon}`: Use based on status:
  - pass: `✅`
  - warn: `⚠️`
  - fail: `🚨`
- `{status_summary}`: One line based on status:
  - pass: `**All checks passed.** No issues found in this PR.`
  - warn: `**{n} warning(s) found.** No critical issues, but some items need attention.`
  - fail: `**{n} issue(s) found** including **{c} critical**. These should be resolved before merging.`

### Sections

Only include a section if it has content. Remove the placeholder entirely if empty.

`{critical_section}` — if there are critical issues:

````markdown
### 🔴 Critical

> **These must be fixed before merging.**

| #   | File                          | Issue                | Violates                          |
| --- | ----------------------------- | -------------------- | --------------------------------- |
| 1   | `packages/core/src/foo.ts:42` | Description of issue | [CLAUDE.md — ONE RULE](CLAUDE.md) |

<details>
<summary>Details</summary>

**1. `packages/core/src/foo.ts:42` — Short title**

Description of the issue with context.

**Suggested fix:**

```typescript
// suggestion here
```
````

</details>
```

`{warnings_section}` — if there are warnings:

```markdown
### 🟡 Warnings

| #   | File                          | Issue       | Violates                             |
| --- | ----------------------------- | ----------- | ------------------------------------ |
| 1   | `packages/core/src/bar.ts:15` | Description | [CLAUDE.md — Terminology](CLAUDE.md) |

<details>
<summary>Details</summary>

**1. `packages/core/src/bar.ts:15` — Short title**

Description with context.

</details>
```

`{suggestions_section}` — if there are suggestions:

```markdown
### 🔵 Suggestions

| #   | File                       | Suggestion  |
| --- | -------------------------- | ----------- |
| 1   | `packages/core/src/baz.ts` | Description |

<details>
<summary>Details</summary>

**1. `packages/core/src/baz.ts` — Short title**

Description.

</details>
```

`{clean_section}` — only when status is `pass`:

```markdown
### ✅ Checks passed

| Check         | Status   |
| ------------- | -------- |
| Core boundary | ✅ Clean |
| Terminology   | ✅ Clean |
| Security      | ✅ Clean |
| ...           | ...      |
```

Only list checks that were actually applied (based on file types changed).

### File list

`{file_count}`: Number of files reviewed.

`{file_list}`: Markdown list of changed files with status:

```markdown
- ✏️ `packages/core/src/pipeline.ts` (modified)
- ✨ `.github/workflows/review.yml` (new)
- 🗑️ `packages/core/src/old.ts` (deleted)
```

### Checks applied

`{checks_applied}`: Comma-separated list of check categories that were relevant, e.g.:
`Core boundary · Code quality · Terminology · Security · Adapter parity`

## Rules

- Always start the comment with `<!-- edictum-review -->` (first line, no exceptions)
- Keep the summary table compact — details go in expandable sections
- Link "Violates" references to the actual file in the repo
- If zero issues: status is `pass`, include `{clean_section}`, omit issue sections
- If only suggestions: status is `pass` (suggestions do NOT elevate to warn)
- If any warnings: status is `warn`
- If any critical: status is `fail`
- A PR with only suggestions is a PASSING review — do not set status to warn
