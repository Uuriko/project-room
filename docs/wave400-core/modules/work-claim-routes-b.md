# work-claim-routes.mjs — part B (lines 681–1355)

## Purpose

`handleWorkClaimsCore` (line 689) is the single request dispatcher for the
room-scoped work-claim board: it runs per-request housekeeping (autonomy-tier
gate, Room-Guide choke, lease-expiry sweep, live-claim closing), then routes to
one of 16 board operations. Every committed mutation appends exactly one
`work_claim.updated` room event in the same transaction (via `commit`, line
695), so the board and the room journal never diverge. The file also hosts the
MCP entry points `closeWorkClaim` / `linkWorkClaimPullRequest` and the
advisory file-collision helper `fileWarningsFor`.

## Route handlers (lines 689–1355)

All paths are relative to `/api/rooms/{roomId}/work-claims`.

| Method | Path | Behavior (one line) |
|---|---|---|
| GET | `/status` (799) | Closes auto-completable land/deploy claims, then returns deploy revision status + room event budget |
| GET | `/` (list, 806) | Closes live claims, returns paginated board (state/queue=ready filters, `?view=summary`) plus swept ids |
| GET | `/receipts` (811) | Searches done claims by `q` (substring over title + history) and exact `tag`s, offset-cursor paginated |
| POST | `/sweep` (844) | Settles PR links from the pre-request GitHub batch, holds rate-limited PR watches, releases lapsed leases |
| GET | `/duplicates` (874) | Fuzzy "similar claims" search over the room registry — read-only, never merges/closes |
| POST | `/` (create, 902) | Creates a claim; optional `assignee` claims it in the same transaction; caps + file-lease checks |
| GET | `/{id}` (read, 966) | Returns one claim stamped with content-trust markers |
| POST | `/{id}/claim` (971) | Claims an unclaimed item; exclusive file lease (409) unless `advisory: true` (then warnings) |
| POST | `/{id}/update` (1027) | State transitions, note appends, reading acks; `done` enforces the review policy + attestation |
| POST | `/{id}/review` (1109) | Verdict reviews (verdict+summary) or caller-bound attestations (notes) with 60 s event coalescing |
| POST | `/{id}/close`, `/{id}/cancel` (1149) | Retires open work; `cancel` also open to the creator while still unclaimed |
| POST | `/{id}/release` (1160) | Owner/manager releases a claim; `in_progress`/`blocked` routed through a pause first |
| POST | `/{id}/reassign` (1183) | Hands a claim to another member; validates the target is an active member with slot capacity |
| POST | `/{id}/renew` (1224) | Extends the lease only when citing the owner's own public progress message newer than the lease start |
| GET/POST | `/config` (1276) | Reads board config; owner-only update of `maxMemberOpenClaims` |
| GET | `/{id}/provenance` (1289) | Read-only transitive downstream walk over `parentClaimId` edges |
| POST | `/{id}/premise-invalid` (1304) | Flags the claim + all downstream claims for re-review, wakes owners; `{clear: true}` lifts the flag |
| * | any | 405 `method_not_allowed` with an `Allow` header per the route table (1342–1353) |

## Auth / access checks

- Non-GET/HEAD requests pass `enforceAutonomyTierForAction` (693) before anything else.
- `refuseRoomGuideOffStarter` (689→661): the Room Guide may only claim/close
  claims tagged `starter`; other writes → 403 `guide_starter_only`.
- `requireWriter` (mayWriteWorkClaims, 155): contribute/review/collaborate
  permission profile, the room owner, or a human holding `accept_work`/`complete_work`.
  A room with no owner keeps the board mutation-closed for everyone else.
- `authorityOver` (756): the claim holder takes the ordinary path; anyone else
  needs `manage_claims` (or room owner) or gets 403 `work_not_owner`.
- `requireEventBudget` (assertBoardEventBudget, work-claim-integrity.mjs:117):
  when <10% of the room's event budget remains, non-privileged Board writes get
  409 `room_event_budget_low`; owner/manage_claims are exempt.
- `update` is strictly owner-only (1036); `release`, `reassign`, `close`/`cancel`
  admit manage_claims holders via `authorityOver`.
- Verdict reviews need `mayReviewWorkClaims` (may write, or `verify` for humans);
  the owner cannot review their own claim. Attestations need `mayAttestWorkClaims`
  (owner, `verify`, or `manage_claims`).
- `sweep` needs `maySweepWorkClaims` (writer, manager, or owner).
- `receipts` reads require a listed, active member (403 `not_member` otherwise);
  guest agents keep read access like every other GET here.
- `renew` needs the caller's own *public* progress message, newer than the lease
  start; DMs and other members' messages are refused.
- `config` POST is room-owner-only. `premise-invalid` is premise-owner /
  room-owner / manage_claims.
- `leaseHours: null` (opt out of leases) is only accepted from the owner or a
  manage_claims holder (`assertLeaseChoice`, 752).

## Error codes

- **422 `invalid_claim_input`** — malformed body shape (every route validates a
  strict no-unknown-keys shape); any `ClaimError` from the pure state machine
  (mapped by `runPure`, 486); bad `reviewPolicy`/`kind`; `work_assignee_unknown_member`;
  `squad_unknown`; `work_reassign_unknown_member`; renewal source problems
  (`claim_renewal_source_required`, `claim_renewal_source_stale`);
  `invalid_receipt_query`; `bad_cursor` is the odd one out at **400**.
- **403** — `work_claims_not_permitted` (profile/profile-less writes, including
  `refuseWorkClaims`/`refuseAttest`/`refuseSweep` with hint+next guidance);
  `work_not_owner`; `work_review_rejected` (policy unsatisfied, missing
  attestation, owner self-review, non-owner naming on self_attested);
  `claim_renewal_source_foreign`; `guide_starter_only`; `not_member`.
- **409** — `work_claim_exists`; `work_claim_conflict` (claim on non-unclaimed
  item); `work_board_full`; `too_many_open_claims`; `claim_lease_lapsed`
  (with the "claim it again" recovery message); `file_lease_conflict` (thrown as
  a coded Error, translated to 409 with the full conflict body at 650);
  `room_event_budget_low`.
- **404** `work_claim_not_found`; **405** `method_not_allowed` (with `Allow`).

## Invariants

- One request = one registry transaction (`registry.transaction`, 642); the body
  is consumed before the transaction opens, and the response is sent only after
  commit, so a storage refusal is never reported as success.
- Every committed mutation emits exactly one `work_claim.updated` room event
  (except release-before-sweep internals, which stamp history only).
- Lease expiry is evaluated at the top of *every* request (`sweepRoom`, 742),
  including GETs; expired claims auto-release with a stamped history entry,
  one wake per lapse (message id keys on the lapsed lease time).
- File-lease exclusivity is enforced on all three acquire paths — `claim`,
  `create`-with-`assignee`, and `reassign` (QA200 ch-2037, 759/927/1206) —
  with an identical 409 body; `advisory: true` on `claim` downgrades to
  warnings only.
- Event coalescing: note-only updates and attestation repeats merge into the
  claim's last event (`coalesce: true`), at most one review-note event per
  claim per 60 s.
- `done` is terminal and immutable; `close`/`cancel` only accept non-terminal
  claims (`retire` maps `work_claim_terminal` → 409).
- `memoizeList` (668): one decoded room list per request, invalidated by any
  `set`/`delete`.

## Gotchas

- GETs are not side-effect free: `status`, `list`, and `read` run
  `closeLiveClaims` (auto-closes land/deploy-kind claims at the live revision),
  and *every* route — including `receipts` and `read` — runs the lease-expiry
  sweep, which can emit `lease_expired` room events.
- The `claim` route's file-lease 409 is thrown as a raw coded Error and caught
  in `handleWorkClaims`'s catch block (650), not via `reject()` — do not
  refactor one path without the other.
- `update` admits no manager override (owner-only, 1036), unlike
  `release`/`reassign`/`close`/`cancel` which route through `authorityOver`.
- `config` POST writes the registry directly and emits no room event.
- `status?refresh=1` bypasses the 60 s deploy-status cache only for
  sweep-capable members; everyone else silently gets the cached value.
- The Jev-harness receipt scoring on the `done` transition (1084) is
  shadow-mode: it journals a verdict but can never change the outcome
  (wrapped in try/catch).

## Stale comments

- `server/work-claim-routes.mjs:25-28` (file header): "the explicit
  work-claims-read projection preserves stored lease state without
  housekeeping" — stale. The `read` route dispatches through
  `handleWorkClaimsCore`, whose `sweepRoom` call at line 742 runs
  unconditionally before route dispatch, so `GET …/work-claims/{id}` performs
  the same lease-expiry housekeeping (and `closeLiveClaims` too) as every other
  route.
