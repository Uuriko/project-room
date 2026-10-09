# B2 — Idempotency Audit: Work-Claim Write Paths

**Worker:** PRODUCT-200 RELIABILITY B2/50 (respawn) · **Coordinator:** product200-reliability
**Date:** 2026-10-08 · **Audited at:** origin/main `4c11f4b92` (worktree `~/workspace/product200-b2-claimidem/`, branch `jill/b2-claim-idempotency-audit`)
**Scope:** every mutating work-claim operation in `server/work-claims.mjs` + its HTTP route wrappers in `server/work-claim-routes.mjs` (+ MCP wrappers in `server/mcp-full-profile.mjs`). Read-only audit — no code changed.

**Per-op question set:** (a) accepts `requestId`/idempotency key? (b) dedupe key + window? (c) replay returns prior result vs errors vs double-writes? (d) atomic (transaction / CAS) vs partial-write possible?

---

## TL;DR — verdicts

| # | Operation | Transport(s) | requestId? | Replay behavior | Atomic? | Verdict |
|---|-----------|--------------|------------|-----------------|---------|---------|
| 1 | **create** | `POST /work-claims` → `createWork` | **No** — `shape()` rejects unknown fields with 422 (`server/work-claim-routes.mjs:109-114`, route shape `902`) | Duplicate id → **409** `work_claim_exists`, claim unchanged (`910`); test `tests/work-claim-idempotency.test.js:42` | Yes — single upsert + event inside `registry.transaction` (`650`) | **PARTIAL** |
| 2 | **claim** | `POST /work-claims/:id/claim` → `claimWork` | **No** — whitelist `note,leaseHours,files,advisory,dependsOn,parentClaimId,evidenceRefs,pullRequest,pullRequests,repo,branch` (`974`) | Replay after success → **409** `work_claim_conflict` (`976`), state guard blocks double-claim; returns error, not prior result | Yes — one commit in the route transaction | **PARTIAL** |
| 3 | **update** (state moves + notes) | `POST /work-claims/:id/update` → `updateWork` | **No** — but has **opt-in** `expectedClaimedAt`/`expectedHistoryLength` (`1029`, enforced `1046-1062`) | With preconditions: stale → **409** `work_claim_conflict`. **Without them (default): a stale retry silently clobbers newer state with 200** (comment `1038-1045` says so verbatim). Note-only replay = new history stamp (double-write) | Yes | **PARTIAL** |
| 4 | **release** | `POST /work-claims/:id/release` → `updateWork({state:"unclaimed"})` | **No** — shape is `{reason?, note?}` only (`1187`) | First replay OK→refused (`422`/`403` via owner/transition guards). **Stale-round release destroys a newer claim round** — no round binding (E5/D4) | Yes, but two-step: in_progress/blocked → pause (`claimed`) **then** release as two commits in the same transaction (`1195-1202`) | **NO** — open |
| 5 | **renew** | `POST /work-claims/:id/renew` → `renewWork` | **No** — `{progressMessageId?, note?, leaseHours?}` (`1256`) | Each replay **extends the lease again** and stamps a new `renewed` entry (`1293`). Only guard: a *cited* progress message must be newer than current lease start (`1287-1291`); uncited renews re-fire freely | Yes | **NO** |
| 6 | **reassign** | `POST /work-claims/:id/reassign` → `reassignWork` | **No** — `{newOwner, note}` (`1207`) | Same-owner replay **re-runs**: clears attestations/reviews again, stamps another `reassigned:<target>` entry (`work-claims.mjs:864`), re-emits wake + room event (`1225-1230`) | Yes | **NO** |
| 7 | **close / cancel** | `POST /work-claims/:id/close`, `.../cancel` → `closeWork`; MCP `room_close_work_claim` → `closeWorkClaim` | **No** — `{reason?}` (`1174`) | Terminal-state guard → **422** `work_claim_terminal` (`work-claims.mjs:727`), refused not duplicated. MCP path transactional (`work-claim-routes.mjs:533`) | Yes | **PARTIAL** |
| 8 | **review** (verdict) | `POST /work-claims/:id/review` → `recordReview` | **No** — `{verdict, summary, url?}` (`1137`) | Identical content → **byte-identical no-op, no commit, no event** (`1145-1150`). But the code's own comment (`work-claims.mjs:804-805`): *"A request ID is still needed to distinguish delayed retries after a newer verdict"* — a delayed retry after a newer verdict **clobbers** it with a new stamp | Yes | **PARTIAL** |
| 8b | **attest** (note) | same route → `attestWork` | **No** — `{note?}` (`1152`) | Same reviewer + same basis → replace in place, **no history entry, no event** (`work-claims.mjs:782-785`); identical note → unchanged (`780`) | Yes | **PARTIAL** (same self-admitted gap) |
| 9 | **PR-link** | `POST /update` + `appendPullRequest` → `linkWorkClaimPullRequest` → `appendWorkPullRequest`; MCP `room_link_work_claim_pr` | **No requestId, but REQUIRES round CAS**: `expectedClaimedAt` + `expectedHistoryLength` are mandatory (`work-claims.mjs:604-608`) | Same-round duplicate → **byte-identical no-op, returns original `work`** (`653`), no write, no event. Stale → **409** `work_claim_conflict` (`612-622`). Same-millisecond reclaim tie-break via round-end history scan (`625-651`) | Yes — one shared transaction across HTTP+MCP (`589-591`), `registry.transaction(run)` (`581`) | **YES** |
| 10 | **sweep** (lease auto-release) | `POST /work-claims/sweep` → `sweepRoom`/`releaseExpired`; **also runs at the top of every route call** (`749`) | n/a | Idempotent by construction — only lapsed claims transition; re-sweep is a no-op (`388-406`) | Yes — inside the route transaction | **YES** |
| 11 | premise flag / clear | `POST /work-claims/:id/premise-invalid` → `flagPremiseInvalid` / `clearPremiseFlag` | **No** | Replay re-stamps history each time (no dedupe) | Yes | **NO** (minor; listed for completeness) |

---

## Cross-cutting findings

### F1 — No idempotency-key surface anywhere on work-claim writes
`grep -i "idempot|requestId|request_id|Idempotency-Key" server/work-claim-routes.mjs` → **zero hits**. Every mutating route body is validated by `shape()` which **rejects unknown keys with 422** (`server/work-claim-routes.mjs:109-114`) — a client cannot even smuggle a key in. The `IdempotencyCache` (15-min TTL, returns original response on key hit) exists at `bridge/lib/idempotency.mjs` but is wired **only into `bridge/lib/bridge.mjs`** — no work-claim transport uses it.

### F2 — Replay safety is state-guard-shaped, not key-shaped
`create`/`claim`/`close` survive retries only because the state machine *refuses* the second attempt (409/422) — they **error instead of returning the prior result**. Only `review` (same-content) and `pr-link` (same-round) return the prior state cleanly.

### F3 — Round-binding (CAS) exists in exactly two places
1. **PR-link: mandatory** — `expectedClaimedAt` + `expectedHistoryLength`, 409 on mismatch (`server/work-claims.mjs:604-622`; MCP passes them through at `server/mcp-full-profile.mjs:244-252`).
2. **Update: opt-in** — same fields accepted but *optional* (`server/work-claim-routes.mjs:1029, 1046-1062`); legacy path clobbers (comment `1038-1045`).
3. **Release / claim / renew / reassign: none** — stale retries act on whatever the current row is.

### F4 — Atomicity is sound per single commit
- All HTTP routes run inside `registry.transaction(run)` (`server/work-claim-routes.mjs:650`) — better-sqlite3 synchronous transactions, so the claim row (`work-claim-sqlite.mjs:73-81` upsert) and its `work_claim.updated` room event commit **together** (`server/work-claim-events.mjs:10-12` documents this).
- Pure functions build one frozen object via `withHistory` (`server/work-claims.mjs:452-460`) → single upsert; no partial-object writes possible.
- `/release` on in_progress/blocked does **two** commits (pause → release) inside the **same** transaction (`1195-1202`) — atomic together, but two history stamps and no round token on either step.
- MCP `room_close_work_claim` / `room_link_work_claim_pr` each wrap in `registry.transaction` (`work-claim-routes.mjs:533, 581`).
- The `IdempotencyCache` comment notwithstanding, there is no request-response journal for work-claim writes: **no replay of a prior response is possible** — only refusal or re-execution.

### F5 — MCP write surface is narrower than discovery implies
Implemented MCP work-claim writes: `room_link_work_claim_pr` and `room_close_work_claim` only (`server/mcp-full-profile.mjs:244-276`). The "work" focus list names `room_acquire_claim`, `room_renew_claim`, `room_release_claim`, `room_record_handoff` (`server/mcp-discovery.mjs:39-40`) — these names have **no definitions in `hostedMcpToolDefs`** (searched `server/mcp-hosted-tools.mjs`) and are silently dropped by the focus filter (`mcp-discovery.mjs:53`). Flagged, not scored.

---

## #2088 merge state (per task instruction)

- **State: OPEN, mergeable = CONFLICTING, not merged** (`gh pr view 2088`: state OPEN, mergedAt null, mergeable CONFLICTING; title "Compare-and-release: bind work-claim /release to the claim round (E5/D4)").
- It would make `expectedClaimedAt` + `expectedHistoryLength` **required** on `POST /work-claims/:id/release` (openapi `required: [expectedClaimedAt, expectedHistoryLength]`, stale → 409 `work_claim_conflict`), bind clients (`client/room-agent.mjs`, `client/room-coord.mjs`, `scripts/agent-inbox.mjs`), and thread the compare through `server/work-claim-routes.mjs` + `server/work-claims.mjs`.
- **Scored as OPEN:** the current release path has **no round binding** — an authority holder's delayed `/release` retry (or any stale client) can release a **newer claim round** after re-claim (the confirmed E5/D4 failseq). The only current protection is the owner check, which an owner/manage_claims holder passes against the *new* row.

---

## B11 worst-gap handoff

1. **Release (E5/D4) — worst.** Confirmed failure sequence, fix written (#2088) but **CONFLICTING and unmerged**. Stale release destroys a newer claim generation. B11 should rebase/land #2088 (or re-implement compare-and-release on `/release`).
2. **Reassign — no CAS at all.** Replay re-clears attestations, re-stamps history, re-fires wakes and the room event. Same `expectedClaimedAt`/`expectedHistoryLength` binding pattern as #2088 would close it; second-worst because the blast radius is owner reassignment + attention wakes.
3. **Renew — non-idempotent by design.** Every retry extends the lease window again. Needs either a requestId journal or a renew-token bound to the current lease window.
4. **Update — opt-in CAS defaults off.** Legacy path silently clobbers newer state with 200 on stale retry (code admits it). Making the preconditions required (or warning on absent) is the B11 follow-up.
5. **No requestId journal anywhere** — the `IdempotencyCache` in `bridge/lib/idempotency.mjs` is the ready-made 15-min dedupe primitive (returns original response on key hit, conflicts on mismatched input hash); wiring it into the work-claim routes would convert every PARTIAL above toward YES.

---

## Line-index of key citations

- `server/work-claims.mjs`: `createWork` ~491 · `claimWork` ~531 · `renewWork` ~545 · `appendWorkPullRequest` + CAS `592-622` · no-op `653` · `updateWork` ~658 · release-via-unclaimed in updateWork ~703-720 · `closeWork` + terminal guard `722-747` · `attestWork` no-op `780-785` · `recordReview` idempotent-return `804-807` + requestId comment `804-805` · `reassignWork` `838-864` · `releaseExpired` `877-898` · `claimHistoryLength` `446-447` · `withHistory` `452-460`
- `server/work-claim-routes.mjs`: `shape` strict-fields `109-114` · `handleWorkClaims` transaction `650` · create + dup-409 `902-910` · claim + state-409 `973-976` · update opt-in CAS `1027-1062` (legacy-clobber comment `1038-1045`) · review dedupe `1131-1150` · release route + 2-step pause/release `1186-1204` · reassign `1206-1243` · renew `1254-1294` (message-freshness `1287-1291`) · `closeWorkClaim` + txn `502-534` · `linkWorkClaimPullRequest` + txn `535-581` · sweep-on-every-call `749` · `sweepRoom` `388-406`
- `server/work-claim-sqlite.mjs`: upsert `73-81` · `transaction` injected from `server/store.mjs:1210-1213`
- `bridge/lib/idempotency.mjs`: 15-min `IdempotencyCache` — unused by work-claim transports
