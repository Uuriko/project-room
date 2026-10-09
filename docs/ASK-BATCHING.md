# ASK Batching Protocol

**Wave:** WAVE-500 (coordination-overhead), worker 13/17.
**Status:** spec + validator (`scripts/ask-batch.mjs`). Not wired to any live room/CLAIM API.
**Scope:** `docs/` + `scripts/` only.

**Relationship to wave500-protocol (extend, don't fork).** This is the
worker→coordinator direction. `docs/BATCH-DISPATCH-SPEC.md` (worker 4/17 in
this same lane) covers the opposite direction — coordinator→worker fan-out.
The wave500-protocol branch's trial-task and push-ask code is unrelated.
Nothing here redefines those; if the protocol branch later standardizes a
worker-question envelope, this spec's `v` field exists so both can be
distinguished and migrated.

## 1. Problem

Workers hitting a question today burn a full round-trip each: worker posts
ASK → coordinator reads, answers → worker resumes. With 25 workers each
averaging 0.6 questions, that's ~15 coordinator round-trips per wave, each
one stalling a worker for a full coordinator turn. Worse, workers drip
questions one at a time, so the coordinator pays context-reload cost on
every single question and answers them in arbitrary arrival order instead
of priority order.

Batching turns the Q&A cycle from *one round-trip per question* into
*one round-trip per questioning worker per emission window* — and routes
most advisory questions out of the round-trip entirely.

## 2. Protocol

### 2.1 The ASK block

A worker accumulates questions into an **ASK block** and emits it as one unit.
The coordinator answers **all questions in the block in one round-trip**
(blocking first), and the worker resumes once.

| Rule | Value |
|---|---|
| Max questions per block | 5 |
| Max chars per question | 140 |
| Tag | `blocking` \| `advisory` (exactly one, required) |
| Max emissions | 1 block per **N minutes** (default **N = 20**, set per wave brief) **or** at a natural pause |
| Duplicate questions | rejected by the validator (same id, or same normalized text) |

**Natural pauses** (any of these may trigger an early emission even if N
minutes haven't elapsed): a milestone in the brief is complete; the worker
is about to start a long unattended run (tests, builds); the worker is
about to go idle; the worker's turn is ending.

**Tags:**

- `blocking` — the worker cannot proceed *correctly* without the answer.
  It will idle, guess wrongly, or collide with another lane. The
  coordinator answers these first.
- `advisory` — the worker proceeds with its best judgment *now*; the
  answer only corrects course later. These ride along in the block for
  free — they cost zero marginal round-trips.

### 2.2 Wire shape

JSON, validated by `scripts/ask-batch.mjs` (v1):

```jsonc
{
  "v": 1,
  "workerId": "wave500-coord-cost-w13",
  "waveId": "wave-500",
  "questions": [
    { "id": "q1", "tag": "blocking", "text": "Baseline harness: sample idle-loop CPU per worker or per wave?" },
    { "id": "q2", "tag": "advisory",  "text": "Prefer round-trip counts or wall-clock ms in the savings estimate?" }
  ]
}
```

The script renders two outputs:

- `--format room` — the multi-line block posted to the room log.
- `--format receipt` — a compact array pasteable into the worker receipt's
  `openQuestions` field (`docs/RECEIPT-SCHEMA.md` v1: ≤3 entries, ≤140
  chars each, blocking first, `[tag]`-prefixed, truncated to fit).

### 2.3 Coordinator side of the contract

The protocol is two-sided. The coordinator's obligations per received block:

1. Answer **every** question in **one** reply (one round-trip), blocking
   first, each answer referencing the question `id`.
2. Keep answers short (≤140 chars each is the goal; reference a
   claim/board/doc id instead of pasting context).
3. Never answer one question per reply — that re-creates the drip the
   protocol exists to kill.

## 3. Worker decision tree

For each question, walk the tree top to bottom. First match wins.

```
Q1: Is it BLOCKING? (Without the answer I will idle, guess wrongly, or collide.)
 │
 ├─ NO (advisory) ──→ Q2: Can I proceed with a reasonable assumption?
 │                       ├─ YES → PROCEED-WITH-ASSUMPTION-AND-FLAG.
 │                       │         Do the work, record the assumption in the
 │                       │         receipt (ask-batch --format receipt), let the
 │                       │         coordinator correct course async. ZERO round-trips.
 │                       └─ NO  → BATCH it (rides free in the next block).
 │
 └─ YES (blocking) ──→ Q3: Do I need the answer within the next N minutes?
                         ├─ NO  → BATCH it.
                         └─ YES → Q4: Can I make progress on a DIFFERENT part
                                    of the brief meanwhile?
                                    ├─ YES → Defer that sub-task, BATCH the
                                    │         question, keep working. (A block
                                    │         is not a mailbox — but an idle
                                    │         worker is worse.)
                                    └─ NO  → ASK NOW: one immediate single
                                             question (still tagged, still ≤140
                                             chars). Max one immediate ASK per
                                             worker per wave unless the answer
                                             unblocks the entire brief.
```

Rules of thumb:

- Never "ask now" for advisory. If it's not blocking, it waits for the block.
- An **assumption without a flag is a future collision.** The flag (receipt
  `openQuestions`, or the block itself) is what makes assume-and-proceed
  safe: the coordinator sees it and corrects course in their next turn.
- If you asked it this wave and got an answer, don't ask it again — check
  the room log first. The validator rejects duplicate texts *within* a
  block; the worker is responsible *across* blocks.

## 4. Anti-patterns

1. **One-question-per-message drip.** The exact overhead this protocol
   kills. Every drip is a full coordinator turn with context-reload cost.
2. **Batching a question you need in 2 minutes.** A block is not a mailbox.
   If the answer gates the next N minutes of work, walk the tree — Q4
   exists for this.
3. **Advisory questions tagged blocking.** Inflates the coordinator's
   priority queue and trains them to ignore your tags. Tag honestly; the
   tree rewards honesty with zero-round-trip advisory handling.
4. **140+ char essays.** If the question needs context the coordinator
   doesn't already have, the brief failed, not the protocol. Reference the
   claim or board id instead of pasting context.
5. **Re-asking across blocks.** Answered this wave = settled. Re-read the
   room log before emitting.
6. **Silent assumptions.** Proceeding on a guess *without* flagging it in
   the receipt. The coordinator can't correct what they can't see.
7. **Coordinator answering one question per reply.** The other half of the
   contract (§2.3). One block in, one reply out.
8. **Phantom urgency.** Tagging everything `blocking` so it jumps the
   queue. Blocking means "I am idle or wrong without this" — nothing less.
9. **Emitting an empty-or-one-advisory block on the timer.** If the block
   holds only trivia, let it ride to the next natural pause. The N-minute
   cap is a *ceiling* on emissions, not a *schedule*.

## 5. Worked example — 4 batched Q&As, one round-trip

Worker `wave500-coord-cost-w13` is writing this spec. Over ~15 minutes it
hits four questions, keeps working, and emits one block at the natural
pause (spec draft done, validator build about to start).

**The block** (`--format room` output of `scripts/ask-batch.mjs`):

```
ASK [wave500-coord-cost-w13] wave-500 — 2 blocking · 2 advisory (1 block = 1 round-trip)
[blocking] q1: Baseline harness: sample idle-loop CPU per worker or per wave? Per-worker doubles writes.
[blocking] q2: Claims board shows a wave500-protocol claim touching ask-dispatch — overlap with my ask-batching claim?
[advisory] q3: Savings estimate: report round-trip counts, wall-clock ms, or both?
[advisory] q4: Should the validator also lint question wording (e.g. flag "urgent")? Out of scope for v1?
```

**The coordinator's single round-trip reply** (all four, blocking first):

```
ANS [wave500-coord-cost-w13] — 4/4 in one round-trip
q1: Per wave — writes dominate at 25 workers; aggregate at wave level, keep per-worker sampling for the pilot only.
q2: No overlap. Theirs is dispatch (coordinator→worker fan-out); yours is Q&A (worker→coordinator). Extend, don't fork.
q3: Round-trip counts. Wall-clock is noise across parallel workers with different stall patterns.
q4: Out of scope for v1. Tag honesty is the worker's job; add linting only if a wave shows systematic tag abuse.
```

**How the worker acts on each:**

| Q | Tag | Action after the answer |
|---|---|---|
| q1 | blocking | Samples per wave in the harness (unblocked the measurement design). |
| q2 | blocking | Proceeds — confirmed no collision; keeps the claim. |
| q3 | advisory | Had already proceeded assuming round-trip counts; answer confirms. No rework. |
| q4 | advisory | Had flagged "wording lint" as deferred in the draft; answer confirms. No rework. |

Cost: **1 round-trip** for 4 questions. Unbatched, the two blocking
questions alone would have cost 2 round-trips (each stalling the worker),
and the advisory pair would likely have cost 2 more drips — 4 total.

## 6. Savings estimate — 25-worker wave

**Assumptions (marked; change the inputs, the arithmetic follows):**

- **A (brief-supplied):** 0.6 questions per worker per wave → 25 × 0.6 =
  **15 questions/wave**.
- **B:** Today, each question costs its own coordinator round-trip → **15
  round-trips/wave** unbatched.
- **C:** Questions arrive independently per worker (Poisson). Blocking and
  advisory split 50/50 (0.3 blocking + 0.3 advisory per worker).
- **D:** Advisory questions are handled per the decision tree: ~2/3
  proceed-with-assumption-and-flag (**0 round-trips**), ~1/3 ride free in a
  block (**0 marginal round-trips**).
- **E:** Blocking questions pack one block per questioning worker:
  P(worker has ≥1 blocking) = 1 − e^(−0.3) ≈ 0.259 → 25 × 0.259 ≈ **6.5
  blocks/wave** → ~6.5 round-trips. Immediate ASKs assumed negligible under
  the tree (Q4 absorbs them).

| Scenario | Round-trips/wave | Saved vs today |
|---|---|---|
| Today (one RT per question) | 15.0 | — |
| Batching, packing only (no behavior change: 15 questions → ~11.3 blocks) | ~11.3 | **~3.7 (~25%)** |
| Batching + decision tree (advisory → assume-and-flag) | ~6.5 | **~8.5 (~57%)** |

Headline: **~8–9 coordinator round-trips saved per 25-worker wave at
0.6 questions/worker** (15 → ~6–7), roughly a **55–60% cut** in Q&A
round-trips — with a ~25% floor even if workers change nothing but packing.

Caveats: the absolute saving is small at 0.6 q/worker because most workers
ask nothing. The protocol's value compounds in high-question waves
(onboarding, unfamiliar briefs at 2+ q/worker), where the same arithmetic
gives 50 questions → ~17 round-trips instead of 50. Unmodeled upside:
worker stall time drops even when round-trip count doesn't, because
advisory questions no longer block the worker at all.

## 7. Done checklist (this worker)

- [x] Protocol doc (`docs/ASK-BATCHING.md`) — this file
- [x] Validator + formatters (`scripts/ask-batch.mjs`) + self-test
      (`scripts/ask-batch.test.mjs`)
- [x] Worked example with 4 batched Q&As (§5)
- [x] Round-trip savings estimate with marked assumptions (§6)
- [ ] Not checked: live room/CLAIM wiring (out of scope); coordinator-side
      enforcement of the one-reply rule (needs protocol-branch buy-in)
