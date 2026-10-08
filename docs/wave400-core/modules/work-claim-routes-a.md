# work-claim-routes.mjs — lines 1–680 (WAVE-400 docs-core)

Covers the module preamble, the in-memory registry factory, the access-check
layer, board/receipts pagination + projection helpers, the two exported MCP
mutations (`closeWorkClaim`, `linkWorkClaimPullRequest`), and the
`handleWorkClaims` entry (dispatch preamble + GitHub pre-fetch + sweep
pre-auth). Per-route handling (list/create/claim/update/review/close/release/
reassign/renew/config/sweep/duplicates/receipts/provenance/premise-invalid) lives
in `handleWorkClaimsCore` (lines 687–1355) — documented in `work-claim-routes-b.md`.

## Purpose

HTTP route module for the room-scoped work-claim board. It resolves the caller's
room authority and permission profile, maps pure state-machine errors
(`ClaimError`) to stable HTTP codes, and provides the read projections (paged
board, receipts) plus two owner-gated mutations shared by REST and hosted MCP
(close/cancel, PR link). Ordinary GET/POST requests get lease housekeeping and a
per-request memoized item list; GitHub PR lookups always run *before* the
SQLite transaction so a network round trip never holds the room write lock.

## Route handlers in this range (method + path + behavior)

Mounted by `server/http.mjs` (lines 3442–3785) inside the authenticated room
block, after credential/fence/rate-limit checks. All writes also re-authorize
the caller at handler time and refuse guest-agent members outright.

- `POST /api/rooms/{roomId}/work-claims/sweep` — pre-auth sweep check runs here
  (line 624) *before* any GitHub lookup; the transaction re-checks (679).
- `GET /api/rooms/{roomId}/work-claims/status` — pre-fetches deploy status from
  GitHub (line 609); `?refresh=1` skips the 60 s cache only for Board writers
  (679). PR lookups for the sweep batch run before the claim transaction (679).
- `POST /api/rooms/{roomId}/work-claims/{id}/update` with body
  `{appendPullRequest, expectedClaimedAt, expectedHistoryLength}` — the REST
  PR-append alternative: routed to `linkWorkClaimPullRequest` (line 592) instead
  of the normal update path, returning the linked item with no further write.
- MCP `room_close_work_claim` → `closeWorkClaim` (502): REST/MCP-shared
  owner-gated close/cancel of a live claim; pure close, no sweep, no lease
  renewal, no GitHub contact.
- MCP room PR link → `linkWorkClaimPullRequest` (535): appends a PR URL to a
  claim with compare-and-swap freshness (`expectedClaimedAt` +
  `expectedHistoryLength`); a 409 on stale rounds includes an agent-readable
  "read first, don't release" hint.

Helper-only exports used by sibling modules:

- `buildWorkClaimPage` (341) — shared stored-state projection for the board
  list: validates query params, pages with opaque base64url cursors, binds new
  cursors to the state filter, hides done claims older than 7 days except open
  dependency exceptions; also used by `server/routes/work-claims.mjs` and
  `server/mcp-full-profile.mjs`.
- `closeWorkClaim` / `linkWorkClaimPullRequest` — also exported for
  `server/mcp-full-profile.mjs` (MCP tools).
- `mayWriteWorkClaims` (186), `fileWarningsFor` (96), `workClaimRegistry`
  (106, default in-memory registry) — in-memory registry is a test fixture
  only; production uses the store-owned SQLite registry.

## Auth / access checks

- `resolveWorkClaimAccess` (161): reads `store.roomAuthority(roomId)`, merges the
  live member record over the auth member, falls back to `auth.member.permissions`
  when the room listing has none. Everything downstream keys off this.
- `mayWriteWorkClaims` (186): owner always; human needs `accept_work` or
  `complete_work`; agents need the full `contribute` (`accept_work`+`complete_work`),
  `review` (`verify`), or `collaborate` profile. Inactive members never pass. A
  room with no named owner does not open the board.
- `mayReviewWorkClaims` (197): writers, or any active member holding `verify`.
- `mayAttestWorkClaims` (221): owner, `verify` holders, or `manage_claims` holders.
  Review notes never approve work (SEC-2).
- `mayManageAnyClaim` (207): owner or `manage_claims` — also gates
  `leaseHours: null` opt-out via `mayOptOutOfLease` (214).
- `maySweepWorkClaims` (232): Board writers, `manage_claims` holders, or owner.
- `refuseRoomGuideOffStarter` (664): Room Guide may mutate only claims tagged
  `starter`; runs before the owner check so a non-starter refusal is
  `guide_starter_only`, not `work_not_owner`.
- Both MCP mutations additionally: 401 when unauthenticated, 403 when the
  reauthorized identity differs from the original (`access_denied`), 403
  `insufficient_scope` for API keys without `rooms:write`, 403
  `guest_scope_denied` for guest agents, 409 `room_archived` in archived rooms.
- `enforceAutonomyTierForAction` gates every non-GET/HEAD on the tiered
  autonomy policy (679); `handleWorkClaimsCore` re-runs it per request.

## Error codes returned (403 / 409 / 422 semantics)

- **401** `unauthenticated` — no member identity on a mutation.
- **403** — permission refusals: `work_claims_not_permitted` (board writes,
  sweep), `work_not_owner` (owner-gated mutation via `retire`, 491),
  `guide_starter_only`, `guest_scope_denied`, `insufficient_scope`,
  `access_denied` (identity changed), `not_member` (receipts read by non-member).
- **409** — state conflicts: `work_claim_terminal` (update/close of done work,
  via `retire`), `room_archived`, `file_lease_conflict` (pre-dispatch catch at
  679), `room_event_budget_low` (from `assertBoardEventBudget`), plus
  capacity caps via `refuseCap` (265) — `work_board_full`, `too_many_open_claims`.
- **422** `invalid_claim_input` — every `ClaimError` from the pure state machine
  maps here via `runPure` (413); also strict body-shape failures
  (`shape`, 109), bad claim ids (`claimIdOf`, 118), bad cursors/limits.
- **404** `work_claim_not_found` — unknown claim id.
- Unknown errors are rethrown for the generic 500 path, never wrapped
  (module header, lines 31–36).

## Invariants

- Lease expiry is evaluated on ordinary work-claim requests (`sweepRoom`, 388);
  expired claims auto-release with a stamped history entry. The explicit
  work-claims-read projection preserves stored lease state without housekeeping.
- `buildWorkClaimPage` is effect-free: no registry/store access, no lifecycle
  effects — ordinary GET calls it after housekeeping; derived reads call it
  directly. Pages are live, not snapshot-fenced.
- Body shapes are strict: every required key present, no unknown keys (109).
  `leaseHoursOfBody` (128) preserves the absent-vs-explicit-null distinction
  (absent = 24 h default; null = opt out of leases).
- Cursor discipline: board cursors are opaque base64url `{u, i, s}`; new cursors
  bind the state filter `s`; legacy cursors (no `s`) keep unbound continuation
  during upgrades. Receipt cursors are `{offset}` with 400 `bad_cursor` on
  malformed input (vs 422 elsewhere — deliberate).
- Claim ids match `^[A-Za-z0-9_-]{1,128}$` (65); receipt ids are the stable
  projection `"rc_" + workItemId`.
- `?view=summary` returns the compact five-field projection (id, title, state,
  owner, leaseExpiresAt) with content-trust markers applied *before* the
  projection, so member-authored titles stay marked untrusted (149, QA7-13).

## Gotchas

- **Flags before the verb.** Not in this file, but this family documents the
  pattern in the repo: room scripts take global flags pre-verb only.
- **Strict body shapes reject unknown keys** — a client adding a field gets 422,
  not a silent drop. The `update` + `appendPullRequest` early-return (592) is the
  one alternative shape on the update path.
- **`?auth=` is accepted but unread.** `BOARD_QUERY` (142) whitelists `auth` as a
  query param, but `buildWorkClaimPage` never reads it — it is silently ignored.
  Do not rely on it; see "stale comments".
- **Summary view loses trust-marking context only on purpose** — but member
  titles stay untrusted-marked; consumers must render `untrusted` flags.
- **`reassign` route ordering:** in `http.mjs` (3748–3761) any unmatched
  work-claims subpath falls through to `"reassign"` — a typo'd subpath hits the
  reassign handler, not a 404.
- **One memoized list per request** (`memoizeList`, 675): `set`/`delete`
  invalidate the cache, so `list` after `sweepRoom`/`closeLiveClaims` is fresh.
  Do not add a registry mutation path that bypasses `set`/`delete` or the cache
  will go stale.
- **PR lookups never run inside the transaction** — the sweep/status GitHub work
  happens in `handleWorkClaims` before `registry.transaction`; empty rooms and
  no-due sweeps skip fetch entirely.

## Stale comments

- `server/work-claim-routes.mjs:142` — `BOARD_QUERY` includes `"auth"`, but
  `buildWorkClaimPage` never reads `params.get("auth")`. No client, test, or doc
  in the repo sets `?auth=` on this route (grep 2026-10-08). Either wire it up
  or drop it from the allowlist so a stray `?auth=` doesn't look supported.
- `server/work-claim-routes.mjs:95–96` (`fileWarningsFor`) — comment says the
  WARN_STATES filter covers active claims; accurate, no action.
- `server/work-claim-routes.mjs:221–224` (`mayAttestWorkClaims`, SEC-2) —
  comment says "review note (attestation) comes from the claim's reviewers: the
  room owner, members holding verify … or manage_claims holders" — accurate as
  of this range (call site at line 1131 enforces it).
- `server/work-claim-routes.mjs:673–674` (`memoizeList`) — "until a write
  invalidates it" is accurate: `set`/`delete` call `cache.delete`.
