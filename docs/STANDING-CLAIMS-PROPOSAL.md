# Standing Claims — Protocol Amendment Proposal

**Wave:** WAVE-500 (coordination-overhead), worker 7/17.
**Status:** proposal, docs-only. No server changes. **Design, not implementation.**
**Target doc:** `docs/WORK-CLAIMS.md` (the live claim-state contract).
Not `docs/ROOM-PROTOCOL.md` — per `docs/ROOM-PROTOCOL-SCALE.md`, that file is
the frozen v0 historical record and is not modified; scale amendments land on
WORK-CLAIMS.md / ROOM-COORDINATION.md. This proposal follows that convention.

**Related (not duplicated):**
- `wave500-design/claim-granularity.md` (wave500-protocol worktree): small-claim
  sizing, namespaces, coordinator ≤ 10 live claims, ≤ 2 spine events/agent/task.
- `wave500-design/scale-math.md` + `docs/ROOM-PROTOCOL-SCALE.md`: event budget is
  the binding constraint (~6.5 events/claim lifecycle; ~3,250/wave today).
- `docs/BATCH-DISPATCH-SPEC.md` (this branch, worker 4/17): spawn-payload
  factorization + structured receipts for *dispatch*. This proposal's task
  receipts are deliberately shaped to be compatible with the batch-dispatch
  receipt schema so a standing claim can carry a batch envelope's tasks.

## (a) The problem, with numbers

Today, every task needs its own board claim: create → claim → work →
renew → settle (done/released). The standing measurement, cited across the
WAVE-500 design set, is **~6.5 room events per claim lifecycle**:

- create + `claim.acquired` board cards: ~2
- state updates + progress notes during work: ~1–2
- renewal heartbeat(s): ~1
- PR link / CI / settle (`done`/`released`): ~1–1.5

The room has a **10,000-event lifetime budget**, and the server starts refusing
non-owner board writes at 90% consumed (WORK-CLAIMS.md "Event budget").

| Scale | Tasks/wave | Events/wave (per-task claims) | Share of 10k budget |
|---|---|---|---|
| 100-task wave | 100 | 100 × 6.5 = **650** | 6.5% |
| 500 agents × 5 tasks (typical wave) | 2,500 | 2,500 × 6.5 = **16,250** | **162% — over budget; the wave cannot run** |
| 500 agents × 10 tasks (heavy wave) | 5,000 | 5,000 × 6.5 = **32,500** | 325% |

The wave500-protocol worktree's own math (`scale-math.md`) puts current
discipline at ~3,250 events/wave ≈ **3 waves before the room dies**. Board
slots (10 shards × 200 = 2,000) are comfortable; per-member caps bind only on
abuse. **The binding constraint is the claim-lifecycle event burn.**

The `claim-granularity.md` sibling proposal keeps claims small (one reviewable
unit) and caps coordinators at 10 live claims — correct direction, but it does
not remove the per-task lifecycle: at 500 agents each doing many small tasks,
the 6.5-event toll is charged per task regardless. The toll itself must be
amortized.

## (b) The amendment: lane-level standing claims

**Idea:** claim once per coordinator lane per wave; heartbeat instead of
re-claiming; record task completion as structured receipts *linked to the lane
claim*, not as new board claims.

### New claim kind: `standing`

`kind` today is `work` (default), `land`, `deploy`. Add `kind: "standing"`:

- Held by a **coordinator lane** (one lane claim per lane per wave), not by a
  worker doing one task.
- Carries a **task manifest**: an ordered list of the tasks the lane will
  execute this wave. Each manifest entry: `{ taskId, brief?, doneCondition,
  files?, status }`.
- Manifest entries are **not board claims**. They consume no board slots, get
  no claim lifecycle, and post no per-task room events.
- Task completion is recorded as **structured receipts** attached to the
  standing claim (see below) — one receipt per task, queryable, auditable.

### Heartbeats

The lane renews the standing claim on a cadence (`heartbeatEvery`, default
30 min; `leaseHours` still bounds the outer lease, default 24h):

- A heartbeat is `POST .../renew` with `{ heartbeat: true, seq, taskReceipts?,
  progressNote? }`. It extends the lease and appends any new task receipts.
- Cost: **at most one room event per 60 seconds** under the existing "Event
  budget" rule — and heartbeats with no new public content can coalesce to
  zero new events (the write is recorded; the event is optional). A full
  8-hour wave at 30-min cadence costs ≤ 16 events/lane, often fewer.
- `seq` is a heartbeat sequence number: the server (or readers) reject
  out-of-order heartbeats, catching stale/replayed coordination state.

### Task receipts

A task completes with a structured receipt stored on the standing claim —
compatible with the `BATCH-DISPATCH-SPEC.md` §6 receipt shape, extended with
the lane link:

```jsonc
{
  "standingClaimId": "w500-guild-docs-001",
  "taskId": "w500-guild-docs-001-014",
  "status": "done | error | timeout | cancelled",
  "summary": "≤ 280 chars, human-readable outcome",
  "filesChanged": ["docs/X.md"],
  "evidenceRefs": ["sha256:<64 hex>", "https://..."],
  "testsRun": "node --test tests/x.test.js → 14/14 pass",
  "openQuestions": []
}
```

Receipts are appended to the claim (history + a `receipts` view on read),
batched into the next heartbeat. Recording N receipts in one heartbeat costs
**~1 event total**, not N lifecycles.

## (c) State transitions + protocol text (diff form)

The standing kind reuses the existing state machine. New transitions are
minimal:

```
kind: standing
  unclaimed ──claim──▶ claimed ──update──▶ in_progress ──heartbeat──▶ in_progress
  in_progress ──update──▶ done | blocked | claimed(pause)
  blocked ──update──▶ in_progress | claimed
  any-active ──heartbeat-timeout (3 missed heartbeats OR lease lapse)──▶ released (unclaimed)

manifest entry status (internal to the claim, not board state):
  queued → working → done | error | timeout | cancelled
  release-on-timeout resets working → queued (done/error receipts persist)
```

### Proposed diff on `docs/WORK-CLAIMS.md`

```diff
 ## Create

 `POST /api/rooms/{roomId}/work-claims`

 ```json
-{ "id": "lane-a", "title": "Lane A", "reviewPolicy": "self_attested", "note": "optional", "tags": ["migration"], "files": ["server/a.mjs"], "dependsOn": ["lane-b"], "pullRequest": "https://github.com/Uuriko/project-room/pull/7" }
+{ "id": "lane-a", "title": "Lane A", "reviewPolicy": "self_attested", "note": "optional", "tags": ["migration"], "files": ["server/a.mjs"], "dependsOn": ["lane-b"], "pullRequest": "https://github.com/Uuriko/project-room/pull/7", "kind": "standing", "manifest": [ ... ], "heartbeatEvery": 30 }
 ```
 
 `id` matches `[A-Za-z0-9_-]{1,128}`. Only `id` is required. A duplicate id is
 **409** `work_claim_exists`. The item starts `unclaimed`.
 
+`kind` is `work` (the default), `land`, `deploy`, or `standing`. A `standing`
+claim is a lane-level envelope for one coordinator lane for one wave. It
+carries `manifest`, an ordered array (max 200 entries) of task entries
+`{ "taskId", "brief"?, "doneCondition", "files"?, "status"? }`. `taskId`
+matches the same pattern as claim ids and is unique within the claim.
+Manifest entries are not board claims: they consume no board slots and have
+no claim lifecycle. `heartbeatEvery` (minutes, 5..240, default 30) sets the
+expected heartbeat cadence; it must be < `leaseHours` × 60.
+
 ## Renew
 
 `POST .../renew` with `{ "progressMessageId"?, "note"?, "leaseHours"? }`.
 
 Only the holder can renew, and only while the claim is active and the lease
 has not lapsed. ...
+
+### Standing-claim heartbeats
+
+`POST .../renew` on a `kind: "standing"` claim accepts
+`{ "heartbeat": true, "seq": <n>, "taskReceipts"?: [...], "note"? }`.
+`seq` must be exactly one above the last recorded heartbeat sequence
+(first heartbeat is `seq: 1`); anything else is **422**
+`invalid_claim_input` naming `seq`. The heartbeat extends the lease, records
+each receipt in `taskReceipts` (see "Task receipts" below), and adds at most
+one room event per 60 seconds under the existing event-budget rule.
+Heartbeats may be coalesced to zero new room events when there is no new
+public content; the write is always recorded on the claim.
+
+Missing 3 consecutive heartbeats (or `leaseHours` elapsing, whichever is
+first) auto-releases the standing claim: state → `unclaimed`, owner/lease
+cleared, manifest entry statuses `working` → `queued`; recorded receipts
+persist and are visible on re-claim. The former holder is woken once with
+reason `lease_expired`. This is the same release path as an ordinary lease
+lapse; it adds no new events beyond what the existing path already posts.
+
+## Task receipts
+
+A `kind: "standing"` claim accepts task receipts:
+
+```jsonc
+{ "taskId": "w500-guild-docs-001-014", "status": "done | error | timeout | cancelled",
+  "summary": "≤ 280 chars", "filesChanged"?: ["docs/X.md"],
+  "evidenceRefs"?: ["sha256:<64 hex>"], "testsRun"?: "...", "openQuestions"?: [] }
+```
+
+`taskId` must name a manifest entry in `queued` or `working` status;
+otherwise **422** `invalid_claim_input`. Recording a receipt moves that
+entry to the receipt's `status`. Receipts are stored on the claim and
+returned by `GET .../work-claims/{claimId}` and by the receipts read;
+`contentTrust` marks them the same as any member-written content. Receipts
+recorded with no receipt for the same `taskId` twice conflict: the second
+record for a terminal task is **409** `work_claim_conflict` (idempotent
+re-submit of an identical receipt is a no-op, matching the review-note
+dedupe convention).
+
 ## Caps
 
 Open claims are everything that is not `done`.
 
 - Per room, default **200**. ...
 - Per member, default **20** claims that member holds in `claimed`,
   `in_progress`, or `blocked`. The next claim is **409**
   `too_many_open_claims`.
+
+A `standing` claim counts **one** against the per-member and per-room open
+counts regardless of manifest size; the manifest size cap (200) and the
+file-lease conflict check (below) bound its scope. This is the whole point:
+N tasks ride one open-claim slot.
 
 ## Leases
 ...
+
+## Manifest scope (the bound)
+
+The manifest is the claim's scope. On claim and on any manifest update, the
+file paths declared across manifest entries run through the same exclusive
+file-lease check as ordinary claim `files`. Overlap with a live claim on an
+unlabelled path is **409** `file_lease_conflict` naming holder, files and
+`leaseExpiresAt`, exactly as today. A standing claim may only record
+receipts for tasks inside its manifest; expanding scope requires a manifest
+update (one history entry, at most one room event), so scope creep stays
+visible and checkable.
```

No changes to `done` semantics, review policies, `dependsOn`, PR settlement,
or the provenance/premise-invalid machinery — a standing claim can use all of
them (e.g. `reviewPolicy: "distinct_member"` on a lane claim for waves that
want lane-level verification).

## (d) Backward compatibility

- **Per-task claims keep working, unchanged.** `kind` defaults to `work`; every
  existing client, skill, SDK helper, and the MCP tools see the exact same
  API and states. Unknown `kind` values are **422** `invalid_claim_input`
  (strict, not silent-ignore — a typo must not become an unscoped envelope).
- **Opt-in, lane by lane.** A lane posts `kind: "standing"` at create; a wave
  can run standing claims and per-task claims side by side. Readers that don't
  understand `standing` see a normal claim with extra fields (list filters:
  add optional `?kind=`; absence of the filter returns everything, as today).
- **Receipts degrade gracefully:** a client that ignores `taskReceipts` still
  reads `state`, `note`, `history` — the standing claim's public story is the
  heartbeat `note`.
- **Reputation ledger** (`server/claim-reputation.mjs` — protocol-level note
  only, no server change here): propose standing-claim settlement as
  `claim_completed` per manifest task completed, capped at +25 per standing
  claim (prevents receipt-spam score farming); clean early release +1;
  heartbeat-timeout lapse posts one `claim_flaked` (−6) against the lane
  claim and returns incomplete tasks to the pool — never per-task flake
  penalties, since the lane, not the task, failed liveness. (Exact scoring
  is a follow-up decision; the principle is: reward throughput, punish lane
  silence, don't double-charge.)

## (e) Abuse and failure modes

| # | Mode | What happens today | Mitigation in this proposal |
|---|---|---|---|
| 1 | **Lane goes silent** (crash, timeout, abandonment) | Lease lapses; tasks never started stay invisible until someone notices | Heartbeat timeout (3 missed) auto-releases; manifest `working`→`queued`; **recorded receipts persist**, so a new lane re-claims and *reconciles receipts before touching work*. Same wake (`lease_expired`) as ordinary lapse. |
| 2 | **Lane over-claims scope** ("I'll take the whole wave") | Hoarding surcharge (−4 per claim over 5) + per-member cap 20 | Manifest cap 200 entries; manifest runs the full file-lease conflict check at claim time; scope expansion needs a visible manifest update. The manifest **is** the bound. |
| 3 | **Stale/replayed heartbeats** hiding that work stopped | Renewal only needs to be the holder | `seq` monotonicity — out-of-order heartbeat is 422. A lane cannot fake progress by replaying an old heartbeat. |
| 4 | **Fake receipts** (lane claims tasks done without doing them) | `self_attested` completion already permits this per-task | Same exposure as today, no worse: receipts carry `evidenceRefs`/`testsRun`; waves can require `reviewPolicy: "distinct_member"` on the standing claim, and `contentTrust` marks receipts member-written. Receipt fraud is *more* auditable than today — it's all on one claim's history. |
| 5 | **Manifest as board-cap evasion** (infinite work through one slot) | N/A | Manifest cap 200; standing claim still counts 1 against the per-member 20; the ≤10-live-claims coordinator rule from `claim-granularity.md` still applies. |
| 6 | **Heartbeat stampede** (all lanes heartbeat at once, event spike) | N/A (no heartbeats exist) | Heartbeats jitter: `heartbeatEvery` ± 20% randomized per lane; heartbeats coalesce to zero events without new public content; ≤ 1 event/60s rule unchanged. |
| 7 | **Partial-lane duplicate work after timeout** (see riskiest mode below) | Lease lapse re-offers the task; duplicate work possible today too | Re-claiming lane MUST reconcile recorded receipts first (protocol SHOULD, not MUST in v0 — see risk); idempotent task briefs (per BATCH-DISPATCH-SPEC §7) make re-execution converge. |

### The riskiest failure mode: silent-lane handoff → duplicated task execution

Mode 7 is the one this design can make *worse* than per-task claims. Under
per-task claims, a lapsed claim re-offers exactly one task — the blast radius
is one task. Under standing claims, a timed-out lane claim releases up to 200
manifest entries at once. If the re-claiming lane skips receipt reconciliation
(a plausible failure when a wave is behind and a coordinator is rushing), it
re-executes tasks whose `done` receipts are already recorded. Consequences:

- **Wasted work** (the visible cost) — up to a full lane-wave of tasks.
- **Collisions** (the dangerous cost) — re-executed tasks re-touch files
  other lanes now lease, tripping `file_lease_conflict` cascades or, worse,
  silently re-doing settled work (docs rewritten, PRs re-opened).
- **Reputation distortion** — the second lane records `done` receipts for
  tasks the first lane already completed, double-counting throughput.

Mitigations, in order of strength:

1. **Receipt-first re-claim rule** (protocol, cheap): a lane that claims a
   released standing claim must read its receipts and mark already-terminal
   tasks before starting new work. Add to the pilot runbook; promote to a
   SHOULD in the amendment text.
2. **Server-side guard** (future, out of scope for this doc): refuse to move a
   manifest entry whose receipts already show terminal `done` back to
   `queued` without an explicit `reopen` reason — the "reopening shows
   committed state" invariant from John's failure-sequence QA plan.
3. **Idempotent task briefs** (complementary): batch-dispatch-style briefs
   written to converge on re-run, so accidental re-execution is a no-op, not
   corruption.

The residual risk after (1) is procedural non-compliance — acceptable for a
pilot, and strictly auditable since the receipts are all on the claim.

## (f) Migration path: pilot on one wave

1. **Pick one wave, one lane.** A small upcoming wave (or one guild inside
   WAVE-500's protocol work, e.g. a docs guild) runs with a single standing
   claim while sibling lanes keep per-task claims — side-by-side comparison
   on the same wave.
2. **Instrument before the pilot.** Record per-lane: room events consumed,
   board slots held, tasks completed, duplicate-work incidents,
   reconciliation time on any handoff. The success metric is the event math
   in the next section; the safety metric is zero un-reconciled re-claims.
3. **Opt-in only.** No wave is forced onto standing claims; the wave
   commander announces the pilot in the spine charter message.
4. **Promote or park.** If events/task drop ≥ 80% with no safety incidents,
   propose standing claims as the default for coordinator lanes in the next
   wave's charter template. If the duplicate-work risk materializes, the
   amendment stays opt-in and the receipt-first re-claim rule gets hardened
   first.

## Event math: standing claims vs per-task claims

### Per 100-task wave, 10 lanes × 10 tasks

**Baseline — per-task claims (100 lifecycles):**

| Step | Events |
|---|---|
| create + claim.acquired × 100 | 200 |
| in-work updates/notes (~1.5/task) × 100 | 150 |
| renewal (~1/task) × 100 | 100 |
| PR link + CI + settle (~2/task) × 100 | 200 |
| **Total** | **650** |

**Standing claims (10 lane claims, manifests of 10):**

| Step | Events |
|---|---|
| create + claim.acquired × 10 lanes | 20 |
| heartbeats: 8h wave, 30-min cadence → 16/lane, coalesced; assume 2 with public content × 10 | 20 |
| task receipts: 100 receipts batched into heartbeats (≤1 event/60s rule) | ~0 incremental |
| lane settle (done) × 10 | 10 |
| **Total** | **~50** |

**Savings per 100-task wave: 650 − 50 = ~600 events (92% reduction).**
Board slots: 100 → 10. Coordinator ≤10-live-claims rule from
`claim-granularity.md` stays satisfiable (10 lanes × 1 claim).

### At WAVE-500 scale (500 agents, 10 guilds, ~5 tasks/agent = 2,500 tasks)

- Per-task: 2,500 × 6.5 = **16,250 events** — 162% of the 10,000 lifetime
  budget. The wave cannot run under per-task claims.
- Standing (10 guild-lane claims): create/claim 20 + heartbeats ~100 +
  settle 10 ≈ **~130 events** — 1.3% of budget, ~75 such waves of headroom.
- **Savings: ~16,120 events per 2,500-task wave (99.2%).**

This composes with the `ROOM-PROTOCOL-SCALE.md` federated-guilds design:
standing claims are the natural claim primitive for a guild lane that already
speaks in rollups and heartbeats. The 95-events/wave figure there assumes
exactly this kind of lifecycle amortization; standing claims are the
mechanism that makes it real at the board layer.

### What the math does NOT claim

- Heartbeat cadence is a tuning knob: tighter cadence (5 min) × 10 lanes
  ≈ 960 events/wave — still 94% below baseline, but the 30-min default is
  the sane pilot value.
- The math assumes receipts batch cleanly into heartbeats. A lane that
  heartbeats per task re-creates the per-task cost — the pilot runbook must
  call this out (heartbeat-per-receipt is a protocol violation in spirit).
- Event counts are the standing WAVE-500 measurements (~6.5/lifecycle),
  not new instrumentation. The pilot's first job is to measure the actuals.
