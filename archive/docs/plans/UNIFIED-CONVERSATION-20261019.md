# Unified conversation implementation

John approved the conversation-first simplification on 2026-10-19. Build on
entry PR4243 and focused PR4244; preserve the recovery fixes in carrier4245.

## Build order

1. Reconcile branch heads, carrier claims and hosted failures. Existing unit
   shards pass; browser and coverage failures are unresolved, not waived.
2. Extract deterministic mention/reply routing. Ordinary multiplayer messages
   stay ordinary. Direct links to recorded requests, contributions and results
   establish continuity. Keep privacy, channel and revision boundaries.
3. Integrate routing with the existing atomic submit operation. Preserve visible
   mentions; remove hidden selection mode. Keep exact retry IDs and draft data.
4. Replace permanent Ask Room with contextual contribution controls. Put setup
   in settings and provide a contextual path when an agent is unavailable.
5. Attach status to each request conversation; preserve Stop, input requests,
   recovery and attribution. Eliminate duplicate global status/history display.
6. Reuse the result reader for opening and revising results. Keep versions and
   drafts across navigation, and provide a focused mobile reader.
7. Exercise two simulated participants plus an agent, both themes and narrow
   screens. Fix genuine hosted failures, review actual screenshots, then merge
   and deploy through the existing serialized release process.

## Constraints

Reuse assistant runs, contributions, atomic submit, revision fences and result
records. Do not invent another session service. No ambient execution from
unaddressed group chat. No mandatory planning form or permanent dashboard.
No scheduled automation. Developer ID distribution remains deferred. Simulated
participants are functional evidence, not evidence of real human productivity.

## Implementation checkpoint

- Removed the permanent Ask Room toggle and hidden selected mode. Assistant
  mentions remain in the draft and posted message. A contextual cancellation
  control exists only while explicitly contributing to an existing request.
- Integrated deterministic routing with the existing atomic submit endpoint.
  Ordinary replies to recorded requests and additions continue the same run;
  completed results start another request without reopening completed execution.
- Preserved attributed inputs, exact retry IDs, attempt and revision checks,
  drafts, private-message boundaries and explicit scope resolution permissions.
- Assistant connection lives in settings. Work history is available in a compact
  disclosure above the conversation, with active and needs-input counts.
  Current status follows the viewed channel/thread and mounts beneath its source
  message when loaded. The prompt is not repeated there. Recovery remains visible.
- PR4245 owner released the UI paths and preserved its branch at55532407.
  Its unavailable-assistant routing and error hints are retained here. Its
  independent account/invitation fixes still need integration at release.
- Registered the new module in both public-asset and runtime-package contracts.

## Evidence and remaining work

- Routing and existing face-status tests:13/13 passed.
- Composer, entry and agent-connection browser tests before the history move:
  45/45 passed. Normal Reply also passed the two-person durable-run journey.
- Affected tests at the first routing checkpoint:1764 passed,1 skipped.
- Final history/context/inline browser run:28/29 passed; the remaining check
  still looked for focus inside the removed panel. Updated it to check the actual
  inline card; focused rerun passed, including disappearance of the Stop button.
- Full Node24 run:11,374 passed,31 skipped,1 manifest-drift failure while the UI
  source was being finalized. After freezing the manifest, that preflight check
  passed. The final routing/face cases also pass13/13. These are composed results,
  not a claim that the original full run was entirely green.
- Existing parent browser failures and coverage failure must be reconciled
  before landing. The observed coverage failure matches random errorId text
  against a driver-message regex; preserve the driver-text boundary while fixing
  that assertion. The assertion now validates random ID shape separately and
  scans the remaining response for driver text; all5 storage-failure tests pass.
- The selected current run stays inline. Concurrent runs are accessible from
  Work without opening settings. Do not automatically add a large card beneath
  every message: use compact contextual status and existing result links. The
  expanded result reader/revision journey remains separate follow-up work.
- No production deployment or claim of real-human qualification.

## Compact work access follow-up

The next slice corrects the history placement without adding a second work
model. The collapsed summary reports active requests and requests needing input;
it disappears when there is no history. Expanded rows preserve the existing
request, result, pause, stop and contribution controls. Jumping to a message or
contribution closes the disclosure. Escape closes it and restores summary focus.
Session/room changes reset the disclosure. On phones the row controls wrap, and
the history list is bounded so conversation and composer remain reachable.

This is a functional iteration, not a claim of optimal design. Screenshot review
still shows repeated status inside expanded rows and verbose pre-existing work
cards. The result reader and those cards should be simplified as the next slice,
with source attribution and recovery controls preserved.

Validation for the compact-work follow-up: affected suite 1,911 passed, one
skipped; lint passed with 291 existing warnings. Initial browser run had 25
passes, two failures and two timeouts from four cases still opening Settings.
Corrected navigation and reran those four: all passed. The layout case also
passed at desktop/phone sizes in both themes, including Escape/Enter disclosure
behavior, horizontal bounds and composer visibility. Screenshots are synthetic.

Final frozen-source Node24 full suite: 11,375 passed, 31 skipped, zero failures
(562 seconds). No runtime edits occurred during this qualification run.
