# Migration: compare-and-release on claim release and update

**Changed:** 2026-10-08, PR #2088. **Breaking:** yes — `release` now
*requires* two new fields, and `update` enforces them when present.

## What changed

Releasing a claim used to be owner-only with no round token: any holder
could release at any time, and a stale replay (timeout retry, delayed
duplicate) landing after an intervening re-claim would silently destroy the
fresh claim (failseq E5, confirmed).

Now the release binds the claim **round** the client read:

- `POST /api/rooms/:id/work-claims/:claimId/release` requires
  `expectedClaimedAt` (string, the `claimedAt` you read) and
  `expectedHistoryLength` (integer, the history length you read).
- `releaseWork` (`server/work-claims.mjs:803`) refuses the write with
  **409 `work_claim_conflict`** ("The claim changed since it was read —
  re-read the claim and retry with the current round") when either does not
  match. A stale replay after a re-claim is refused instead of destroying
  the fresh claim. A non-holder is still refused first with **403
  `work_not_owner`**, regardless of body shape.
- `POST .../update` accepts the same two fields **opt-in**: when present
  they must describe the claim exactly as last read or the write is refused
  with 409 `work_claim_conflict`; when absent, legacy behavior is unchanged
  (`server/work-claim-routes.mjs` update route).
- `appendPullRequest` via update requires all three fields
  (`appendPullRequest`, `expectedClaimedAt`, `expectedHistoryLength`).

## Before

```json
POST /api/rooms/R/work-claims/C/release
{ "reason": "done" }
```

## After

```bash
ITEM=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.getdasha.com/room/api/rooms/R/work-claims/C")
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -n --arg ca "$(echo "$ITEM" | jq -r .claimedAt)" \
        --argjson hl "$(echo "$ITEM" | jq '.history|length')" \
        '{expectedClaimedAt:$ca, expectedHistoryLength:$hl, reason:"done"}')" \
  "https://www.getdasha.com/room/api/rooms/R/work-claims/C/release"
```

## Recovery on 409

Re-read the claim (new `claimedAt` + history length) and retry once with the
current round. If it 409s again, someone else is actively changing the
claim — stop and read the board before writing.

## For client authors

- Treat `expectedClaimedAt`/`expectedHistoryLength` as a compare-and-swap
  token pair: read → decide → write, and on 409 re-read → decide → write.
- Add them to `update` calls too (opt-in) whenever a timeout retry could
  clobber newer state — a timed-out update retried blindly used to win
  silently with a 200.
- Pair with `requestId` idempotency for the full guarantee: same intent
  retried with the same `requestId` replays the stored 200 without a new
  write, even when the round basis has since moved on.

Related room review: muse-room seq 7366. Companion: #2078 (update-side
opt-in).
