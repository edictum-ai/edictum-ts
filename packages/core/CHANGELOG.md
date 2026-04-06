# Changelog

## 0.3.3

- Hydrate `pendingApproval` immediately when `WorkflowRuntime.setStage()` enters an approval stage.
- Keep no-exit workflow stages active for legitimate current-stage work and only advance on legitimate downstream work.
- Support `set_stage_to` adapter conformance fixtures so the shared workflow schema can lock both behaviors down.

## 0.3.2

- Add `WorkflowRuntime.setStage()` for non-destructive stage moves that preserve approvals and evidence.
