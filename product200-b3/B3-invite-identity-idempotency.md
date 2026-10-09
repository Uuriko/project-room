# B3 — Idempotency audit: invite/identity mutations

Audit slice: B3/50 (respawn). Coverage: every mutating op on the invite and
identity surface — guest invites, agent invite codes, referral invites,
share links, human invitations, agent identities, access requests. Pure
read-only audit, no code changes. All findings verified against
`origin/main` @ `ac9c2bc5` (2026-10-08).

**Verdict key:** YES = idempotent (dedupe key + prior result returned on
replay, or structurally single-effect). PARTIAL = fail-closed, no
double-write, but replay does not return the prior result (no requestId /
error-coded replay). NO = retried request double-writes.

**Dedupe key + window columns** answer: requestId? / dedupe key + window? /
replay returns prior result or double-writes? / redeem atomicity?

---

## Matrix

| # | Op (route / method) | requestId? | Dedupe key + window | Replay behavior | Atomicity | Verdict |
|---|---|---|---|---|---|---|
| 1 | Guest invite mint — `POST /api/rooms/:id/guest-invites` (`GuestInvites#mint`, `server/guest-invites.mjs:431`) | REQUIRED (422 without) | `(room_id, minted_by_member_id, issue_request_id)`; no TTL/window — record lives for the invite's life | Replay → `duplicate:true` + prior issued payload; plaintext code returned ONLY on first response (shown once) (`:471-493`) | Single `store.transaction` | YES |
| 2 | Guest invite redeem — `POST /api/guest-invites/redeem` (`redeem`, `server/guest-invites.mjs:530`) | NO | Single-use CAS: `UPDATE guest_invites SET status='redeemed' … WHERE id=? AND status='active'` (`:609-612`) | Re-redeem (still-active invite, same identity) → `duplicate:true` (seat reuse); after burn → `410 invite_unavailable`. No prior-result return for the second identity | Consume + member.add + credential insert in one `store.transaction` (`:543-622`) | PARTIAL |
| 3 | Guest self-serve join — `POST /api/guest-invites/request` (`requestSelfServe`, `server/guest-invites.mjs:637`) | REQUIRED — `joinRequest.requestId`, cryptographically bound by card signature (`:678-688`) | `guest_selfserve_idem(room_id, key_hash, request_id)` PK; at most one record per (room,key); new requestId supersedes + deletes old | Identical retry → issuance metadata with `replayed:true`, Bearer <redacted> NEVER re-disclosed (`:701-728`); new requestId → rotate (old revoked) + fresh pass | Single `store.transaction` | YES |
| 4 | Guest invite revoke — `POST …/guest-invites-revoke` (`revoke`, `server/guest-invites.mjs:880`) | NO | State guard: `status='active'` else `409 invite_not_active` | Replay → `409` (fail-closed); no double effect | Transaction | PARTIAL |
| 5 | Guest disconnect — `POST …/guest-invites-disconnect` (`disconnect`, `:900`) | NO | Member active check; replay on inactive → `404 guest_not_found` | Replay → `404` (fail-closed) | Transaction | PARTIAL |
| 6 | Guest revoke-all — `POST …/guest-invites-revoke-all` (`revokeAll`, `:922`) | NO | Per-member active check; replays deactivates nothing new | Replay → `revoked:0`; safe, response differs | Transaction | PARTIAL |
| 7 | Guest tier upgrade — `POST …/guest-invites-upgrade` (`upgrade`, `:965`) | NO | Same tier → `{ unchanged:true }` early return (`:1000`) | Replay of same tier → idempotent response; no journal spam | Transaction | YES |
| 8 | Guest credential rotate — `POST /api/guest-invites/rotate` (`rotate`, `:1019`) | NO | Old token revoked on use; replay with old token → `410` | Fail-closed; every call mints a fresh token (rotation, not issuance) | Transaction (insert new + revoke old) | PARTIAL |
| 9 | Agent invite create — `POST /api/rooms/:id/agent-invites` (`AgentInvites#create`, `server/agent-invites.mjs:145`) | **NO** — HTTP wrapper rejects extra fields; only `permissions/profile/expiresInMinutes/displayName` (`server/http.mjs:4142-4145`) | NONE — fresh `randomSymbols` code per call; scrypt hash computed pre-lock | **Retried mint (client timeout after server commit) → DOUBLE-WRITE: two live codes** | Transaction | **NO** |
| 10 | Agent invite redeem — `POST /api/agent-invites/redeem` (`redeem`, `server/agent-invites.mjs:220`) | NO | Single-use CAS: `UPDATE agent_invite_codes … WHERE code_hash=? AND redeemed_at IS NULL AND revoked_at IS NULL` + `changes===1` check (`:311-315`) | Same identity re-redeem → `duplicate:true` + linked member (`:247-255`); other identity → `409 invite_already_used` | member.add + identity_links + burn + referral record in one `store.transaction` (`:239-333`); referral exactly-once via referrals PK | PARTIAL |
| 11 | Agent invite revoke — `DELETE /api/rooms/:id/agent-invites` (`revoke`, `server/agent-invites.mjs:395`) | NO | Lookup restricted to unredeemed/unrevoked; replay → `404 invite_unavailable` | Fail-closed | Transaction | PARTIAL |
| 12 | Referral invite mint — `POST /api/referral-invites/mint` (`ReferralInvites#mint`, `server/referral-invites.mjs:255`) | **NO** — no requestId param at all | NONE — fresh `randomUUID` jti + Ed25519-signed token per call | **Retried mint → DOUBLE-WRITE: two live referral tokens (two ledger rows)** | Transaction | **NO** |
| 13 | Referral invite redeem — `POST /api/referral-invites/redeem` (`redeem`, `:364`) | NO | CAS: `UPDATE referral_invites SET status='redeemed' … WHERE jti=? AND status='minted'` + `changes===1` (`:482-485`) | Replay after claim → `404 invite_unavailable` (no duplicate path — unlike agent-invites) | member.add + identity_links + ledger claim + chain_members in one transaction (`:421-496`) | PARTIAL |
| 14 | Identity mint (HTTP) — `POST /api/agent-identities` (`AgentIdentities#create`, `server/agent-identities.mjs:325`; route `server/http.mjs:2896`) | **NO** — HTTP route `exact()`-matches fields to `["displayName",("recoverable"),("proof")]`; any requestId is **rejected** (`server/http.mjs:2899-2902`) | NONE — fresh `ai_<random>` id + new secret per call. Only the `suppliedSecret` (recoverable) path returns `duplicate:true` (`:344-363`) | **Retried POST after server commit → DOUBLE IDENTITY** (new secret each time; the first secret may be lost to the client). Rate limits (`rate(identity-create:ip, 30)`, anonymous address/network/daily budgets, PoW) bound abuse but do NOT prevent one honest retry from duping | Transaction; anonymous mint + `noteIdentityMint` outside? No — `create` is the transaction; route's `noteIdentityMint` runs after (growth loop, non-critical) | **NO** ← worst finding |
| 15 | Identity mint (MCP) — `room_identity_mint` (`server/mcp-identity-mint.mjs:63`) | NO (`requestId` here is only the JSON-RPC message id — not an idempotency key; not persisted) | Same as #14: `store.identities.create` unconditionally | Same as #14: retried `tools/call` after commit → double identity. Tool text itself warns "Mint once per agent" — the API cannot enforce it | Transaction | **NO** |
| 16 | Identity link (admit into room) — `POST …/identity-links` (`link`, `server/agent-identities.mjs:606`; route `server/http.mjs:4121`) | NO | `identity_links(room_id,identity_id)` pre-check → `409 identity_already_linked` (`:645-647`) | Replay → `409` fail-closed; relink-after-unlink → `relinked:true` | Transaction (command + links row + request settle) | PARTIAL |
| 17 | Identity unlink — `DELETE …/identity-links` (`unlink`, `:714`) | NO | Missing link → `404 identity_not_found` | Replay → `404` fail-closed | Transaction | PARTIAL |
| 18 | Identity rotate — `POST /api/identity-rotate` (`rotate`, `:865`) | NO | Conditional `UPDATE … WHERE secret_hash=? AND revoked_at IS NULL`; stale concurrent rotate → `409 secret_changed` | Replay with old secret → `401` (old secret fails auth); replay with NEW secret → issues ANOTHER new secret (rotation, not issuance) | Transaction (update + API-key revocation) | PARTIAL |
| 19 | Identity revoke — (`revoke`, `:906`) | NO | `authenticateIdentitySecret` refuses revoked rows | Replay with revoked secret → `401` fail-closed; no double effect | Transaction | PARTIAL |
| 20 | Identity link-code mint — (`mintLinkCode`, `:921`) | NO | Cap `MAX_OUTSTANDING_LINK_CODES`; single-use consume | Retry → mints a NEW code (cheap, sender-consumed; still no dedupe) | Transaction | PARTIAL |
| 21 | Identity expireInactive — (`expireInactive`, `:495`) | n/a (background sweep, called inside `create`) | Conditional `DELETE … WHERE activated_at IS NULL AND revoked_at IS NULL` + retention clauses | Inherently idempotent; repeat run is a no-op | Transaction | YES |
| 22 | Access request file — `POST /api/rooms/:id/access-requests` (`AccessRequests#request`, `server/access-requests.mjs:171`; route `server/http.mjs:3056`) | YES — documented idempotency key (`server/http.mjs:3077`: "requestId is your idempotency key — reuse it when retrying"); defaults to generated `ar_<uuid>` | `access_requests.request_id` PK; cross-identity reuse → `409 request_conflict` (`:201-205`) | Replay → original request row; retried auto-approval returns the approval record incl. memberId + grant (`:206-214`) | Transaction | YES |
| 23 | Access request decide (approve/deny) — (`decide`, `:624`) | NO (uses the request's own requestId as target, not a mutation key) | Non-pending → `409 already_decided` (`:633-634`); already-member grant path is a no-op close | Replay → `409` fail-closed; no double grant | Transaction (link + status update + referrals record; exactly-once via referrals PK) | PARTIAL |
| 24 | Share-link create — `POST /api/rooms/:id/share-links` (`ShareLinks#create`, `server/share-links.mjs:278`) | REQUIRED (`validId(requestId)`, `:280`) | `UNIQUE(room_id,issuer_*,request_id)` (schema `:30-32`); fingerprint check → `409 idempotency_conflict` on same-key-different-params (`:308`) | Replay → `{ link, duplicate:true }`; concurrent dupes collide on the UNIQUE index (DB-level, no TOCTOU) | Transaction | YES |
| 25 | Share-link agent join — (`joinAgent`, `:228`) | NO (link token is the key; re-join detection by `identity_links`) | Existing link → `duplicate:true` (`:237`); redemption-idempotency table for the no-invitation path (`:40-45`) | Replay → `duplicate:true`, no second member/event | Transaction (event + links + referral credit) | YES |
| 26 | Human invitation create — `POST /api/rooms/:id/invitations` (`store.mjs:~3200`; requestId validated `server/http.mjs:4908-4918`) | REQUIRED | `(room_id, issuer_account_id, issue_request_id)` + partial agent index, DB-unique (`server/store.mjs:597-598`); fingerprint → `409 idempotency_conflict` (`:3248`) | Replay → `duplicate:true` + prior invitation | Transaction | YES |
| 27 | Human invitation accept — `POST /api/invitations/accept` (`acceptInvitation`, `server/store.mjs:3387`) | **redemptionId as replay key** (required, `redemptionPattern`, `:3388`) | CAS: `UPDATE membership_invitations … WHERE id=? AND revision=0 AND status='pending'` (`:3443-3445`) | Same redemptionId after accept → `duplicate:true` + prior invitation/event/session (`:3401-3406`); different redemptionId → `409 invitation_already_used` | member.add + member_accounts + accept update + journal in one transaction | **YES** — model op |
| 28 | Human invitation revoke — (`revokeInvitation`, `server/store.mjs:3354`) | NO | `expectedRevision` + `status='pending'` guards | Replay → `409` fail-closed | Transaction + journal | PARTIAL |

---

## Verdict tally

- **YES: 8** (#1, #3, #7, #21, #22, #24, #25, #27)
- **PARTIAL: 15** — all fail-closed, no double-writes observed (single-use CAS burns, state-guarded revokes/disconnects/unlinks, `already_decided`/`identity_already_linked` 409s)
- **NO: 3** — #9 agent-invite create, #12 referral-invite mint, #14/#15 identity mint (HTTP + MCP; counted as one op, two doors)

---

## Worst finding (for B11)

**Identity mint has zero idempotency support — a retried `POST /api/agent-identities` (or MCP `room_identity_mint`) double-mints an identity.** File:line: `server/agent-identities.mjs:325` (`create()` — no requestId accepted, fresh random `ai_<…>` id + secret per call), `server/http.mjs:2896-2902` (route `exact()`-validates the body to `displayName/proof/recoverable`; a client-sent idempotency key is *rejected* as an unexpected field), `server/mcp-identity-mint.mjs:63-92` (JSON-RPC `id` is not persisted as a key; `store.identities.create` unconditionally).

Failure sequence: client sends mint → server commits → response lost (timeout, dropped connection) → client retries per the documented failure-recovery discipline → server mints a **second** identity with a **second secret**. The client now holds two identities; the first secret may be effectively lost. Consequences: orphaned rows counting against `identityLimit`/anonymous budgets, confused onboarding (which secret authenticates?), and duplicate identities feeding the already-known recovery-flow complexity (`suppliedSecret` path exists precisely because clients lose secrets). Mitigations in place are abuse-bounds, not correctness: per-IP `rate(identity-create:ip, 30)`, anonymous address/network/daily budgets, PoW — none prevent one honest retry from duping.

Honorable mentions (same defect class, lower blast radius): agent-invite `create` (`server/agent-invites.mjs:145`, route field-gated at `server/http.mjs:4142-4145`) — retried mint yields two live codes; referral-invite `mint` (`server/referral-invites.mjs:255`) — retried mint yields two live signed tokens. The established in-repo patterns to copy: human-invitation `create` (requestId + UNIQUE index + fingerprint 409 — `server/store.mjs:597-598,3240-3250`) and `acceptInvitation`'s redemptionId replay key (`server/store.mjs:3387-3406`).

---

## Notes for B1 matrix merge

- **Dedupe windows:** nowhere on this surface is there a TTL on an idempotency record. Records live for the invite/request lifecycle (guest_selfserve_idem superseded on rotation; invitation request rows retained for audit). This is retention-by-design, not a gap — but worth stating explicitly in the matrix's "window" column.
- **Code-shown-once semantics:** guest-invite mint and self-serve issuance deliberately withhold the secret on replay (security), while human-invitation accept replays the full prior result (invitation + event + session). The matrix should distinguish "returns prior result" (safe to replay to recover state) from "returns metadata without secret" (replay proves success but cannot recover the credential).
- **Transaction story is uniformly good:** every redeem/accept/link path performs consume+grant inside a single `store.transaction`; CAS burns (`WHERE status='active'/'minted'`, `changes===1`) back all single-use consumes. No partial-write path found on the invite/identity surface.
- **Journal event ids:** membership-mutation events use `randomUUID()` (e.g. `agent-identities.mjs:655,727`) rather than deterministic idempotency keys, but journal dedupe is never the idempotency mechanism here — DB state guards are. No finding, just noting for the B1 "dedupe key" column.

Audit: Jill B3/50, 2026-10-08. Read-only; no code touched.
