# Further work: private reminders, then assignment watching

September 7, 2026 · Follow-up to [Portable work](PORTABLE-WORK-PLAN-2026-09-07.md).

Implementation companion: [product research and next-phase decisions](CALM-COOPERATION-RESEARCH-2026-09-07.md).

## Outcome and scope

Build one complete next capability: **Remind me about this work**, privately and durably. Someone can schedule, reschedule or cancel a reminder, leave Room, and see it when they return with the same identity. The ordinary conversation stays unchanged. This checkpoint implements reminders and their migration/API/UI/tests; the later assignment watcher remains a separate checkpoint.

Use the existing SQLite-backed RoomStore on Node and Cloudflare, the existing authentication, and the existing quiet work/catch-up layout. No provider, model, subscription, email, push notification, operating-system notification, alarm or background worker is needed. Do not upgrade live databases, deploy, change bindings or run existing preview data through the new schema during development. Use disposable fixtures only.

### Product contract

- One personal reminder per work item. The person setting it is derived from authentication; there is no target-member field.
- Meaning: **show this reminder while the work remains unresolved**. Ordinary edits, claims or messages do not cancel it.
- Resolved follows the shared `terminalWork()` predicate, including required review/decision—not merely `state=completed`.
- A terminal/superseded work item retires its reminder permanently. Reopening work does not resurrect it. Scheduling again requires an explicit action after the work is unresolved.
- Revoking membership/account access retires affected reminders. Re-enabling access does not resurrect them. Ordinary logout, key rotation and session expiry preserve them.
- Delivery is in-app only: **Private. Appears here when you return.** A due time is not a promise of an off-app alert, and an expired guest cannot regain an old identity through a display name.
- Setting, reading, dismissing or cancelling reminders does not change work, send room messages, advance a human read marker, or create an AI handoff.

## 1. Storage and request contract

Add `private_reminders`, keyed by `(room_id, member_id, work_item_id)`:

- integer revision, initially 1, incremented for schedule/cancel/automatic retirement;
- absolute UTC `due_at` milliseconds;
- state `active`, `cancelled`, or `resolved`;
- basis work revision for context, creation and update times.

Retain inactive rows so a deliberate reschedule can use the current revision. Bound total rows by existing room/work/member pilot limits. Add only indexes that serve actual queries: personal rows, active-by-work retirement, and request lookup.

Add `private_reminder_commands`, keyed by `(room_id, member_id, request_id)`, with canonical fingerprint and original response JSON. Never reuse the public command ledger: it requires a public event and would expose private preferences. Never prune receipts in a way that makes an old Set look new.

Authenticated `GET /api/rooms/:roomId/reminders` returns current personal rows, server `evaluatedAt`, and the existing account/member/session ownership envelope. Include inactive revisions for future CAS; the UI displays only active rows. Sort active items by due time on the client. No reminder fields enter public snapshots, return briefs, exports, shared event history or SSE.

Authenticated `POST` to the same path accepts only `requestId`, `workItemId`, `expectedRevision`, `action` (`schedule` or `cancel`), and `dueAt` for schedule. Revision 0 means no prior reminder row. Use the normal browser Origin/CSRF/session binding rules and existing rate limits; provisioned agent keys use their own member identity.

Transaction order:

1. Authenticate current access and ownership.
2. Strictly validate the request shape and look up its stable ID/fingerprint.
3. Return a matching original receipt before current-revision/date checks; reject changed reuse.
4. Resolve the current work/reminder, enforce expected reminder revision and semantic limits.
5. Save the new row and receipt atomically.
6. Return the historical receipt plus a freshly evaluated personal view, so an old successful Set retry cannot be mistaken for a currently active reminder after Cancel.

Allow schedule times strictly after server now and within 365 days. Limit active reminders to 100 per member/room and new schedule receipts to 5000. At that receipt limit, still permit cancelling existing active reminders; this adds at most the active-row limit of receipts. New cancel requests for inactive/nonexistent reminders are rejected; identical committed retries still succeed. Never silently drop an old schedule to admit a new one.

## 2. Lifecycle integration

After successful domain application in `RoomStore.command()`, but before transaction commit:

- evaluate affected work with `terminalWork()` and resolve all its active reminders;
- on `MEMBER_ACCESS_CHANGED active:false`, retire that member's active reminders;
- let transaction rollback include both public work changes and private retirement.

In `changeAccountAccess(active:false)`, retire active reminders across `member_accounts` bindings in the same transaction. Do not add retirement to credential-only methods. Automatic retirement increments revision to block stale tabs from silently rearming.

No periodic scan is necessary for normal due delivery: due is `active && dueAt <= evaluatedAt`. Fresh reads and local visible-tab time handling surface it. Restart loses no schedule because the database is authoritative. Reads never dismiss anything.

## 3. Schema v8 and compatibility

Explicitly retain v7 in the startup migration allowlist. Create the two new tables inside the existing all-or-nothing migration transaction. Update audit version guidance and migration fixtures without weakening historical-v6 assertions.

### Node

Register current v8 writer function plus historical v6/v7 functions. Retain exact historical guards and install v8 guards on every mutable table, including both private tables. An already-open v7 connection lacks the v8 function and must fail writes after migration. Verify source v7 guard definitions before any migration changes; corruption must fail closed.

### Cloudflare

The old guard reads a database-global version marker; it is not an identity for a cached old writer. Simply replacing v7 guards with marker-based v8 guards would let a cached old adapter write without running reminder retirement. Address this explicitly.

Use a small Cloudflare-only synchronous writer permit, closed when idle. Current v8 transactions open it inside `transactionSync`, run the requested work, close it before commit, and never await/reenter. V8 guards require both the v8 marker and the current permit. Standalone writes through the new adapter use that same transaction wrapper. A cached v7 adapter never opens the permit and is rejected. This is a compatibility fence, not protection from a database administrator.

During migration verify exact v7 guards, replace them atomically, establish the permit, and set the v8 marker; close the permit before commit. Missing/mutated/unknown old guards or an idle permit left open must trigger reconciliation, not blind deletion or adoption. Migration failure rolls back new tables, marker, permit and guards. Fresh databases follow the same final invariant.

Test with an actual cached old adapter—not just an artificially advanced marker. Include direct old writes, current writes, rollback and restart. Do not claim a v7 application can roll back a migrated v8 database. Prepare a v8-compatible roll-forward/rollback release before a separately authorized hosted migration.

## 4. Client and small interface

Add separate owned reminder reads/mutations to `RoomClient`; do not use shared `send()` or the human caught-up cursor. Capture generation and exact session object; validate full ownership envelope. Late success/failure from an earlier account cannot populate or sign out the new view.

Add one action in work **Details → Remind me**. A compact dialog offers **In 1 hour**, **Tomorrow, 9 am**, and **Choose time**. Resolve and show the exact local date/time before Save. Custom input must reject normalized nonexistent daylight-saving times; include local offset so an ambiguous time is not invisible. Preserve the chosen absolute instant/request ID during retry.

Existing active reminders show their saved time above the new time choice, with **Save** and **Remove reminder**. Save/cancel failures retain current intent. An unknown outcome locks and retries the exact command, labelled **Retry removal** when appropriate. A stale-revision response requires closing/reopening to load and review the new revision; it never silently rebases. Unknown outcomes remain reachable in Catch me up even after work resolves.

Inside Catch me up, show **Your reminders** only when active entries exist, due first and upcoming under **Scheduled**. Keep this outside ReturnBrief's frozen history/paging/refresh lifecycle. Mark caught up must not erase it. Reminder controls link to current work and open the same schedule dialog. Use `Cancel reminder`, not `Complete`.

Refresh on initial identity, relevant work-state changes, opening Catch me up, and tab return. Use a bounded owned timer only while visible; server evaluation time anchors due display and next due refresh. Account switch cancels timers and clears private state. Coalesce overlapping reads; a stale read cannot overwrite a newer mutation. No repeated model calls or noise in the conversation.

## 5. Verification plan

### Store/API

- Cross-member and cross-room privacy; reject supplied member/account fields.
- Browser session, account-session and agent-key behavior; normal CSRF/Origin/session-binding enforcement.
- Exact-boundary due time, past/out-of-range input and overdue restart with injected time.
- Same request retry after Cancel, changed ID reuse, lost response, concurrent same-revision reschedules; all rejected writes atomic.
- Active/receipt limits, including ability to cancel at schedule capacity.
- Normal work edits versus terminal completion, review/decision gates, supersession, reopening, member/account revocation and re-enabling.
- Key rotation/logout preserve reminders; new guest identity cannot claim old ones.
- No change to public room sequence, projection, event feed, export, return brief or human cursor.
- Migration from fresh/v7; retained v6 history; failed migration rollback; old open Node writer; cached old Cloudflare adapter; read-only refusal and current restart.

### Browser and independent review

- Desktop and emulated touch: schedule → close → reopen → reload → reschedule → cancel.
- Due item appears without a new room event; Catch me up pagination/acknowledgement is independent.
- Lost-response retry, stale tab conflict, delayed reads after mutation and delayed callback across sign-out.
- Invalid time/DST parsing, exact displayed timestamp, keyboard/Escape/focus, narrow layout and 200% text.
- Capture and inspect synthetic screenshots. These are simulated human journeys, not recruited usability studies.
- Root remains sole writer; three independent read-only reviews cover lifecycle/privacy, migration, and UI ownership.

Finish with syntax/core/API/browser/Cloudflare regression, exact asset packaging, a local source checkpoint, root handoff and bus/board release. Clearly separate local verification from live deployment.

## 6. What follows this checkpoint

1. **Notify-only watcher:** user-started process with independent durable processing checkpoint/outbox, bounded polling/backoff, identity/filter version, current-work recheck and explicit stop. Persist output before advancing. Never use the human read cursor; never launch work automatically.
2. **Usability refinement:** test whether portable return-code handling can become less visually technical while keeping original basis and retry identity intact; do not trade those guarantees for a prettier paste box.
3. **Release preparation:** feature-aware v8 rollback/roll-forward artifact, backups/recovery proof, exact source CI, then explicit hosted release approval. Existing unpublished portable-work commit is part of this candidate, not already live.
4. **Separate decisions:** durable guest/account recovery and final origin; off-app delivery; hosted AI free/paid limits; paid work/payment operations. None is needed to make reminders useful.
