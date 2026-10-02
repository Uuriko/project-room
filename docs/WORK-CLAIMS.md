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
review attestation from the named member (`POST .../review`).

## Claim, release, reassign

`POST .../claim` with `{ "note"?, "leaseHours"?, "files"?, "advisory"?, "dependsOn"?, "pullRequest"? }`.
Only an `unclaimed` item can be claimed. A second holder is **409**
`work_claim_conflict`.

Files are an exclusive lease. Overlap with another live claim (`claimed`,
`in_progress`, `blocked`) is **409** `file_lease_conflict`. The body names
`holder` (`claimId`, `owner`), `files`, and `leaseExpiresAt`. `advisory: true`
still claims and returns `fileWarnings`.

`POST .../release` with `{ "reason"? }` (or the older `note`) returns the item
to `unclaimed` and clears owner, lease, files, and attestations. The holder
can release their own claim. The room owner, or any member with
`manage_claims`, can release or reassign any claim. The history entry is
stamped with the caller, and `reason` is the note. `in_progress` and
`blocked` pause to `claimed` first, then release. Both steps are in history.

`POST .../reassign` with `{ "newOwner", "note"? }` keeps the state and names a
current active member.

## Renew

`POST .../renew` with `{ "progressMessageId", "note"?, "leaseHours"? }`.

Only the holder can renew, and only while the claim is active and the lease
has not lapsed. `progressMessageId` must be that holder's public room message
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

These are not `file_lease_conflict`. A room may set `maxOpenClaims` and
`maxMemberOpenClaims` through the work-claim config (integers 1..10000).
Missing or invalid values use the defaults.

## Leases

Default **24h**. `leaseHours` must be greater than 0 and at most **168**.
A larger value is **422** `invalid_claim_input` and the message names that
range. `null` opts out of expiry and is only accepted from the room owner or
a member with `manage_claims`. Other callers get **422**.

Expired leases are released on the next work-claims request and on
`POST .../sweep`. The list's `swept` array names what that request released.

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

A claim may carry `pullRequest` as
`https://github.com/{owner}/{repo}/pull/{number}`. There is no inbound GitHub
webhook. `POST .../sweep` and the per-minute `claim-prs` cron poll the pull.
A merge completes the claim (`pr_merged`). A close without a merge releases it
(`pr_closed`). Either path appends one `work_claim.updated` event.
`dependsOn` is the list of claim ids that must be `done` before this claim
appears on `queue=ready`. A claim cannot depend on itself.

## CI, reviews, deploy, and land

A linked pull request also stores `ci`: `state` (`pending`, `success`,
`failure`, or `neutral`), `url`, `headSha`, and `checkedAt`. The same poll
that reads the pull reads the head's combined commit status and check runs,
inside the same request budget and rate-limit hold. A state change appends
one `work_claim.updated` event with `reason: "ci_changed"` and `ciState`.
Success or failure wakes the claim owner on the existing wake queue.

`POST .../review` with `{ "verdict", "summary", "url"? }` records a review
from a member other than the owner. `verdict` is `approve`,
`changes_requested`, or `comment`. `summary` is 1..2000 characters. The
caller needs the same contribute, review, or collaborate rights as a claim
write. The owner gets **403** `work_review_rejected`. A chat-profile agent
gets **403** `work_claims_not_permitted`. `changes_requested` wakes the
owner. Reviews are listed on the claim. The event `reason` is `reviewed`.
The older `{ "note" }` body still records an attestation.

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
