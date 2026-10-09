# Room-Chatter Cost Analysis (WAVE-500 coord-cost, worker 2/17)

Branch `wave500/coord-cost`. Claim `wave500-room-chatter-cost` (lane `wave500-coord-cost-lane`).

**Question:** how much of the room's 10,000-event lifetime budget is coordination
chatter, and what do the two cheapest interventions — (a) batching PROGRESS,
(b) structured DONE receipts — buy back?

**Companion docs (not duplicated):** `OVERHEAD-BASELINE.md` (worker 1/17 —
measured spawn/report/event cost structure), `OVERHEAD-MODEL.md` (worker 14 —
formal cost model; its §a composition `create+acquired ~2, state updates ~1–2,
heartbeat ~1, PR/CI/settle ~1–1.5` is reused here as the 6.5-event lifecycle
decomposition), `RECEIPT-SCHEMA.md` (worker 14 — structured receipt spec + byte
calibration), `SWARM-COORDINATION-PLAYBOOK.md` (heartbeat/PROGRESS-batching
discipline). Sibling implementation lanes: `mt-2` compactor, `hw-h3`
event-cap-runway, `guard-g7`/`guard-g7b` event-runway-alarm/compaction.

## 1. Classification — last ~500 coordination events

### 1a. Sample provenance (read this before the table)

The brief asked for the last ~500 **live muse-room** events. The live event log
(`GET /api/rooms/muse-room/events`) requires an enrolled agent identity; per
brief W8 ("protect credentials and identity secrets") this worker did not touch
the owner's connection token and did not self-mint an identity (persistent
external state + new secret — outside the brief). So there are two samples:

- **Measured:** the last 500 comments on the live work-claims board
  (`Uuriko/project-room#266`, ids 5697502923→6043925434, 2026-09-16→2026-10-07),
  fetched via `gh` into the git-ignored `.tmp/board-comments.jsonl`.
  The board is the *durable* coordination log — claims, receipts, reviews —
  not the ephemeral room stream. Prefix usage there is sparse because the
  HELLO/CLAIM/PROGRESS/ASK/REVIEW/IDEA/FRICTION/DONE/HANDOFF convention is a
  **live-room** message discipline.
- **Modeled:** the live-room per-lifecycle composition, built from
  `OVERHEAD-MODEL.md` §a (measured 6.5 events/lifecycle decomposition) and the
  harness baseline (CLAIM + PROGRESS×2 + DONE = 4.0, plus ~2.5 ACK/steer/
  handoff/ASK/REVIEW on real lifecycles).

A prior measurement exists for cross-check: Jill's 2026-09-26 taxonomy of ~600
`#266` comments found **status chatter ~30%**, claims ~17%, receipts ~21% —
and concluded status chatter "must not clog the board (it gets its own note
stream)". The chatter moved to the live room; the board is now almost entirely
substantive (see below).

### 1b. Prefix distribution (measured, board-500)

| Prefix | n | chatter share | median bytes | p90 bytes |
|---|---|---|---|---|
| CLAIM | 4 | 0% | 743 | 802 |
| PROGRESS | 1 | 0% | 502 | 502 |
| REVIEW | 1 | 0% | 780 | 780 |
| DONE | 2 | 0% | ~700 | 985 |
| (unprefixed) | 492 | 3% | 565 | 1,535 |
| **chatter (all)** | **14** | — | **22** | 130 |
| **substantive (all)** | **486** | — | **575** | 1,557 |

Chatter heuristic (mechanical, documented): body < 200 bytes with no structured
marker (fenced block, PR link, URL, "receipt/evidence/SHA/commit", markdown
heading), or a pure-ACK line (`ack`, `+1`, `roger`, `standing by`, `on it`,
`still working`). **Board chatter fraction: 14/500 = 2.8%.** The board has
become the substantive record; the chatter lives in the room.

### 1c. Live-room composition model (per claim lifecycle, 6.5 events)

| Class | events/lifecycle | chatter? | median bytes (basis) |
|---|---|---|---|
| CLAIM | 1.0 | no | 743 (board-measured) |
| PROGRESS (per-commit) | 1.5 | 1.0 of it (redundant pings) | 502 |
| DONE | 1.0 | no | ~700 |
| heartbeat | 1.0 | no — carries batched status | ~400 (assumed) |
| ASK | 0.5 | no | ~450 (assumed) |
| REVIEW | 0.3 | no | 780 |
| HANDOFF | 0.4 | no | ~500 (assumed) |
| HELLO / ACK | 0.8 | yes | 22 (board-measured) |
| **Total** | **6.5** | **1.8 (28%)** | — |

**Chatter fraction (room model): ~28%** — 1.0 redundant per-commit PROGRESS +
0.8 HELLO/ACK per lifecycle. This converges with Jill's 9/26 ~30% status-chatter
figure from when the chatter still lived on the board. Median event sizes are
board-measured where available; room messages skew smaller, so byte figures
below are conservative (upper bounds).

**Verification command** (needs an enrolled identity; run by the parent or a
credentialed lane — do NOT paste secrets into files):
`curl -s -H "Authorization: Bearer $ROOM_TOKEN" -A room-pulse/1.0
"https://room.trydemigod.com/api/rooms/muse-room/events?after=<seq-500>&limit=100"`
paged to ~500 events, then classify by the same prefix/chatter rules in §1b.
Expected result per this model: chatter 25–35%, median chatter event < 100 B,
median substantive event 400–700 B.

## 2. Headroom arithmetic — the 10,000-event ceiling

Baseline: `10,000 / 6.5 = 1,538` claim lifecycles per room lifetime.

Current runway (watermark `eventSeq: 7771` at 2026-10-09T03:17:51Z):
`10,000 − 7,771 = 2,229` events left → **`2,229 / 6.5 ≈ 343` lifecycles** at
current composition.

### (a) Batching PROGRESS

Per-commit PROGRESS (1–2/lifecycle in the model) collapses to ≤1 per heartbeat
window (the playbook already mandates this; this is the enforcement dividend).

- Low (1.5 → 1.0, one window per lifecycle): `6.5 − 0.5 = 6.0` →
  `10,000 / 6.0 = 1,667` lifecycles (**+129, +8%**).
- High (2.0 → 1.0, busier lanes): `6.5 − 1.0 = 5.5` →
  `10,000 / 5.5 = 1,818` lifecycles (**+280, +18%**).
- Multi-window lifecycles keep ~1 PROGRESS per window; savings scale with
  commits-per-window, not windows.

### (b) Structured DONE receipts

Event-count effect is near-zero (still 1 event) — the win is indirect plus
bytes:

- Indirect: structured receipts (claim id, head SHA, test evidence, PR link —
  `RECEIPT-SCHEMA.md` v1) eliminate the "what was the SHA / where's the PR?"
  clarification ASK. Assumption: 1 in 5 DONEs triggers one follow-up ASK =
  **0.2 events/lifecycle** saved → `6.5 − 0.2 = 6.3` →
  `10,000 / 6.3 = 1,587` lifecycles (**+49, +3%**).
- Byte effect (the big one — §2c): receipt-schema calibration on real DONEs:
  D2 1774→660 B (**63% smaller**), D3 1236→691 B (**44%**), D4 1050→794 B
  (**24%**), D5 670→525 B (**22%**); D1 332→456 B (tiny receipts gain ~124 B
  of structure — acceptable). The 2048-byte cap kills the long tail (board
  substantive p90 = 1,557 B; DONE p90 ≈ 985 B → ~700 B typical).

### 2c. The byte budget binds first (key finding)

The 10/7 incident: projection hit the **4 MiB cap** — writes rejected 409
(resolved by PR #1781; post-fix cap not published, 4 MiB used as the
pre-fix reference).

- At the measured substantive median (575 B/event):
  `4,194,304 / 575 ≈ 7,294` events → `7,294 / 6.5 ≈ 1,122` lifecycles.
- **The byte cap binds at ~1,122 lifecycles, before the event-count cap at
  1,538.** Chatter is cheap in events but the substantive tail is expensive
  in bytes — DONE/REVIEW prose is what hit the wall on 10/7, not HELLOs.

### Combined (a-high + b + HELLO/ACK coalescing)

- (c) HELLO/ACK 0.8 → 0.2 (folded into heartbeats): −0.6 events/lifecycle.
- Total: `6.5 − 1.0 − 0.2 − 0.6 = 4.7` events/lifecycle →
  `10,000 / 4.7 ≈ 2,128` lifecycles (**+590, +38%** on the event budget).
- Byte side: median event ~575 B → ~500 B (tail cut); byte cap binds at
  `4,194,304 / 500 ≈ 8,388` events → `8,388 / 4.7 ≈ 1,784` lifecycles
  (**+59%** byte runway vs 1,122). Bytes remain the binding constraint —
  which is why (b) outranks (a) on total-lifetime value despite (a)'s larger
  event-count win.

## 3. Ranked recommendations

1. **Enforce PROGRESS batching (one per heartbeat window, no per-commit
   pings).** Biggest event-count lever: **+8–18% lifecycles (+129–280)**.
   The playbook already specifies it — this is an enforcement gap, not a
   design gap. Zero information loss: the heartbeat carries the same status.
2. **Require structured DONE receipts (RECEIPT-SCHEMA v1, ≤2048 B).**
   Small event-count win (**+3%, +49 lifecycles** via killed clarification
   ASKs) but the largest *lifetime* win: cuts the byte tail 24–63% on real
   DONEs and pushes the byte-cap binding point from ~1,122 → ~1,784
   lifecycles (**+59% byte runway**). This is the 10/7-write-block fix class.
3. **Coalesce HELLO/ACK into heartbeats.** **+10% (+157 lifecycles)**,
   near-zero information loss — ACKs are pure overhead.
4. **Do not touch ASK / REVIEW / HANDOFF.** They are 1.2 of 6.5 events and
   carry the coordination value (decisions, findings, state transfer).
   Squeezing them saves events at the cost of the thing the room is for.

## 4. Gaps and open questions

- Live-room empirical classification (§1c is a model): needs the verification
  command in §1c run with an enrolled identity.
- Post-#1781 projection cap is unpublished — byte arithmetic uses the pre-fix
  4 MiB as reference; re-run §2c with the live cap when known.
- Burn rate (events/day) not measured here — two watermark reads a day apart
  give it; at 7,771/10,000 the room is at **77.7% of its lifetime event
  budget** regardless of rate.
- Median room-message bytes assumed from board comments (conservative —
  room messages skew smaller, so byte headroom is likely better than §2c).

## 5. Reproduce

```sh
cd ~/workspace/pr-wave500-coord-cost   # branch wave500/coord-cost, do not switch
# sample: last 500 #266 comments (git-ignored scratch)
gh api repos/Uuriko/project-room/issues/266/comments --paginate \
  -q '.[] | {id, created_at, author: .user.login, body}' > .tmp/board-comments.jsonl
# classification: prefix regex + <200B unstructured / pure-ACK heuristic (§1b)
```

Done-checklist: deleted nothing (doc is additive); did not check: live-room
empirical sample (credential boundary, §1a), post-#1781 byte cap, burn rate.
