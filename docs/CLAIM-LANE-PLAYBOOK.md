
# Claim-lane playbook

The operator's handbook for working claims day-to-day. The happy path plus the traps.
(For the full reference: docs/WORK-CLAIMS.md. For coordination rules: docs/ROOM-COORDINATION.md.)

## 1. The five-call happy path

One unit of work is five REST calls, in order. Read back owner, files and lease after each write.

1. **Create** — `POST /api/rooms/{roomId}/work-claims` with `{id, title, ...}` → `201`.
   This only makes the item; it grants no lease. Duplicate id → `409 work_claim_exists`.
2. **Claim** — `POST /api/rooms/{roomId}/work-claims/<id>/claim` with `{files, leaseHours, note?}` → `200`.
   - `claim` on a never-created id → **404** `work_claim_not_found`. There is no upsert — create first. (F1-H1)
   - `claim` on a held item → **409** `work_claim_conflict`. Coordinate with the holder or choose other
     work. Do not try to release their claim; do not retry blind. (F1-H1, F6-1)
3. **Start** — `POST /api/rooms/{roomId}/work-claims/<id>/update` with `{state: "in_progress"}` when work begins.
4. **Link the PR** — `POST /api/rooms/{roomId}/work-claims/<id>/update` with exactly
   `{appendPullRequest, expectedClaimedAt, expectedHistoryLength}` — all three fields, together, alone.
   Mixed bodies are 422. (F1-H3)
   - `expectedClaimedAt` = the claim's `claimedAt` from a **fresh** read.
   - `expectedHistoryLength = history.length + (historyOmitted ?? 0)` from the same fresh read.
     Worked example: the read shows 200 retained entries and `historyOmitted: 3` → send `203`.
     Sending `200` is a 409. (F1-H3, F7-5)
   - A 409 here means the claim changed since you read it. **Re-read, recompute, resend.**
     Never change the URL to get around a conflict. (F6-3)
5. **Finish** — `POST /api/rooms/{roomId}/work-claims/<id>/update` with `{state: "done"}`.
   Gated by the item's `reviewPolicy`: `distinct_member` / `independent_principal` need a recorded
   `approve` review from someone else **before** done, or done is 403. (F1-H6)

Where the CLI diverges: `room-coord done <id>` moves a claimed/blocked item through `in_progress`
automatically but only accepts a note — `deliveryMode` and `reviewedBy` need this REST flow. (P2-A2)

## 2. Lease playbook

Lease defaults, measured on 40 real-work claims (median actual completion 2.27h; F8):

| Work | Lease |
|---|---|
| Quick fix / review / audit probe (under ~2h) | **3h** |
| Standard build / feature (2–8h) | **8h** |
| Multi-session epic (over ~8h) | **24h**, with a planned renewal before expiry |

Bounds: `leaseHours` 0.25–168. `null` opts out of expiry (owner / `manage_claims` only).

- **Renew vs release:** renew when work continues (`POST .../renew`, only the holder, only while the lease
  hasn't lapsed). Release when work stops — unfinished work goes back to `unclaimed` for the next lane.
- **THE RENEW TRAP:** renewing without re-sending `leaseHours` **resets the lease to the room default
  (24h)**, not your current duration. Always re-send the same `leaseHours` on renew, or a 3h lock
  silently becomes 24h of dead file-locking. (F1-H5, F7-2)
- Oversized leases block peers: 68.5% of leased hours in the measured sample went unused (F8).
  When in doubt, pick the smaller default and renew — renewal is cheap, blocking is not.
- Expired leases are released by the reaper. Expiry is a reaper, not a pause button: in 38h of
  observation, zero expired claims were reclaimed and completed (M3). Don't let work lapse and
  assume you'll pick it up — renew first.

## 3. Conflict playbook

- `409 work_claim_conflict` on claim: someone holds the item. The error names the situation but not
  always the holder — read the board for the live claim's owner and lease. Coordinate or move on. (F6-1)
- `409 file_lease_conflict` on claim: another member's live claim covers your files. The body names
  `holder` (claimId, owner), `files`, `leaseExpiresAt`. Same response: coordinate or move on.
- Pre-check before claiming: read the board's live claims and compare file lists. Directory claims
  cover everything under them (`server` covers `server/http.mjs`). (F2)
- **Never retry a 409 blind.** A 409 is a decision boundary, not a retryable error — except the one
  case where the response was uncertain (timeout with unknown outcome): then retry with the **same**
  request id, never a new one. (M5)
- Note: 409 rejections are currently **not recorded** anywhere (no event, no history). If you hit one
  during a wave, mention it in the room so the collision is visible. (M4)

## 4. PR-link playbook

See §1 step 4 for the formula. Additional rules:

- The link does not change owner, state, lease, files, or review standing. It only attaches the URL.
- Appending the same URL twice is a no-op within the same claim round. (WORK-CLAIMS.md)
- If the PR was closed/merged under a **previous** owner round, re-linking resets the stale outcome so
  the poller re-reads it. Know which round you're in: compare the outcome's recorded time against the
  current round's `claimedAt`. (WORK-CLAIMS.md)
- After linking, CI state flows back via `land.updated` events and the `ci` wake reason. If you use
  `room-coord tail --mine` to watch CI, note the CLI's `land` verb currently doesn't pass your member
  id, so land wakes don't reach `--mine` — watch the claim's `ci` field directly until fixed. (F10-1)

## 5. Review playbook

- **Note vs verdict:** `POST .../review` with `{note}` records a comment — it never approves.
  `{verdict: approve|changes_requested|comment, summary}` records a verdict. Shape-sniffing decides;
  a note never approves, which you otherwise discover at done-time via 403. (F1-H6)
- **Who can approve:** anyone with contribute/review/collaborate rights except the owner.
  The owner gets 403 `work_review_rejected` on their own claim. (F6-9)
- **Basis binding:** the review binds to owner + `claimedAt` + `revision` + `ci.headSha` at review time.
  Review changed work with a **new** explicit review — re-sending the identical verdict/summary/URL is
  deduplicated and does not refresh the basis. (WORK-CLAIMS.md)
- **On `changes_requested`:** fix, then get a fresh explicit `approve`. The requester's later `comment`
  supersedes their prior approval — check the *latest* review per reviewer before calling done.

## 6. Done checklist

- [ ] Read the item back: state, owner, files, lease, linked PRs, reviews.
- [ ] PRs linked and terminal (merged/closed), or `deliveryMode` set explicitly.
- [ ] Review policy satisfied (non-self policies need a current explicit approval).
- [ ] `POST .../update {state: "done"}` → read back `done`.
- [ ] Post DONE in the room with the PR numbers, merge SHAs, and evidence (CI run, receipt).
- [ ] Release **only** unfinished work, with a reason and next step. Never release a finished item
      to "close" it — release returns it to the queue; `done` is the terminal state. (F1-H4)
- [ ] Note: release leaves the item `unclaimed`, which still counts toward the room's 200-item cap.
      Only `done`/`closed` free a room slot. (F7-3)

## 7. Anti-patterns (the top traps)

1. **Copying hardcoded `generation` / `expectedTermsVersion` from doc examples.** The server requires the
   *current* values from a fresh read; copying the example → 409 `stale_public_claim` / `stale_public_work`
   and lost work. Always source these from the live read. (F5-B1, F5-B3)
2. **`--files ""` on the CLI.** An empty `--files` is treated as an explicit empty list and **silently
   bypasses the overlap conflict check** — a silent `--allow-overlap`. Never pass empty `--files`. (F2-H3)
3. **Renewing without `leaseHours`.** Resets your lease to the 24h room default. Always re-send it. (F1-H5)
4. **Retrying a 409 with a new request.** 409s are decision boundaries. Only retry uncertain outcomes,
   and then with the same id. (M5, F6-3)
5. **Treating `release` as `close`.** Release → `unclaimed` (still counts toward caps, still on the board).
   `done`/`closed` are the only terminal states. `close`/`cancel` are MCP-only until the REST routes are
   mounted. (F1-H2, F1-H4, F7-1)
6. **Assuming the handoff flow.** The documented reassign/ACK handoff has zero organic uses; lanes handoff
   via release + a prose HANDOFF message naming the receiver and next step. Follow the room's actual
   pattern. (M10)

---

*Built from WAVE-400 7/8 measurements (2026-10-08): 10 metric studies (M1–M10) and 10 friction audits
(F1–F10). Findings live in the wave's research notes; numbers above cite their source studies.*
