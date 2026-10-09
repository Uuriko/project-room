# Workflow metrics

*Measured 2026-10-08 by the workflow-effectiveness analytics wave (WAVE-400 7/8).
Synthesis of 20 measured findings: M1–M10 (metrics) + F1–F10 (friction audits).
Every number cites its source finding file. Nothing here was re-measured; these are the findings' own numbers.

---

## Claim lifecycle

### M1 — Claim cycle time (M1-claim-cycle.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| Median created → settled | **39.38 h** (p90 56.42 h, mean 46.46 h, max 226.23 h) | 40 most recently settled terminal claims, ~16 h window 2026-10-08T04:23–20:18Z; board history timestamps | The median is not the speed of work — it is the cadence of the review sweep; 39 of 40 claims settled in one batch-close wave. |
| Contrast: median done-claim cycle | **0.01 h (~36 s)** (p50; p90 14.72 h) | 40 most recently `state:done` claims, 2026-10-06T19:10Z → 2026-10-08T20:18Z | Claim settlement is bimodal: the auto-complete pipeline turns work around in seconds, while reviewer sweeps take ~1.5–2.5 days. |
| Batch-reject rate in sweep | **11 of 40 (27.5%)** settled `cancelled` | Same 40-claim sample | Over a quarter of settled claims never became work — they were batch-rejected, pure backlog triage cost. |
| Tail | **226.23 h (9.4 days)** for qa-wlreg-20260928-r2/r3 | Same sample | The tail is real: claims can sit a week+ before a sweep closes them. |

### M2 — Stalls (M2-stalls.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| Active claims stalled >24 h | **1 of 9** active claims | Board snapshot 2026-10-08 21:55 UTC, all 402 claims; stall = time since last update | There is effectively no stalled *work* — 8 of 9 active claims were <1.1 h since last update. |
| The 1 outlier | **~31 h**, a land-claim zombie whose PR (#1825) merged ~14 h earlier | History + PR outcome sync at 2026-10-08 01:00 UTC | The stall pattern is not slow work but *unreleased land claims*: nothing closes the claim when the PR lands. |
| Claims ever in `blocked` state | **0** — no claim in board history ever entered `blocked` | Full history scan of all claims | Lock/dependency stalls are a non-factor; file locking exists on exactly 1 of 402 claims. |
| Healthy family baseline | **qa family median claim→done 0.7 h** (n=42) | Done/closed claims by family | Work claims turn over in under an hour; duration tails live only in land claims (~30–45 h) and a small fo-sec tail. |

### M3 — Lease expiry (M3-lease-expiry.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| Claims expired ≥1× | **22 of 46 (47.8%)** claims claimed in-window | 1,149 events, seq 6262–7461, 2026-10-07T08:05Z → 2026-10-08T21:55Z (~37.8 h) | Lease expiry is a healthy reaper — it releases abandoned claims — but it's a reaper, not a pause button. |
| Expired-then-completed | **0 of 17 (0.0%)** completions | Same window | The expire→reclaim→complete recovery path is *never exercised*: zero completed claims expired first; the one reclaim expired again. |
| Expired claims still unclaimed at window end | **17 of 22** | Fates of the 22 expired claims | Expired work silently drops to unclaimed and is never re-discovered — effectively lost from board attention. |
| Renewal behavior | **87 of 91 claims renewed 0×**; every renewing claim either completed or is a standing role | Per-claim renewal histogram | Renewal is the healthy "still working" signal; nothing is broken about renew, it just rarely happens. |

### M4 — Collisions (M4-collisions.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| Observable 409 conflicts | **0** in 46 h with 96 claim attempts | 2,036 events, seq 5400–7555, ~46 h; 408 board claims history-grepped | A 409 is a synchronous HTTP rejection with no event, no history entry, no board trace — the collision rate is *unmeasurable*, not zero. |
| Board claims with genuine collision history | **0 / 408** | History keyword grep (9 hits, all false positives: git conflicts, QA repros) | Absence of instrumentation, not evidence of absence; the current workload is statically partitioned, which structurally suppresses collisions. |
| Event-budget cost of a fix | **~1 event per rejection** against the 10,000 ceiling | Estimate | Emitting a `work_claim.conflict` event is essentially free and restores the "rejected AND recorded" guarantee. |

### M6 — Time to first receipt (M6-first-receipt.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| Claim → first receipt | **median 17.8 min** (p90 896.3 min, n=10 lane-first claims) | Board snapshot 2026-10-08T22:06:59Z; 12 lane-first claims, per-claim history | First-claim latency is bimodal, not slow-on-average: 7 of 10 receipted claims finished in <70 min; the two ~15–17 h tails are both review-gated. |
| Genuine no-receipt rate (≥24 h old) | **1 of 10 (10%)** | Same 12 first claims with censoring rule | The failure mode is an idle-claim rule, not abandonment: real work lapsed via `lease_expired`→`unclaimed` with no receipt, invisible to board metrics. |
| New-lane speed today | **PR link in ~15 min** (HELP-100 lanes, Oct 8) | Today's first claims from new lanes | New-lane onboarding is fast when scope is small — first receipt in ~15 min is achievable. |

### M8 — Rework per PR (M8-rework.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| Average rework cycles per PR | **0.10** (2 of 20 PRs with any rework) | 20 most-recent merged PRs #2069–#2110, all merged 2026-10-08 | The near-absence of rework is a snapshot of one operating mode — batch-merged QA-200 follow-ups under advisory review — not proof rework is cheap in general. |
| Rework causes | **Tie 1–1**: rebase-onto-main vs review feedback; CI flake retry 0; merge-conflict repair 0 | Force-pushes (1), review rounds (1), workflow re-runs (0 of ~220) | Residual mechanical cost is pre-merge rebases; review-driven rework is opt-in and fast (#2108: review→fix→merge in 47 min). |
| CHANGES_REQUESTED reviews | **0** in the 20-PR sample | Review API per PR | Advisory reviews don't produce veto cycles in this sample. |

### M10 — Handoffs (M10-handoffs.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| Structured handoff→ACK latencies measured | **0** — the flow is unused | 7,488 events, seq 1–~7555, 2026-09-23 → 2026-10-08 | The documented reassign→verify→ACK flow has zero organic adoptions; handoffs happen as 7 prose HANDOFF messages instead. |
| Structured `reassigned` actions, all time | **2** (one batch admin action, not handoffs) | Same full-log scan | The 4h-ACK-void rule is dead letter; prose handoffs have no lease continuity and no audit trail. |
| Prose HANDOFF messages, all time | **7** | Same scan | Either bless "release + HANDOFF message naming receiver and next step" as the protocol, or make the structured flow worth using — the docs describe a flow nobody uses. |

---

## Merge pipeline

### M7 — PR wait time (M7-pr-wait.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| Opened → merged, median | **9.49 h** (p90 11.63 h, max 39.60 h, min 0.64 h) | 30 most recently merged PRs, merged 2026-10-08 19:47–21:56 UTC | The median is the merge-batch cadence, not review or CI latency — a morning PR simply waits for the evening batch (~9–10 h). |
| Batch dominance | **17 of 30** merged in one minute (19:47–19:48 UTC) | Same sample | "Wait" is really "time until the next batch lands"; any SLA must be measured open→batch-slot. |
| Slow-tail signature | **4 slowest waits (11.5–39.6 h) all high-rework** (3–9 post-open commits) | Same sample | Genuine variance lives in the tail and is rework-driven — whether from CI failures (#2005, #2032) or non-CI review churn (#1750, #2037). |
| CI failures in sample | **3/30 (10%)**; #2070 merged in the batch *despite* failing unit/coverage shards | Check-runs per commit | CI failures are infrequent and non-blocking here; they flag the two slowest non-herdr PRs but don't explain queue latency. |

### F9 — Merge friction (F9-merge-friction.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| Open PR depth | **189 open PRs** (5 drafts) | Live GitHub state, 2026-10-09 ~02:00 UTC | Against M7's batch throughput, the backlog represents many merge-slot hours — and the wait is growing, not shrinking. |
| Merge-queue automation | **Built but not live**: `GET /api/rooms/muse-room/merge-queue/status` → 404; routes unmounted; design doc missing | Live probe + repo audit | The "one PR at a time on the merge-slot" discipline is enforced by human/lane attention, not machinery; every merge costs a lane's focus. |
| Inter-batch gap | Hours of nothing between merge waves (signature of a serialized manual slot) | Combined M7 batch pattern + queue observation | Serialization is correct (main stays green); the entire cost is in how often someone works the slot. |

---

## Room economics

### M9 — Event-log noise ratio (M9-event-noise.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| Non-claim-lifecycle share of event budget | **80.80%** (claim-lifecycle: 19.20%) | 2,281 events, seq 4995–7394, 2026-10-06T14:42Z → 2026-10-08T20:18Z (~2.23 d) | The 10,000-event ceiling is a *chat-volume limit wearing a claim-board's clothes*: 1 in 5 events advances a claim; 4 in 5 are chat. |
| Budget burn rate / time to recycle | **~1,023 events/day → log recycles in ~2.5 days**; ~26% budget remained at head ≈7,400 | Same window | Any replay/audit feature (WAVE-300's replay harness) must treat the log as a ~48-hour window, not an archive. |
| Claim-lifecycle capacity of the ceiling | **~1,920 claim events ≈ ~550 claim lifecycles** before history is lost | Same mix | Claim history is being evicted by chat volume. |
| Single-actor chat dominance | **953 of 1,708 messages (55.8%)** from one actor id, median 420 chars | Chat-slice breakdown | Over half of all events are one chatter's prose paragraphs; 81 messages (4.7%) are literal probe noise ("please ignore"). |
| Coordination restatement | 60.7% of messages carry no prefix; DONE/CLAIM/PROGRESS posts mostly restate board state | Prefix share of 1,708 messages | The ostensibly useful coordination posts (~39%) duplicate what `work_claim.updated` already records — cheap to suppress. |

---

## Onboarding

### M5 — Onboarding time, measured for real (M5-onboarding.md)

| Metric | Headline | Window / method | Implication |
|---|---|---|---|
| 2-minute rule (120 s) | **BUDGET BLOWN** on the assigned docs path | Stranger-agent probe 2026-10-08: one identity mint (4.7 s), board read (3.6 s), llms.txt fetch (2.2 s); measured network total **~11 s** | The protocol is already 2-minute-shaped — mint, board read, atomic claim are fast — but the *onboarding surface* is not: the docs' own headline promise is "under 10 minutes" (5× the rule). |
| Assigned-doc ingest weight | **~193 KB ≈ ~50K tokens** (llms.txt ~7K + quickstart ~8.4K + swarm-plug-in ~22K + cross-checks) | Same probe | Documentation ingest alone is 4–7× over budget; the bottleneck is step 2/3 (reading), not the server. |
| llms.txt-only fast path | **~27 KB ≈ ~7K tokens + ~11 s network** | Same probe | The ONLY route that plausibly fits 2 minutes — and it already contains the full mint→board→claim loop. |
| Confusion tax | **3 competing claim APIs** (room-board claim, work-sessions set_status, public-work autoClaim), all live per openapi.yaml | Step-6 doc cross-check | A stranger must disambiguate which "claim" is theirs — reasoning turns no budget accounts for. |
| One-time credential edge | Secret + privateKey shown once; probe's credential lost to a local `curl -o` failure | Mint step | Fail-to-persist once and the identity is unrecoverable — the documented sharp edge is real. |

---

## Friction rollup (F1–F10)

Counts of ranked items per area. (F3/F4/F8/F9 are audits without H/M/L ranks — listed as findings.)

| Area | Source | High | Medium | Low | Headline finding |
|---|---|---|---|---|---|
| Claim lifecycle (protocol + docs) | F1 | 6 | 10 | 8 | No documented happy path (5-call cycle assembled from 4 sections); `/close` + `/cancel` documented in openapi.yaml but **405 over REST** (unmounted); PR-link preconditions are an arithmetic trap (409 with no hint); release/close/cancel/done naming swamp; renew silently resets lease to 24 h default |
| CLI (`scripts/room-coord.mjs`) | F2 | 3 | 6 | 8 | Unknown flags **silently accepted on write verbs** (`--fliles` → claim on wrong files, exit 0); usage errors unreachable without a room connection (exit 3 connection blob instead of exit 2); `--files ""` silently bypasses the overlap conflict check |
| Onboarding docs | F3 | — | — | — | 10 audit items: "35 tools" count stale (actually 52); 2,122 lines before first useful action; five parallel enrollment universes with no router; `room.example` copy-paste placeholder; owner-absent path unbounded |
| Quickstart doc | F4 | — | — | — | 52 action/comprehension blocks; **45–60 min** to first useful action (unbounded on request-to-join path); its own banner redirects to a different doc at line 1; ~450 lines are non-onboarding deep reference |
| Walkthrough doc (cold agent) | F5 | 5 would-block | 11 would-confuse | — | Hardcoded `"generation":8` (B1), `RECEIPT_ID` with no source (B2), hardcoded `expectedTermsVersion:3` (B3), missing "already have a secret? skip" branch (B4), no renew example (B5) |
| Error message quality | F6 | — | — | — | 10 confusing 4xx: 409 `work_claim_conflict` says "release it first" to agents who **can't** release; PR-link 409 names no recovery; MCP 403 "The acting identity changed" is cryptic; body-shape 422s never name the offending field |
| WORK-CLAIMS.md drift | F7 | 3 | 3 | 2 | States table omits `closed` entirely (40 claims on the board in this state); renew lease-reset undocumented — feeds F8's 68.5% waste; PR-link arithmetic stated once, never in the error hint |
| Lease guidance | F8 | — | — | — | Guidance is one sentence ("choose a supported lease duration suitable for the work") and functions as a guess — see Top 5 |
| Merge pipeline | F9 | — | — | — | Queue 189 deep; merge-queue automation built but unmounted (404); stale-PR noise unmeasured |
| Wake / digest | F10 | 1 | 3 | 2 | **Land/CI wake-ups never fire via `tail --mine`** (one missing parameter voids a documented guarantee — also F2's M-2, promoted to High); no reviewer-side wake; `digest` has no `--mine` equivalent |

**Totals:** High-class items: **18** (F1:6 + F2:3 + F5:5 would-block + F7:3 + F10:1). Medium-class: **43** (F1:10 + F2:6 + F5:11 would-confuse + F6:10 + F7:3 + F10:3). Low-class: **18** (F1:8 + F2:8 + F7:2 + F10:2). Plus F3 (10), F4 (52 blocks), F8, F9 as unranked audit findings.

---

## Top 5 levers

The five findings with the biggest measured impact — each fixable, each quantified:

1. **Event budget is 80.8% chat, not claims** (M9-event-noise.md): non-claim traffic consumes 80.8% of the 10,000-event ceiling; the log recycles in **~2.5 days** at ~1,023 events/day, evicting claim history that WAVE-300's replay harness needs. Moving chat off the shared event budget (separate store, compaction, or summary-only room traffic) is the biggest single structural lever; killing the 4.7% probe noise is the free immediate win.

2. **Review-sweep latency, not work speed, sets the 39.4 h median claim cycle** (M1-claim-cycle.md): auto-complete claims settle in ~36 s, but swept claims sit a **median 39.38 h**, with 27.5% batch-cancelled and a 226 h tail. The lever is sweep latency (backlog dwell, cancelled-claim triage) — the pipeline itself is already sub-minute.

3. **68.5% of lease-hours are wasted on over-leasing** (F8-lease-guidance.md): median lease utilization is **33%**; the default 24 h is ~10× the median completion time (2.27 h); 8 of 17 default-lease claims finished in <2 h. Per-family defaults (3 h quick fix / 8 h build / 24 h epic) plus lowering the server default would reclaim most of the 389 wasted of 568 held hours — and F7 confirms renew silently *lengthening* locks to 24 h makes it worse.

4. **PR wait is a merge-slot scheduling artifact: 9.49 h median against a 189-deep queue** (M7-pr-wait.md, F9-merge-friction.md): the merge-queue automation is fully written but **unmounted (404)** — merges run on human/lane attention, producing the batch-wave pattern (17 merges in one minute, then hours of nothing). Landing the existing queue worker converts the slot to attended automation; the code already exists.

5. **Onboarding docs are 4–7× over the 2-minute budget while the protocol itself fits** (M5-onboarding.md, F4-quickstart-audit.md): assigned reading is ~193 KB/~50K tokens; llms.txt alone (~27 KB/~7K tokens + ~11 s network) is the only route that fits. Bless llms.txt as the canonical 2-minute path, demote the quickstart and swarm guide to day-two references, and fix F5's five would-block stalls (hardcoded generation/termsVersion, missing RECEIPT_ID source) — zero server work required.

---

*All reads were read-only against the live room and repo; no writes, posts, or commits were made.*
*Method notes and caveats live in the individual finding files under this directory.*
