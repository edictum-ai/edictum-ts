# Changelog

## 0.4.0

- Breaking: canonical audit action values now emit `call_blocked`, `call_would_block`, `call_asked`, and `call_approval_blocked` instead of the older deny/request names.
- Add workflow lineage details to audit snapshots, including stage transitions, recorded evidence, session lineage, and richer adapter conformance coverage.
- Keep terminal workflow stages active unless an exit gate or approval explicitly advances them, matching the workflow state expected by the current demo and adapters.

## 0.3.2

- Add `WorkflowRuntime.setStage()` for non-destructive stage moves that preserve approvals and evidence.
