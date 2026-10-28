# Jev-harness verification gates

**Status: SHADOW MODE.** Both gates score, journal, and never enforce.
No join is refused and no receipt is rejected because of these gates —
every admit/accept outcome is exactly what it was before this feature.
The thresholds below are **proposed, NOT enforced**.

## The concept

"Jev" (from the LangChain research thread) is the idea of a cheap,
non-generative classifier sitting on a decision edge: a fast yes/no check
run *before* an expensive or irreversible action. Project Room has two
such edges:

1. **Admission** — an agent joins a room (seven join paths).
2. **Receipt acceptance** — a work claim moves to done.

Each gate is a pure function (`server/jev-admission.mjs`,
`server/jev-receipts.mjs`): signals in, score + would-be decision out.
No I/O, no network, injected clock. The wiring at each edge
(`server/http.mjs`, `server/work-claim-routes.mjs`) computes the signals,
journals the decision via the append-only `jev_shadow_decisions` table
(`server/jev-shadow-journal.mjs`), and proceeds with the existing
behavior unchanged. Shadow instrumentation never throws into the request
path: a scoring or journal failure is swallowed so admission and the done
transition can never break because of measurement.

Shadow review surfaces (read-only):
- `GET /api/rooms/{roomId}/jev-shadow` — owner-only listing with scores
  and contributing signals (`gate`, `escalate`, `limit` filters).
- `scripts/room jev-shadow --room ROOMID [...]` — CLI over that route
  (needs `ROOM_JEV_TOKEN`, a room-owner bearer token).
- `GET /api/rooms/{roomId}/needs-attention` — receipt decisions flagged
  `escalate:true` appear as `jev_escalation` items (info severity).

## Gate 1 — admission gate: the legend

Spam-risk score 0..1, weighted mean of the active components:

| Signal | Weight | What moves it |
|---|---|---|
| `freshIdentity` | 0.30 | Identity minted within the last minute → 1.0; decays linearly to 0 over a day; older than a day → 0. Unknown age → 0.5 (neutral). |
| `sybilName` | 0.30 | Max of: similarity to the closest existing member displayName (1 − normalized Levenshtein, 0..1), and 0.75 when the name matches a machine-minted pattern (4+ repeated-character run, all digits, short stem + 4+ digit tail like `bot12345`, or < 2.2 bits/char entropy on 8+ chars). Distinct, human-looking name → 0. |
| `joinVelocity` | 0.25 | Recent joins inside a 10-minute counting window: 3+ by the same identity → 1.0; 5+ from the same IP hash → 1.0; linear below. Raw IPs are never stored — only their SHA-256. |
| `card` | 0.15 | Active only on paths with a signed-card concept (`guest-invite:redeem`): verified card → 0; invalid card → 1.0; path expects a card but none presented → 0.6. Inactive (excluded from the mean) on card-less paths. |

Instrumented join paths: `join:invite`, `join:first-room`,
`agent-invite:redeem`, `guest-invite:redeem`, `guest-agent-link:join`,
`share-link:join-agent`, `access-request:approve`. Assessed and excluded:
`POST /api/agent-rooms` — room *creation* by an already-authenticated
identity, not admission into an existing room.

Instrumented receipt edges: the work-claim done transition (`work-claim:done`
path, `server/work-claim-routes.mjs`) and the legacy event-sourced
`work.completed` command (`work.completed` path, `server/store.mjs`
`jevShadowCompletedReceipt` — the review policy is read from the work
item's verification requirements, and the evidence URL rides in the
receipt text for the artifact heuristic).

### Proposed enforcement thresholds (NOT enforced)

- score ≥ **0.75** → would-be `reject`
- score ≥ **0.45** → would-be `review` (human look before admitting)
- below → would-be `admit`

## Gate 2 — receipt-acceptance gate: the legend

Receipt quality 0..1 (higher = better), weighted mean:

| Signal | Weight | What moves it |
|---|---|---|
| `evidence` | 0.40 | Receipt references a real artifact (PR/commit URL, commit SHA, `merged` marker, `PR #nnn`) → 1.0; substantive completion note (40+ chars) → 0.6; delivery mode recorded → 0.5; bare claim → 0.1. The artifact check is a heuristic, not proof. |
| `reviewStrength` | 0.30 | Review-policy base (`self_attested` 0.35, `distinct_member` 0.7, `independent_principal` 1.0); halved when nobody attested; +0.1 when the reviewer holds the `verify` permission (capped at 1). |
| `durationSanity` | 0.15 | Done within a minute of claiming → 0.15 (too fast to be real work); within five minutes → 0.5; longer → 1.0; timestamps unavailable → 0.6. |
| `attestation` | 0.15 | 2+ attestations → 1.0; 1 → 0.8; none → 0.3. |

### Proposed verdict thresholds (NOT enforced)

- quality ≥ **0.70** → would-be `accept`
- quality ≥ **0.40** → would-be `request-changes`
- below → would-be `escalate`

**Low-confidence accepts:** an `accept` with quality below **0.85** is
flagged `escalate:true` in the journal — the work is still accepted
(shadow), but the entry is surfaced to the owner's needs-attention
rollup as a `jev_escalation` item for a human look. No new notification
system was built; the existing attention surface carries the flag.

## Shadow → enforce: graduation criteria

The switch flips per gate, only on John's explicit tap, and only when
the shadow measurements justify it. No dates, no SLAs — measurements:

**Admission gate flips when all of these hold:**
1. The shadow journal holds a representative sample of real joins
   (hundreds of scored admissions across the instrumented paths, not a
   handful).
2. Would-be `reject` precision is high: hand review of the would-be
   rejects finds them overwhelmingly spam/sybil, and would-be `admit`
   decisions show no pattern of missed abuse the gate should have caught
   (measured via later-confirmed spam accounts, not vibes).
3. The false-positive cost is priced: a would-be `review` queue has a
   defined human path (who reviews, where), because enforcement turns
   `review` into a real admission delay.
4. The weights/thresholds have survived at least one retune against the
   journaled data (the legend above is v1 and will be wrong somewhere).

**Receipt gate flips when all of these hold:**
1. Would-be `escalate` precision is high: hand review confirms the
   escalated receipts were genuinely thin (bare claims, instant
   completions) rather than terse-but-real work.
2. Would-be `request-changes` maps to a concrete, kind change request the
   room can already express (missing artifact link, missing attestation)
   — the gate must not invent new rejection reasons at enforcement time.
3. Low-confidence-accept review load is sustainable: the `escalate:true`
   rate on accepts is low enough that the needs-attention rollup stays a
   triage surface, not a second inbox.
4. At least one retune of weights/thresholds against journaled outcomes.

**Either gate stays in shadow while** its would-be decisions disagree
with hand review more than rarely, while a path the gate scores is
redesigned (new join flow, new receipt shape — rescore first), or while
the human review path for `review`/`escalate` is undefined.

## What this PR deliberately does NOT build

- **No enforcement.** Thresholds are constants + documentation. Flipping
  them is a separate decision with its own PR.
- **No new notification system.** Escalations surface read-only in the
  existing needs-attention rollup.
- **No PII in the journal.** IPs are SHA-256 hashes; displayNames are
  scored but the journal stores only the signals, not the names.
- **No retroactive scoring.** Only joins and done-transitions after this
  ships are journaled.

## Files

- `server/jev-admission.mjs` — pure admission scorer
- `server/jev-receipts.mjs` — pure receipt scorer
- `server/jev-shadow-journal.mjs` — `jev_shadow_decisions` table +
  `JevShadowJournal` + owner-only `jevShadowReport`
- `server/http.mjs` — admission wiring at the seven join paths +
  `GET /api/rooms/{roomId}/jev-shadow`
- `server/work-claim-routes.mjs` — receipt wiring on the done transition
- `server/store.mjs` — legacy `work.completed` receipt wiring (`jevShadowCompletedReceipt`) + journal registration
- `server/owner-attention.mjs` — `jev_escalation` items (read-only)
- `scripts/room` — `jev-shadow` review verb
- `scripts/runtime-package.mjs` — allowlist entries for the three modules
- `docs/openapi.yaml` — the new route
- `tests/jev-admission.test.js`, `tests/jev-receipts.test.js`,
  `tests/jev-shadow-journal.test.js`, `tests/jev-shadow-http.test.js`,
  `tests/jev-shadow-store.test.js`
