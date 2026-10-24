# Optional invitation note: local checkpoint

## Outcome

Invitations can now carry one personal request without burdening the default
flow. Copy link still copies only the URL. Add a note reveals a blank optional
editor, exact plain-text preview and explicit Copy invitation. The note is never
sent to the service, saved in Room, added to the join page or used to create work.
There is no automatic room-context inclusion, sending, tracking or outreach.

The [implementation plan](INVITATION-NOTE-PLAN-2026-09-07.md) records primary-source
inspiration, choices, authority and recovery. This is a candidate voluntary growth
improvement, not evidence of referral or retention lift. Root was the sole editor
under the Sites guidance; three independent read-only reviewers checked the
research, service boundaries and asynchronous recovery. Existing stack and assets
were preserved; no dependencies, permission or schema changes.

## Behavior and fixes

- Blank by default, 600-character limit, literal text, Enter for newline. Only a
  nonblank valid note reveals the combined preview. No extra form submission.
- Copy invitation copies exactly the preview. Copy link remains URL-only even
  after writing a note. Clipboard failure retains the draft and offers selectable
  text without stealing focus from a newer action.
- Collapsing Add a note keeps the draft. Closing the window, New link, current-link
  cancel intent, observed expiry/inactivity or ownership loss clears it. Retiring
  a focused result restores the creation control; the explanation remains visible.
- One outstanding clipboard operation across both buttons. Monotonic interaction
  revisions defeat A→B→A edits; direct visibility/value checks cover queued native
  disclosure events. Old completions cannot claim success or focus a newer result.
- The operation lock survives closing/replacement until the browser settles it.
  Already-issued clipboard writes cannot be cancelled; we do not claim clipboard
  history or pasted messages are erased. A permanently unresolved browser write
  keeps copying unavailable for that page instance rather than racing a second
  write; the still-current preview can be selected manually.
- Management is owned by the opening Room session and generation, verified
  account-session ownership and current human administration rights. Current links
  retain expiry and issuer member revision. Known authority/list changes retire
  the displayed secret before copying; unobserved remote changes are not promised
  detectable. Actual join access remains service-authoritative.
- Auth/binding denials retire the whole management operation, so earlier successes
  cannot restore it. Confirmed obsolete creation clears its retry identity and
  permits a fresh link without changing settings. Unknown creation still retries
  the exact original request, preserving the existing contract.
- Cancel intent retires only that current link. An uncertain cancellation retains
  the row for exact retry; cancelling an older link leaves a new note/link intact.
  Pre-cancellation list responses cannot restore an active row.

Existing guest scope is unchanged: whole room history and conversation, no work
approval or membership management. Notes are neither verified work nor task-level
access. Link cancellation stops future joins, not existing memberships. Anonymous
guest-session duration remains distinct from link expiry.

## Verification

355 core/API checks, 76 browser checks and 7 local Cloudflare checks passed.
The browser set includes 12 new note journeys; core includes 19 lifecycle cases
and one formatting case. Existing first-use, invitation recovery, exact-request
retry, independent review, human read-marker and schema recovery checks remain.
The final wording-only simplification received a 27-case targeted unit rerun.

Fifteen exact public assets were prepared and import/packaging checks passed.
The production entrypoint bundled locally in memory (194,636 bytes). No deploy
command, hosted CI or live-room verification was performed.

Eight new masked screenshots cover desktop/mobile, closed/expanded disclosure,
and 200% text/editor/copy control. Inspected every view; the narrow enlarged view
scrolls vertically and the copy control is keyboard reachable and hit-tested.
These are synthetic browser sessions, not human participants or physical phones.

The first full browser run passed 75/76: an older calm-return test observed an
old ready brief before the queued disclosure-triggered refresh. It now waits for
the new response before reading the horizon, preserving all original assertions.
The full rerun passed 76/76. Review also caught the expiry explanation being
cleared by a queued note toggle; the fix and regression are included. Known local
self-signed Cloudflare probe diagnostics remain, with all assertions passing;
production certificate trust was not changed.

See [the evidence ledger](evidence/invitation-note-2026-09-07.md).

## State and next work

This checkpoint and prior portable work/reminders/watcher/calm-return milestones
remain local and unpublished. Recorded live is still application fb90a70, Worker
901be347, Room schema v7; earlier private reminders require v8. No live state is
inferred from local screenshots or tests. All test processes finished; synthetic
test artifacts are the only generated data.

The long-running product/retention/growth goal remains active and incomplete.
Next: inspect and research agent task-context ergonomics. The existing orient,
snapshot, brief, write guide and portable packet already cover much; find the
smallest missing selected-task context/next-action handoff and reuse those
contracts before adding another interface. Plan first, test with fresh agents,
retain human approval and avoid autonomous external execution.

Later: reusable outcomes/templates and a v8-compatible release/fallback/recovery
package. Do not use old v7 code as rollback for v8 data. Hosted AI, payments,
stablecoins, Dasha integration and actual human growth measurement remain staged
decisions. No push, deployment, live migration, DNS/provider/account changes,
outreach, payments, paid compute or recurring automation occurred.
