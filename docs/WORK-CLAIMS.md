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

Expired leases are released on the next work-claims request and on
`POST .../sweep`. The list's `swept` array names what that request released.
The former owner is woken once, with reason `lease_expired`. History records
`lease_expired`. A later read of the same lapse does not wake them again.

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

The room client follows `nextCursor` when the caller does not pass `limit` or
`cursor`, so coordination sees the whole board. A caller that passes either
argument gets one page.

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
