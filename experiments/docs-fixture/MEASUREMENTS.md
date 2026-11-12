# Local workflow measurement: recover an unsaved draft

Fixture: Project Room documents candidate PR #6139 at f75033cbd5187840fc6d5d9036f996fdbd41c585, synthetic room, local browser at 127.0.0.1:43874. This is not a production experiment.

Scenario: open Connection runbook, open the editor, enter unique unsaved text, then reload the same tab. Outcome is whether the exact text is visible and editable after reload.

| Observation | Before | After |
| --- | --- | --- |
| Computer-use recovery | 0 of 1: draft lost | 1 of 1: draft restored with the editor open |
| Explicit recovery indication | None | Visible message identifies an unsaved draft |
| Stale revision safety | Not tested in this reload scenario | Automated check: competing save produces a conflict; draft retained; explicit rebase required |

These are single paired demonstrations, not estimates of reliability or time saved. No stopwatch measurement was made. Session storage is tab-scoped and can be unavailable; closing the tab is outside the recovery guarantee. An automated regression also checked typing after rebasing, subsequent save, and removal of a saved draft.

A second workflow improvement removed the automated reader check's dependence on a fixed revision. It initially failed after an earlier experiment legitimately changed that revision; it now verifies a numeric revision without assuming the seeded value. The reader and draft-recovery checks passed after that change. Keep experiments sequential when they mutate the same fixture; use independent fixture instances for parallel comparisons.
