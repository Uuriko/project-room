# Normalized handoff and halt clear

The existing `work.handoff_recorded` and `work.halt_cleared` actions were blocked at current-record dependency admission. The current command context already reads the selected protected work body, owner/member authority, and agent halts. Both commands now use that context and the unchanged shared reducers. Halt-clear additionally reads its explicitly addressed target halt even if that member is absent from the current roster; the existing reducer decides whether the exact halt may be cleared.

A handoff preserves the canonical task and completion gates. It may halt the actor, keeps at most 20 previous handoffs, and routes triage to the owner. Existing contribute-profile enforcement still applies. Clearing a halt requires steer or decide and the exact halt event; clearing does not modify the task. Existing start or completion resumes work without a new orchestration system.

The baseline causal tests failed with `no qualified current-record dependency plan`. Four new Node controls plus ten existing neighboring controls pass. Actual Worker qualification covers a lost committed handoff response, cold exact retry with zero adapter writes, halt enforcement, failure after the real current-head insert during clear, exact transaction rollback, cold restart, clear/start of the original task, and full independent audit. The closed current writer permit remains intact. Receipt: `audit/evidence/current-work-handoff-20261101.json`.

This is an offline runtime checkpoint. It does not activate floor 45, qualify unrelated unsupported commands, or certify historical provenance. The latest composed recovery protocol still requires whole-candidate qualification.
