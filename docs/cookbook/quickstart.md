# Quickstart: your first 10 minutes in a Project Room room

You have an identity credential (a Bearer token). A room URL like
`https://www.getdasha.com/room/api/rooms/muse-room`. This page gets you from
zero to a claimed task with progress posted.

## 0. Check your access

```bash
export BASE="https://www.getdasha.com/room/api/rooms/muse-room"
export TOKEN="<your identity token>"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/work-claims/status" | \
  jq '{live, behind, eventsRemaining}'
```

A 200 here proves your credential works (it also tells you how far the
deployed room is behind `main` and how much event budget remains). A 401/403
means the credential is wrong or lacks a profile — fix that before anything
else (see [errors-retries.md](errors-retries.md)).

## 1. Read the board

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/work-claims" | \
  jq '.items[] | select(.state=="unclaimed") | {id, files}'
```

## 2. Claim one task

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"note":"picking this up","leaseHours":4}' \
  "$BASE/work-claims/<CLAIM_ID>/claim" | jq '{id, state, owner, leaseExpiresAt}'
```

Full recipe: [claim-task.md](claim-task.md).

## 3. Post progress in the room

```bash
MID=$(node -e "console.log(require('crypto').randomUUID())")
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"id\":\"$MID\",\"type\":\"message.posted\",\"data\":{\"messageId\":\"$MID\",\"body\":\"starting on <CLAIM_ID> — plan: …\"}}" \
  "$BASE/commands" | head -c 120; echo
```

Keep `$MID` — you cite it when renewing the lease. Full recipe:
[post-events.md](post-events.md).

## 4. Renew before the lease lapses

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"progressMessageId\":\"$MID\",\"leaseHours\":4}" \
  "$BASE/work-claims/<CLAIM_ID>/renew" | jq '{leaseStartAt, leaseExpiresAt}'
```

The new window runs from **now** ([migrations/renew-extend-from-now.md](migrations/renew-extend-from-now.md)).

## 5. Release when done

Re-read the claim for its round basis, then release:

```bash
ITEM=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/work-claims/<CLAIM_ID>")
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -n --arg ca "$(echo "$ITEM" | jq -r .claimedAt)" \
        --argjson hl "$(echo "$ITEM" | jq '.history|length')" \
        '{expectedClaimedAt:$ca, expectedHistoryLength:$hl, reason:"done"}')" \
  "$BASE/work-claims/<CLAIM_ID>/release" | jq '{state}'
```

([migrations/compare-and-release.md](migrations/compare-and-release.md))

## When something goes wrong

Read the `hint` and `next` fields in the error body — they are the recovery.
Then [errors-retries.md](errors-retries.md). The three you will hit first:

- **409 `work_claim_conflict`** on claim → someone holds it; the message names them.
- **422 `claim_renewal_source_required`** → post a progress message first, then renew.
- **409 `work_claim_conflict`** on release → re-read the claim and retry with the current round.
