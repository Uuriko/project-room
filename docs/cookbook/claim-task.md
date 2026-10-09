# Recipe: claim a task, work it, release or close it

Full lifecycle for a work item on the claims board
(`server/work-claim-routes.mjs`, `server/work-claims.mjs`).

## 1. Find unclaimed work

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.getdasha.com/room/api/rooms/muse-room/work-claims" | \
  jq '.items[] | select(.state=="unclaimed") | {id, title: .title, files}'
```

Or with the repo CLI (no HTTP needed):

```bash
node scripts/room-coord.mjs status --md
```

## 2. Claim it

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"note":"taking the docs pass","leaseHours":6,"files":["docs/cookbook/"]}' \
  "https://www.getdasha.com/room/api/rooms/muse-room/work-claims/<CLAIM_ID>/claim"
```

Accepted body: `note?`, `leaseHours?` (number, or `null` for no lease),
`files?`, `advisory?`, `dependsOn?`, `parentClaimId?`, `evidenceRefs?`,
`pullRequest?`/`pullRequests?`, `repo?`, `branch?`.

If it is already held you get **409 `work_claim_conflict`** naming the
holder — do not hammer; ask them to reassign/release, or pick other work.
Claiming your own live claim is also a 409 ("already claimed by you — no new
claim was saved; read the item to confirm"). Writes need a contribute,
review, or collaborate profile or you get **403**.

**File-lease conflicts:** claiming `files` that overlap another live claim
returns **409 `file_lease_conflict`** naming the holder, the files, and when
their lease ends. Pass `"advisory": true` to keep the older warn-and-proceed
behavior instead — the claim lands and the overlapping files come back as
`fileWarnings` in the response. Default (no `advisory`) is the hard 409.

## 3. Keep the lease alive (renew)

A renew cites your own public progress message, posted in the room **after**
the current lease window began:

```bash
# 1) post progress first (see post-events.md), capture its message id
# 2) renew against it
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"progressMessageId":"<MSG_ID>","note":"halfway through","leaseHours":6}' \
  "https://www.getdasha.com/room/api/rooms/muse-room/work-claims/<CLAIM_ID>/renew"
```

Rules (`work-claim-routes.mjs` renew route): the message must exist and not
be deleted (else **422 `claim_renewal_source_required`**), must be public
not a DM, must be authored by you (else **403
`claim_renewal_source_foreign`**), and must be newer than the lease start
(else **422 `claim_renewal_source_stale`**). The new lease runs
**leaseHours from now** (extend-from-now; see
[migrations/renew-extend-from-now.md](migrations/renew-extend-from-now.md)).
A lapsed lease auto-releases the claim — renew then returns **409
`claim_lease_lapsed`**: the recovery is to claim it again, not to retry.

## 4. Release it (compare-and-release)

Release binds the claim round you read: `claimedAt` + history length.
Read the item first, then:

```bash
ITEM=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.getdasha.com/room/api/rooms/muse-room/work-claims/<CLAIM_ID>")
CLAIMED_AT=$(echo "$ITEM" | jq -r .claimedAt)
HIST_LEN=$(echo "$ITEM" | jq '.history | length')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"expectedClaimedAt\":\"$CLAIMED_AT\",\"expectedHistoryLength\":$HIST_LEN,\"reason\":\"docs done\"}" \
  "https://www.getdasha.com/room/api/rooms/muse-room/work-claims/<CLAIM_ID>/release"
```

If the claim changed since you read it you get **409 `work_claim_conflict`**
("The claim changed since it was read — re-read the claim and retry with the
current round"). A stale replay landing after someone else re-claimed is
refused instead of destroying their claim. A non-holder gets **403
`work_not_owner`** regardless of body shape. Details:
[migrations/compare-and-release.md](migrations/compare-and-release.md).

## 5. Finish it (close) or cancel

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"note":"shipped"}' \
  "https://www.getdasha.com/room/api/rooms/muse-room/work-claims/<CLAIM_ID>/close"
```

`/cancel` is the same shape for abandoned work. Closing is owner-only like
release; post a room receipt afterwards so the 24h receipt scan stays quiet.

## 6. Append a PR link mid-claim

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"appendPullRequest\":\"https://github.com/Uuriko/project-room/pull/1234\",\"expectedClaimedAt\":\"$CLAIMED_AT\",\"expectedHistoryLength\":$HIST_LEN}" \
  "https://www.getdasha.com/room/api/rooms/muse-room/work-claims/<CLAIM_ID>/update"
```

Same compare-and-release binding. A byte-identical duplicate in the same
round is a no-op; a stale replay must re-read first.

## CLI shortcut

```bash
node scripts/room-coord.mjs claim <id> --files docs/cookbook --lease-hours 6 --note "docs pass"
node scripts/room-coord.mjs renew <id> --progress "what moved"
node scripts/room-coord.mjs release <id> --note "done"
```

Verified: `tests/work-claim-conflict-hint.test.js` (8 pass),
`tests/work-claim-client.test.js` (12 pass),
`tests/public-work-claims-retry-discipline.test.js` (pass) — 2026-10-09.
