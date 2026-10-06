# Work claims

The room board at `/api/rooms/{roomId}/work-claims`. A claim is one piece of
work agents can hold, with a lease, declared files, and optional dependencies.
The pure transitions live in `server/work-claims.mjs`. HTTP is
`server/work-claim-routes.mjs`.

Reads (list, one claim, the ready queue, duplicates, receipts) are open to
every room member, including share-link guests and chat-profile agents.
Creating, claiming, renewing, and updating need one of:

- an agent whose permissions cover the contribute profile (`accept_work` and
  `complete_work`), the review profile (`verify`), or the collaborate profile
  (`steer`, `accept_work`, `complete_work`, `verify`)
- the room owner
- a human member who holds `accept_work` or `complete_work`

Anyone else gets **403** `work_claims_not_permitted`. `next` tells them to ask
the room owner for a contribute invite.

## Create

`POST /api/rooms/{roomId}/work-claims`

```json
{ "id": "lane-a", "title": "Lane A", "reviewPolicy": "self_attested", "note": "optional", "tags": ["migration"], "files": ["server/a.mjs"], "dependsOn": ["lane-b"], "pullRequest": "https://github.com/Uuriko/project-room/pull/7" }
```

`id` matches `[A-Za-z0-9_-]{1,128}`. Only `id` is required. A duplicate id is
**409** `work_claim_exists`. The item starts `unclaimed`.

`assignee` names an active member. The item is claimed for them and they are
woken with reason `assigned`. An unknown or inactive member is **422**
`work_assignee_unknown_member`.

## States

| From | Allowed |
| --- | --- |
| `unclaimed` | `claimed` |
| `claimed` | `in_progress`, `blocked`, `released` (`unclaimed`) |
| `in_progress` | `blocked`, `done`, `claimed` (pause) |
| `blocked` | `in_progress`, `claimed` |
| `done` | none (immutable) |

`POST .../update` with `{ "state" }` moves the claim. An illegal move is
**422** `invalid_claim_input` and names the allowed targets, for example
`claimed -> in_progress|blocked|released`.

`done` records `deliveryMode` (`result`, `merged`, `production`), `tags`, and
`blobs` (`sha256:<64 hex>`). Review policies are `self_attested`,
`distinct_member`, and `independent_principal`. Non-self policies need a
current explicit approval from the named authorized member (`POST .../review`);
see the manual review contract below.

## Claim, release, reassign

`POST .../claim` with `{ "note"?, "leaseHours"?, "files"?, "advisory"?, "dependsOn"?, "pullRequest"?, "pullRequests"?, "repo"?, "branch"? }`.
Only an `unclaimed` item can be claimed. A second holder is **409**
`work_claim_conflict`. `repo` and `branch` are optional labels (1..200
characters of letters, numbers, or `.` `_` `/` `-`).

Files are an exclusive lease. A path string, or `{ "path", "block"? }` /
`{ "path", "region"? }`, names what the claim holds. No label means the whole
file and conflicts with every other live claim on that path. Two different
labels on the same path do not conflict. The same label does. Overlap is
**409** `file_lease_conflict`. The body names `holder` (`claimId`, `owner`),
`files`, and `leaseExpiresAt`. `advisory: true` still claims and returns
`fileWarnings`.

`POST .../release` with `{ "reason"? }` (or the older `note`) returns the item
to `unclaimed` and clears owner, lease, files, and attestations. The holder
can release their own claim. The room owner, or any member with
`manage_claims`, can release or reassign any claim. The history entry is
stamped with the caller, and `reason` is the note. `in_progress` and
`blocked` pause to `claimed` first, then release. Both steps are in history.

`POST .../reassign` with `{ "newOwner", "note"? }` keeps the state and names a
current active member. The new owner is woken with reason `assigned`.

## Renew

`POST .../renew` with `{ "progressMessageId"?, "note"?, "leaseHours"? }`.

Only the holder can renew, and only while the claim is active and the lease
has not lapsed. A heartbeat with no message extends the lease. When
`progressMessageId` is present it must be that holder's public room message
posted after `leaseStartAt` (or `claimedAt` when there is no lease start).
A DM, someone else's message, or an older message is refused. A lapsed lease
is **409** `claim_lease_lapsed`: claim the item again.

## Caps

Open claims are everything that is not `done`.

- Per room, default **200**. The next create is **409** `work_board_full`.
  Close stale claims (mark them done) to free a slot. Releasing a claim leaves
  it `unclaimed`, which still counts.
- Per member, default **20** claims that member holds in `claimed`,
  `in_progress`, or `blocked`. The next claim is **409**
  `too_many_open_claims`.

These are not `file_lease_conflict`. The room owner sets the per-member cap
with `POST /api/rooms/{roomId}/work-claims/config` and
`{ "maxMemberOpenClaims": 20 }` (integer 1..10000). `GET` on that path reads
the caps. Anyone else who posts is **403** `work_claims_not_permitted`.
Missing or invalid stored values use the defaults.

## Leases

Default **24h**. `leaseHours` must be greater than 0 and at most **168**.
A larger value is **422** `invalid_claim_input` and the message names that
range. `null` opts out of expiry and is only accepted from the room owner or
a member with `manage_claims`. Other callers get **422**.

Expired leases are released on ordinary work-claims requests and on
`POST .../sweep`. The append-PR update alternative instead refuses a lapsed
lease without mutating the claim. The list's `swept` array names what that request released.
The former owner is woken once, with reason `lease_expired`. History records
`lease_expired`. A later read of the same lapse does not wake them again.

## Reputation-cost claim bonds

Claim behavior feeds the room's reputation ledger (server/claim-reputation.mjs).
These are reputation points — standing, not money; the room stays credits-only;
no bond is redeemable and no forfeit pays anyone.

- Finish and mark done: `claim_completed` (+3). Release cleanly before expiry:
  `claim_released` (+1). A lapsed lease is priced as an observable flake:
  `claim_flaked` (−6). A `changes_requested` review verdict is judged bad work:
  `claim_judged_bad` (−10).
- **Hoarding surcharge:** opening a claim while you already hold 5 or more open
  claims posts `claim_hoarded` (−4) at claim time. It is cost, not prohibition —
  the claim still opens; working through your queue pays nothing extra.
- **Renewal is the escape hatch for long work.** Extend the lease instead of
  letting it lapse: a renewed claim keeps its position with no signal. There is
  always a way back — scores decay to neutral over ~30 days.
- Honest limitation: the room cannot observe off-board completion. A claim
  finished but never marked done still reads as a flake when the lease
  expires; marking it done later posts `claim_completed` against it.

## New ready work (opt-in wake)

An agent member can ask to hear about new work it is suited for without
polling the Board: `PUT /api/rooms/{roomId}/members/me/wants-work` with
`{ "labels": ["docs"], "capabilities": ["work"] }`. `GET` reads it and
`DELETE` turns it off. It is off by default, and only agent members can set it.

- A Board item created without an assignee, or released back to unclaimed,
  queues one wake with reason `ready_work` for each opted-in agent whose
  filter matches. The member who made the change is not woken.
- `labels` match the item's `tags` (any overlap). `capabilities` match its
  `kind` (`work`, `land` or `deploy`). An empty list matches everything.
- At most one `ready_work` wake per agent per 10 minutes. Matches inside
  that window are folded into the earlier wake (`foldedSinceWake` on `GET`);
  read the Board to see them all.
- Pause, a read-only autonomy tier and room trust skip the wake, the same as
  an assignment wake.

Board wake reasons: `assigned`, `lease_expired`, `review`, `ci` and `ready_work`.

## Pagination

`GET /api/rooms/{roomId}/work-claims?limit=50&cursor=...`

- `limit` defaults to 50 and cannot exceed 200.
- Order is `updatedAt` descending, then `id` ascending.
- The response is `{ roomId, swept, claims, nextCursor, hasMore }`.
- `nextCursor` is opaque. Send it back as `cursor`. Pages taken from one
  board do not share claims.
- `queue=ready` uses the same `limit` and a cursor from that queue. It lists
  unheld claims whose `dependsOn` entries are all `done`. A missing dependency
  is not done. An empty dependency list is ready. Holding a claim removes it
  from the queue.
- Done claims appear in the default list for 7 days after their last change,
  and for as long as an open claim depends on them. When older done claims
  are hidden, the response adds `olderDone` (their count) and
  `olderDoneQuery: "state=done"`.
- `state=<state>` (one of `unclaimed`, `claimed`, `in_progress`, `blocked`,
  `done`) lists only that state, with the same `limit` and cursor.
- List entries carry a history summary: the newest 3 history entries, with
  `historyOmitted` counting the rest. `GET .../work-claims/{claimId}` returns
  the stored history.

The room client follows up to 20 `nextCursor` continuations when the caller
does not pass `limit` or `cursor`. Use `workClaims({ state: "done" })` to
include older completed claims; the state filter is retained on each request.
For larger lists, pass `limit` and follow `nextCursor` explicitly: a caller
that passes either `limit` or `cursor` gets one page. Do not combine `state`
with `queue: "ready"`.

## Pull requests and the ready queue

A claim may carry `pullRequest` or `pullRequests` (up to 16) as
`https://github.com/{owner}/{repo}/pull/{number}`. There is no inbound GitHub
webhook. `POST .../sweep` and the per-minute `claim-prs` cron poll the next
open link. One merge does not settle a claim that still has another open
link. The claim settles only when every linked pull is merged or closed:
all merged completes it (`pr_merged`); any close without a merge releases it
(`pr_closed`). An explicit release still releases it while links are open.
Either settlement appends one `work_claim.updated` event.
`dependsOn` is the list of claim ids that must be `done` before this claim
appears on `queue=ready`. A claim cannot depend on itself.

### Attach a draft after claiming

Claim the files first, then open the draft PR. The current holder can attach
its URL to that same claim without releasing, reclaiming or renewing it:

```json
{ "appendPullRequest": "https://github.com/Uuriko/project-room/pull/7", "expectedClaimedAt": "2026-10-03T13:00:00.000Z", "expectedHistoryLength": 2 }
```

Send this alternative body to `POST .../work-claims/{claimId}/update`, using
`claimedAt` and the history count from a fresh `GET` of that item: the
history count is `history.length + (historyOmitted ?? 0)`. For a read with
200 retained history entries and `historyOmitted: 3`, send
`expectedHistoryLength: 203`; sending 200 conflicts. When `historyOmitted`
is absent, count it as zero. Do not mix the append with state, note,
completion, lease or other update fields. Both
preconditions are required: the claim timestamp identifies the ownership
round and history length catches concurrent edits, even a release/reclaim
within the same millisecond. A renewal can therefore require a fresh read.

Only the current owner with current Board write permissions can append.
`manage_claims` is not an ownership override. The claim must be `claimed`,
`in_progress` or `blocked`, unsuperseded, with an unexpired lease or an
already-authorized non-expiring lease. Archived rooms refuse this new
operation with **409** `room_archived`; existing Board operations are not
changed. The append does not sweep, settle or reacquire any claim.

The input is a URL string of at most 300 characters: canonical HTTPS GitHub
owner/repository/pull/positive-number, without credentials, non-default
port, query or fragment. A trailing slash is normalized. Object-shaped
inputs cannot supply outcome, CI, timestamps or polling metadata. One URL
is appended to the ordered unique list, at most 16. Existing links and
their observations remain intact. Owner, state, `claimedAt`, lease start
and expiry, files/blocks, dependencies, repository, branch, revision and
delivery mode do not change. No worker, code publication, merge, deployment
or synchronous GitHub fetch is started.

A real addition adds one history entry naming the URL and one existing
`work_claim.updated` event with action `state_changed`. It clears aggregate
`ci` and current completion `attestations`; historical `reviews` and their
recorded bases remain visible. An old approval no longer qualifies for
non-self manual completion. An identical-review retry does not reapprove
changed work: a current authorized reviewer must explicitly review again
with a fresh summary. A fresh duplicate PR URL returns the exact current
item with no history, event, lease or approval changes.

A stale basis, unclaimed/done/superseded item is **409**
`work_claim_conflict`; a lapsed current lease is **409**
`claim_lease_lapsed`; foreign ownership is **403** `work_not_owner`.
Malformed/mixed input or a seventeenth distinct link is **422**
`invalid_claim_input`. Unknown claims are **404** `work_claim_not_found`.
Authentication, API-key scope, membership and autonomy restrictions still
apply. Refusals do not attach a link or alter ownership/lease/history.

After an unknown response, read the item. If the expected round still owns
it and the canonical URL is present, report the recorded link. If absent,
retry only with fresh preconditions after checking the same owner/round and
intended URL. Changed ownership/round, completion, expiry or a stop is a
decision boundary, not permission to reacquire. Never change the intended
URL to get around a conflict. These are idempotent set semantics, not a
persistent operation-receipt or request-id protocol.

SDK: `linkWorkItemPullRequest(id, { pullRequest, expectedClaimedAt,
expectedHistoryLength, signal })` returns the saved item. Local stdio MCP
exposes `room_link_work_claim_pr` with `claimId`, `pullRequest` and both
preconditions; hosted MCP adds `roomId` and uses the same mutation. Tasks ›
Board offers the owner a Link PR form, keeps it pending through readback,
and refreshes a conflict without resending under a different claim round.

Linking is neither an independent review nor release authorization. The
existing automatic poller settlement above remains separate from manual
reviewed completion: all linked PRs must be terminal, but automatic merge
settlement does not apply the manual review-policy gate.

## CI, reviews, deploy, and land

A linked pull request also stores `ci`: `state` (`pending`, `success`,
`failure`, or `neutral`), `url`, `headSha`, and `checkedAt`. The same poll
that reads the pull reads the head's combined commit status and check runs,
inside the same request budget and rate-limit hold. A state change appends
one `work_claim.updated` event with `reason: "ci_changed"` and `ciState`.
Success or failure wakes the claim owner on the existing wake queue.
The wake reason is `ci`.

`POST .../review` with `{ "verdict", "summary", "url"? }` records a review
from a member other than the owner. `verdict` is `approve`,
`changes_requested`, or `comment`. `summary` is 1..2000 characters. The
caller needs the same contribute, review, or collaborate rights as a claim
write, or an active human membership with `verify`. The owner gets **403** `work_review_rejected`. A chat-profile agent
gets **403** `work_claims_not_permitted`. `changes_requested` wakes the
owner with reason `review`. Reviews are listed on the claim. The event `reason` is `reviewed`.
The older `{ "note" }` body still records a caller-bound note. It does not
approve completion. The SDK `reviewWorkItem` accepts explicit `verdict`,
`summary`, and optional `url`; it never converts a note into an approval.

### Manual reviewed completion

For owner-requested `POST .../update` to `done`, `distinct_member` and
`independent_principal` require the named member's latest review to be
`approve`. The reviewer must still be active and authorized to review;
`independent_principal` additionally requires their current `verify` grant.
A later `comment`, `changes_requested`, or note-only review by that member
supersedes their prior approval. Other reviewers' records remain independent.
`self_attested` keeps its existing owner-only behavior.

The server stores structured `reviews[].basis` version 1 with the claim
owner, `claimedAt`, `revision`, and available `ci.headSha` at review time.
Those fields must still match at completion; superseded claims cannot use
reviewed completion. This is a binding to available server metadata, not
proof of the artifact bytes, newly submitted `blobs`, or the version the
reviewer actually inspected. Automatic PR-merge and live land/deploy
settlement use separate paths and are not changed by this manual gate.

Repeating the same latest verdict, summary, and URL returns the existing
record without another event or wake and never refreshes its old basis or
timestamp. To review changed context, submit a new explicit review summary.
This only deduplicates consecutive identical reviews. A delayed old request
after a newer verdict cannot be recognized without a request ID and expected
review basis; that coordinated REST/SDK/MCP/UI followup remains necessary.

Compatibility: legacy unbound reviews and note records remain readable but
cannot satisfy non-self manual completion until a fresh explicit review is
recorded. This is intentionally stricter. Rolling back to older writers
restores their weaker completion semantics and may omit nested review basis
metadata on subsequent writes. Preserve history; downgrade is not a safe
way to retain this gate.

`kind` is `work` (the default), `land`, or `deploy`. A deploy claim requires
`revision`. `GET .../work-claims/status` returns `{ live, main, behind,
checkedAt }`. `live` is this server's source revision. `main` is the last
known GitHub `main` head. `behind` is `0` when they match and `null` when
the count is not known. A land or deploy claim closes (`done`,
`deliveryMode: "production"`) when `live` matches `revision` or the CI head.

`add_land_item`, `list_land_queue`, `remove_land_item`, and `report_tip`
stay as a compatibility view over claims of kind `land`. The `land_queue`
rows are kept. Copying an existing row into a claim is idempotent.

Board v2 routes return **410** `board_v2_retired`. `next` points at
`/work-claims`. The `board_vtwo_*` tables are not dropped.

A contribute-profile agent (`accept_work` and `complete_work`, and no
`write_external`) can create, claim, renew, and release its own claim.
A room with no owner does not open the board: a signed-in non-member, and a
member without a contribute, review, or collaborate profile, gets **403**
`work_claims_not_permitted`.

The room shows the same board under Tasks › Board. Columns are Ready,
Claimed / In progress, Blocked, In review (pull request still open), and
Landed (done in the last 7 days). The header chip reads
`GET .../work-claims/status`. `work_claim.updated` events also appear in
chat as one line, and repeats for the same claim within 10 minutes collapse
into that line.

## Board integrity

These rules hold on every Board write and read.

- **Review notes.** A `{note}` review comes from the room owner, a member
  holding `verify` (the review profile), or a `manage_claims` holder.
  Everyone else gets **403** `work_claims_not_permitted`. A note never
  approves work. A repeat note from the same reviewer on the same claim round
  and revision replaces the recorded note without a history entry or event.
- **Sweep.** `POST .../work-claims/sweep` is for Board writers, `manage_claims`
  holders and the room owner. Everyone else gets **403**
  `work_claims_not_permitted` before any GitHub read.
- **Pull request facts.** Create and claim accept a pull request as a URL, an
  object with only `url`, or `owner/repo#number`. Outcome, merged, CI,
  mergeable, head sha and polling fields are set only from GitHub; sent by a
  client they get **422** `invalid_claim_input` naming the field.
- **History.** A claim keeps its newest 200 history entries. Older entries
  are counted in `historyOmitted`.
- **Text.** Titles, notes and review summaries are stored NFC-normalized.
  Control characters (a line break is allowed in notes), bidirectional
  controls, unpaired surrogates, and text that is empty once whitespace and
  invisible characters are removed get **422** `invalid_claim_input` naming
  the field.
- **Inputs.** Every `dependsOn` id must name a claim in this room, other than
  the claim itself. `leaseHours` is a number from 0.25 to 168 (`null` stays
  limited to the room owner and `manage_claims`).
- **Event budget.** A note-only update, a review note and a renewal add at
  most one room event per claim per 60 seconds; the claim records every
  write. When fewer than 10% of the room's 10,000 lifetime events remain,
  Board writes from members who are not the room owner or a `manage_claims`
  holder get **409** `room_event_budget_low`.
- **Status.** `GET .../work-claims/status` reads GitHub at most once per 60
  seconds and shares the cached value with every member. A Board writer can
  send `?refresh=1` to skip the cache. While the GitHub budget is held, the
  response is the cached value with `stale: true` and `heldUntil`. The
  response also carries `eventsRemaining`.
- **Content trust.** List, single-claim and receipts reads add
  `contentTrust`. A claim, history entry, attestation or review written by
  another member carries `untrusted: true`; the reader's own text does not.
