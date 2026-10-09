# Projection-cost table (WAVE-500 W2)

Measured 2026-10-09 on branch `wave500/event-survival` by
`tests/projection-cost-measurement.test.js`: a real `RoomStore`
(`:memory:`) with real commands through `store.command`, snapshotting
`rooms.projection` before and after each batch. Per-op cost = byte delta ÷
op count. Each row is measured on a fresh fixture; numbers are exact for
this code state, not estimates.

## Budget context

- `PILOT_LIMITS.projectionBytes = 4MB` (`4*1024*1024`, `server/store.mjs:427`)
  — the folded-projection cap enforced by the live guard
  (`server/agent-invites.mjs:312`: `Buffer.byteLength(storedProjection)`).
- The byte measure here matches the guard exactly: the same
  `Buffer.byteLength(storedProjection)` is snapshotted.
- Fresh empty room starts at 719 bytes — negligible headroom cost.
- The stored projection drops the event log, seenEvents and
  seenIdempotencyKeys (`server/store.mjs:620`), so event appends, log
  trimming and dedup state cost **nothing** in the projection. In-place
  mutations that don't grow the folded state (status renames, mute
  toggles, decision records pointing at existing messages) measure ~0.
- Verdict rule: **hog** = ≥4194 B/op, i.e. 1000 ops of that type alone
  exceed the 4MB cap. **Watch** = 1000 ops take ≥20% of the cap.

## Table

| Operation | Projection bytes added per op (measured) | % of 4MB budget per 1000 ops | Verdict |
|---|---|---|---|
| message.posted (10KB body) | 10398 | 247.9% | HOG |
| work.proposed (1KB definitionOfDone) | 1639 | 39.1% | watch |
| claim.acquired (3 paths) | 1358 | 32.4% | watch |
| message.posted (1KB body) | 1182 | 28.2% | watch |
| work_claim.updated (note-update receipt; 4000B note stays in the work_claims table) | 1006 | 24.0% | watch |
| work_claim.updated (thin receipt) | 953 | 22.7% | watch |
| work.proposed (typical ~300B text) | 699 | 16.7% | ok |
| work.completed (200B summary, room_text evidence) | 509 | 12.1% | ok |
| message.posted (150B body, typical chat) | 309 | 7.4% | ok |
| message.edited (150B→150B rewrite) | 267 | 6.4% | ok |
| member.added (agent, 3 permissions) | 215 | 5.1% | ok |
| claim.renewed | 52 | 1.2% | ok |
| claim.released | 42 | 1.0% | ok |
| message.reaction_set | 31 | 0.7% | ok |
| work.superseded | 3 | 0.1% | ok |
| work.accepted | 0 | 0.0% | free |
| work.started | 0 | 0.0% | free |
| member.mute_set | 0 | 0.0% | free |
| decision.recorded (200B note) | 0 | 0.0% | free |

"Free" ops are genuinely ~0 — they only rename fields or touch tables
outside the projection.

## 500 agents: which types hit the 4MB ceiling first

Math: at 500 agents each doing N ops/day of one type, the room's daily
projection spend is `500 × N × bytesPerOp`. The ceiling binds when that
exceeds 4,194,304 B, i.e. per-agent capacity is `4,194,304 ÷ 500 ÷
bytesPerOp`. All bytesPerOp are the measured values above.

| Operation | Max ops/day/agent at 500 agents before the room hits 4MB |
|---|---|
| message.posted (10KB body) | 0.8 |
| work.proposed (1KB definitionOfDone) | 5.1 |
| claim.acquired (3 paths) | 6.2 |
| message.posted (1KB body) | 7.1 |
| work_claim.updated (note-update receipt) | 8.3 |
| work_claim.updated (thin receipt) | 8.8 |
| work.proposed (typical ~300B text) | 12.0 |
| work.completed (200B summary) | 16.5 |
| message.posted (150B typical chat) | 27.1 |
| message.edited (150B→150B) | 31.4 |
| member.added | 39.0 |
| claim.renewed | 161 |
| claim.released | 200 |
| message.reaction_set | 271 |

Concrete mixes (room of 500 agents, one day):

- **Big messages first**: 500 × 1 × 10KB message = 5.2MB > 4MB. A single
  10KB post per agent per day already overflows the projection by itself
  (needs 8,389 B/agent/day; one post costs 10,398). This is the #1 hog.
- **1KB posts**: 500 × 8 × 1,182 = 4.7MB — eight 1KB posts per agent per
  day fills it.
- **Typical chat (150B)**: 500 × 27 × 309 = 4.18MB — ~27 short messages
  per agent per day alone fills it.
- **Claim lifecycle**: 500 agents each claiming + completing one piece of
  work per day (claim.acquired 1,358 + work.completed 509 = 1,867 B)
  spends 933.5KB — 22% of the cap. Thin work_claim receipts at 953 B each
  are the same order as 1KB chat messages.
- **Board churn is cheap**: propose/accept/complete/renew/release —
  except proposals with long definitions — are all < 60 B/op after the
  initial proposal. Accept/started/mute/decision ops are ~0.

Takeaway: at 500-agent scale the projection budget is a **chat-volume**
budget. Message bodies are the only thing that moves the needle; claim
mechanics, renewals, reactions and mute/decision traffic are noise. Any
room expecting >27 messages/agent/day (or any 10KB-scale drops) needs the
bodies-out-of-projection design (`docs/wave500/BODIES-OUT-OF-PROJECTION.md`),
not a bigger event cap.
