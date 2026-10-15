# Optional invitation note: implementation contract

## Purpose and limits

Help someone invite a collaborator with one clear, voluntary request. Preserve
Create link → Copy link as the default. This is a small local composition feature,
not a referral campaign, assignment system, persistent invitation message or email
service. Root is sole editor; three independent lanes have reviewed research,
service authority and asynchronous recovery. All changes stay local.

Primary research, checked 2026-09-07:

- [Slack's invitation API](https://docs.slack.dev/reference/methods/admin.users.invite/)
  supports an optional custom message. Borrow optional context, not enterprise
  provisioning, automatic sending, resending or extra permission controls.
- [GitHub Project Pods FAQ](https://docs.github.com/en/nonprofit/project-pods/frequently-asked-questions)
  emphasizes a clear problem, deliverable and bounded commitment. Inference:
  a small explicit ask may help a recipient decide whether to participate.
  A mandatory task-brief questionnaire would be too much for this invitation.
- [Apple's 2025 writing guidance](https://developer.apple.com/videos/play/wwdc2025/404/)
  advises removing filler/repetition and explaining purpose. Use short labels and
  one optional disclosure. Do not promise that someone's contribution is easy.

These sources inform design; they do not establish growth or retention lift for
Project Room. Reuse the existing long-run voluntary, value-bearing referral
measurement contract. No telemetry or new metric implementation in this slice.

## Interface

1. Create the existing guest link with unchanged request/retry identity.
2. Copy link always copies only its URL, even when a note exists.
3. Add a note opens a blank, labelled, 600-character plain-text textarea outside
   the creation form. No room titles, history, tasks, identities or branding are
   inserted automatically. Enter adds a newline and never submits anything.
4. A nonblank valid note reveals Preview and Copy invitation. Preview is exactly
   trimmed note + two newlines + URL. It is selectable, read-only plain text.
   No markup interpretation, HTML, automatically inserted task links, saved
   drafts or localStorage. User-pasted URLs remain plain text.
5. Copy invitation is explicit and distinct from Copy link. Failure retains the
   current draft and selects the exact combined preview for manual copying.
6. Tell the author the note is only copied, not saved. Closing, New link,
   cancelling that link or losing its ownership clears the note and preview.
   Closing only the disclosure retains the draft. No confirmation dialog/tour.

The recipient sees the note only wherever the author pastes it; the join page
does not fetch or display it. It is not a durable work record or a promise of
task-only access. Existing guest scope remains visible: full room history and
conversation, not membership administration/work approvals. Link cancellation
stops future joins, not existing membership; guest session life and link expiry
remain separate. No schema, service permission or API fields change.

## Owned state and recovery

- Bind the management window to the visible Room session, client generation and
  current account-session ownership. Retain the result's link ID, expiry and
  issuing member revision. Check rights/expiry before initiating a copy, not just
  after it resolves. Known full/expired/cancelled/authority-changed list results
  retire the matching displayed secret. Membership revision changes retire it
  even if manage_members remains. An auth rejection clears the current result.
- A single cleanup path clears URL, metadata, note, preview, expiry timer and
  disclosure, invalidates feedback, then returns to creation. Never reconstruct
  a secret from the link list. Expiry clears a still-current result by timer and
  is rechecked on interaction; unknown remote changes cannot be guaranteed absent.
- One outstanding clipboard operation across both copy buttons. A monotonic
  interaction revision changes on edits, disclosure changes and result changes:
  A→B→A is still a newer draft. Disable copy controls while pending, but allow
  editing, closing and New link. An obsolete result cannot claim success, select
  fields or steal focus. A newer explicit focus move also defeats fallback focus.
- Already-issued clipboard writes cannot be cancelled. If the browser completes
  an old write after close, this UI cannot retract it or promise clipboard erasure.
  The pending lock survives cleanup until settlement; feedback does not.
- Cancel intent immediately retires the matching current result, even if the
  cancellation response is lost. Preserve the row ID for exact same-link retry.
  Cancelling an older row does not clear a newer link/note. Invalidate older list
  reads before cancellation so they cannot restore a misleading active row.
- Creation keeps the existing exact-request retry contract. Note input lives
  outside that form and cannot reset pendingCreate. Notes never enter requests,
  persisted storage, Room events, preview endpoints or analytics.

## Verification and checkpoint

Unit tests cover format, blank/whitespace, boundaries/emoji, exact create retries,
ownership, revision/expiry, auth failure and cleanup. Browser tests use disposable
loopback fixtures for desktop/mobile, keyboard/newlines, plain text, exact copy,
network/storage absence, manual fallback, delayed resolve/reject, A→B→A, overlapping
copy attempts, New link/close, current/older cancellation and unknown outcomes.
Keep existing invitation, session-boundary, first-use and read-marker tests.

Capture and inspect desktop/mobile/200%-text views with invitation secrets and
combined previews masked. These are simulated human journeys, not participant
research. Run the complete core, browser and local Cloudflare suites, static
asset allowlists and local production bundle. Record failures and fixes honestly.
Checkpoint locally, update the canonical handoff/board/bus, then continue the
active goal. No push, deployment, live migration, provider/DNS/payment/outreach
or paid-compute actions. Recorded live v7 remains separate from local v8 work.
