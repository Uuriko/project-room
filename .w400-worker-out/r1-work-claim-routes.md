## server/work-claim-routes.mjs

Mount prefix: `/api/rooms/{roomId}` — all routes room-scoped. Dispatch: server/http.mjs route regexes (http.mjs:3452-3465) → route name (http.mjs:3748-3762) → `handleWorkClaims` → `handleWorkClaimsCore`.

Auth baseline (applies to all): room credential + fence + rate-limit checks in the room block (http.mjs). Non-GET/HEAD additionally passes `enforceAutonomyTierForAction` (work-claim-routes.mjs:682). Room Guide may only claim/close `starter`-tagged claims (403 `guide_starter_only`, work-claim-routes.mjs:669).

| Method | Path | Auth | Params | Success | Errors |
|---|---|---|---|---|---|
| GET | /work-claims | member (reads open to guests) | query: state, q, tags, limit, cursor, fast? (see notes) | 200 paged board `{claims, nextCursor, swept}` | 422 invalid_claim_input |
| GET | /work-claims/status | member | query: refresh=1 (Board writers only; skips 60s GitHub cache) | 200 `{live, main, behind, checkedAt, stale, heldUntil?, eventsRemaining}` | 401/403 via room block |
| POST | /work-claims/sweep | maySweepWorkClaims (checked pre-body AND in-transaction) | empty JSON object `{}` | 200 `{roomId, released[], sweptAt, pullRequests{checked, updated, rateLimited?}}` | 403 sweep refused; event-budget 409 |
| GET | /work-claims/duplicates | member | query: q (1..512 chars, required), limit (1..20, default 5); only single q+limit allowed | 200 `{roomId, query, duplicates[]}` | 422 on bad q/limit |
| GET | /work-claims/config | member | — | 200 `{roomId, maxMemberOpenClaims, ...}` | — |
| POST | /work-claims/config | room owner only | body: {maxMemberOpenClaims: int 1..10000} (required) | 200 saved config | 403 work_claims_not_permitted; 422 |
| POST | /work-claims | member + writer | body: {id} required; title?, reviewPolicy?, note?, tags?, files?, dependsOn?, parentClaimId?, evidenceRefs?, pullRequest?, pullRequests?, repo?, branch?, kind?, assignee?, squadId? | 201 created item (claimed if assignee) | 409 work_claim_exists; 409 work_board_full / too_many_open_claims; 422 invalid_claim_input |
| GET | /work-claims/{id} | member (guests ok) | — | 200 stamped claim (member-authored text marked untrusted, SEC-2) | 404 unknown id |
| POST | /work-claims/{id}/claim | member + writer | body all optional: {note?, leaseHours?, files?, advisory?, dependsOn?, parentClaimId?, evidenceRefs?, pullRequest?, pullRequests?, repo?, branch?} | 200 claimed item + fileWarnings[] + requiredReading[] | 409 work_claim_conflict (already claimed); 409 file_lease_conflict (unless advisory:true); 409 too_many_open_claims; 422 |
| POST | /work-claims/{id}/update | owner only + writer | body: {state?, note?, deliveryMode?, reviewedBy?, tags?, blobs?, readingAck?, parentClaimId?, evidenceRefs?} (need state/note/readingAck); readingAck={docs:[]} | 200 updated item | 403 work_not_owner; 403 work_review_rejected (policy); 422 |
| POST | /work-claims/{id}/update | owner only + writer | body: {appendPullRequest} variant → links PR without full update | 200 item | same |
| POST | /work-claims/{id}/review | verdict: any member with review rights except owner; attestation: contribute/review rights | {verdict, summary, url?} OR {note?} | 200 reviewed/attested item (duplicate reviews return unchanged) | 403 work_review_rejected (owner reviewing own); 403 refuseWorkClaims/refuseAttest |
| POST | /work-claims/{id}/release | owner/manager/creator authority | body: {reason?, note?} | 200 released (in_progress/blocked routed through pause first — W2 fix) | 403/422 |
| POST | /work-claims/{id}/reassign | authority over item | body: {newOwner} required (must be active member — W3 fix), {note?} | 200 reassigned (consumes new owner's cap; file-lease rechecked) | 422 work_reassign_unknown_member; 409 too_many_open_claims |
| POST | /work-claims/{id}/renew | owner only + writer | body: {progressMessageId?, note?, leaseHours?} | 200 renewed (coalesced event) | 409 claim_lease_lapsed (names recovery: claim again — W4 fix); 403 work_not_owner; 422 claim_renewal_source_* (must cite own public room message newer than lease start) |
| GET | /receipts | authenticated member (403 not_member for non-members; guests ok) | query: q?, tags?, limit?, cursor? | 200 stamped receipts (done items, newest first) | 403 not_member |
| POST | /work-claims/{id}/close | **UNREACHABLE via HTTP** (see bugs) | body: {reason?} | (via MCP room_close_work_claim only) | — |
| POST | /work-claims/{id}/cancel | **UNREACHABLE via HTTP** (see bugs) | body: {reason?} | (via MCP room_close_work_claim verb=cancel only) | — |
| GET | /work-claims/{id}/provenance | **UNREACHABLE via HTTP** (see bugs) | — | (via MCP room_work_claim_provenance only) | — |
| POST | /work-claims/{id}/premise-invalid | **UNREACHABLE via HTTP AND MCP** (see bugs) | body: {reason} or {clear: true, note?} | dead handler | — |

Wrong-method → 405 `method_not_allowed` with `Allow` header from WORK_CLAIM_METHODS table (work-claim-routes.mjs:1337-1341).

### Behavioral notes
- Every committed claim change appends one `work_claim.updated` room event inside the same transaction (work-claim-routes.mjs:686-687); note-only updates coalesce with the claim's last event (Q3-A).
- Reads (`list`, `status`, `read`) call `closeLiveClaims()` — lease sweeping happens on ordinary reads (the WAVE-300 reaper lane is eliminating this).
- `sweep` is a Board write: event-budget floor applies (QA200-CH-2033); PR lookups happen before the claim transaction so GitHub round trips never hold the room write lock.
- `renew` requires citing your own public room message posted after the lease start — renewals are discussed in the channel by design.
- `claim` with `advisory: true` keeps warn-and-proceed on file-lease overlap; otherwise overlap is 409 naming holder/files/lease-end.
- `update` to `done` runs the Jev-harness receipt-acceptance gate in shadow mode (never throws, never changes outcome).
- `create` with `assignee` lands claimed in one transaction (retention ack included).
- Pair rule: hard-work claims default to `distinct_member` review policy (can't close without a non-owner APPROVE).

### Stale flags
- `STALE server/http.mjs:3466-3468` — comment "Provenance walk + premise-invalid rollback (orch-provenance-rollback). Literal segments are matched before the {id} template so they are never mistaken for a claim id." — the literal-segment regexes were never added; no provenance/premise-invalid/close/cancel regex exists in http.mjs.
- `STALE server/mcp-hosted-tools.mjs:175` — `room_work_claim_provenance` description says "Same data as GET /api/rooms/:roomId/work-claims/:claimId/provenance" — that HTTP endpoint 404s (no route).

### Suspected bugs
- `BUG? server/http.mjs:3452-3465,3748-3762` — four handlers in work-claim-routes.mjs (`close`, `cancel`, `provenance`, `premise-invalid`) have no route regex and no dispatch branch: `POST /work-claims/{id}/close`, `/cancel`, `GET .../provenance`, `POST .../premise-invalid` all 404. close/cancel and provenance are reachable via MCP tools (`room_close_work_claim`, `room_work_claim_provenance`); `premise-invalid` is reachable nowhere — the practiced-rollback feature (orch-provenance-rollback) is dead via every transport. The http.mjs comment shows the regexes were intended but never written.
- `BUG? server/http.mjs:3762` — dispatch fallback `: "reassign"`: any `workClaimMatch` not caught by earlier branches becomes "reassign" instead of 404. Currently unreachable (the ?? chain is exhaustive), but a future regex added to the match chain without a dispatch branch would silently misroute to reassign. Should be an explicit 404/405.

DONE: 19 route entries (15 HTTP-live, 4 unreachable), 2 stale flags, 2 suspected bugs
