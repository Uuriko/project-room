# Fewer steps through deterministic UI — 2026-09-22

Implemented: a Results shortcut appears in the room sidebar only when completedResults returns usable results for the current owned session. It opens the existing result list directly and hides unrelated administrative sections for that visit. The direct view has no redundant collapse control. Normal Settings restores every existing section. No AI calls, new timer, API request or permissions change is added.

Desktop: from the visible sidebar, opening results takes one click instead of opening Settings and expanding Results. On a phone, Menu then Results remains two clicks, with a clearly named destination. Keyboard command-menu access stays available. Results is omitted when there is no usable result; reopening work removes it from the completed set. This is navigation automation, not automatic approval of work.

Existing exact-version readers, source details, draft preservation, focus restoration, failure recovery and authorization remain in place. Regression checks cover the automatic shortcut on desktop/phone, disappearance when all results reopen, preserving the draft and restoring normal Settings. 24/24 results/layout/actions/first-result browser checks pass. Changed-file lint has zero errors and two pre-existing prefer-const warnings. Phone screenshot inspected after eliminating duplicate heading/disclosure. No deployment in this checkpoint.

Further opportunities to evaluate, not claims of implemented features:
- Prefer one relevant next action from existing task state; keep alternatives discoverable rather than adding more permanent buttons.
- Remember deliberate per-user preferences within account/room boundaries; never reuse a previous recipient or permission silently.
- Group routine agent status updates deterministically while retaining the underlying history and keeping questions, blockers and review requests distinct.
- Fix durable notification coverage before adding more notification indicators. Existing 500-event truncation is still open.
- Retain explicit controls for sending, sharing private context, changing access and approving work.

Unified messaging/connector development remains paused. Real participant testing remains pending; these are automated regression checks and visual inspection.
