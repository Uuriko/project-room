# Event Compaction / Archiving at Swarm Scale (WAVE-500 W4)

Status: design. No code. Companion to `docs/wave500/EVENT-BUDGET-DESIGN.md`
(W7, budgets) and `docs/wave500/ROOM-ROTATION-DESIGN.md` (W11, terminal
rotation). This doc is the continuous pressure valve between them: budgets
ration consumption, compaction reclaims it, rotation ends the room when both
fail.

## 0. Ground truth (file:line on this branch)

- `PILOT_LIMITS` (`server/store.mjs:427`): `eventsPerRoom: 1_000_000`,
  `projectionBytes: 4 * 1024 * 1024` (4 MB, not 16 MB — cap bounced
  4→16→6→4→64→4 through the G11 saga; 4 MB is current).
- Hard 409 `pilot_limit` at `server/store.mjs:3436` (sequence) and `:3443`
  (projection bytes), `:4651` / `:4787` (history import). "Cleanup" commands
  (endingAccess/Request/Help/Offer/Claim/Work/Session, `ROOM_ARCHIVED`)
  bypass the 409 (`:4649`) — the wind-down path.
- Schema (`server/store.mjs:1376-1385`): `rooms(id, sequence, projection,
  archived_at)`, `events(room_id, sequence, id, body)` with
  `PRIMARY KEY(room_id, sequence)` and `id UNIQUE`,
  `commands(room_id, actor_id, id, fingerprint, sequence)` with
  `FOREIGN KEY(room_id, sequence) REFERENCES events(room_id, sequence)`,
  `cursors(room_id, member_id, sequence)`,
  `projection_checkpoints(room_id, sequence, projection)`.
- `PRAGMA foreign_keys=ON` (`server/store.mjs:641-642`): event rows cannot be
  deleted while their `commands` rows reference them.
- Cursor contract (`store.eventsAfter`, `server/http.mjs:4818-4836`):
  `after` is the last handled sequence; `after > room.sequence` fails
  409 `cursor_ahead`; `next` advances by what was *scanned*, not returned.
  The SSE pump reads through `eventsAfter` (`server/store.mjs:5129`), so
  cursor semantics here cover both polling and streaming consumers.
- Export/import (`server/http.mjs:4197-4200`): the export renumbers the
  visible walk densely because import demands `line.sequence === i + 1`;
  import is owner-only, 8 MB cap, and *replaces* room history.
- Replay starts at the newest checkpoint and applies later events
  (`server/store.mjs:2725-2727`).
- Design law (fast-path lane): **the database is the truth, events are just
  notifications.** Claim state lives in the `work_claims` SQLite table;
  `work_claim.updated` is a thin room record (pointer + reader-visible
  state) that commits inside the claim transaction
  (`server/work-claim-events.mjs:1-12`). Same pattern for the land queue
  (`land.updated`; `land_queue` table is truth) and access requests
  (`access_requests` table is truth).

Full type list: `EVENT_TYPES` in `src/events.js:18-118`.

---

## 1. Event taxonomy

Three classes, keyed to the design law. The deciding question is not "is
this event important" but "if this row vanished, what is the *second*
source of truth, and is it complete?"

### Class A — Summarizable (state-derivable; the table/projection is truth)

N events collapse to 1 summary event per compaction unit. The summary
carries the current state plus enough history for a reader to understand
the trajectory (last transition, counts, terminal outcome).

| Type(s) | Unit | What the summary keeps |
|---|---|---|
| `work_claim.updated` | per claim id | latest claimState, actor, at; count of transitions compacted; last terminal transition |
| `claim.renewed` | per claim id | last renewal (actor, at); count of renewals compacted |
| `message.reaction_set` | per message id | folded reaction counts (current emoji totals) |
| `message.edited` | per message id | latest body (intermediate bodies dropped) |
| `work.accepted/started/blocked/blocker_resolved/completed/superseded`, `work.handoff_recorded`, `work.halt_cleared` | per work item id | terminal state + transition timeline compressed to (from→to, actor, at) per step, not full bodies |
| `session.started/status_changed/stop_requested/stopped` | per session id | latest terminal state; session tables are truth |
| `land.updated` | per PR | latest land state; `land_queue` table is truth |
| `capabilities.advertised` | per member id | latest advertisement |
| `access.requested` | per member id | latest open request state; `access_requests` table is truth (the *decision* lands as `member.access_changed` — Class B) |
| `member.status_updated`, `notifications.preferences_set`, `member.mute_set`, `member.public_name_set` | per member id | current value (projection already holds it) |
| `channel.renamed` | per channel id | current name |
| `work.help_updated`, `help.offer_opened/updated` | per item/offer | latest state; help tables are truth |

### Class B — Load-bearing (retain verbatim, never summarized away)

If the row vanished, no second source could reconstruct the *authorization
or provenance* it carries. The Round-2 #110 comment in `store.mjs` is
explicit: "the event log is the audit log — every mutation records
actorId + at, so 'who did what when' is a filtered read, not a new
table." Compaction must not hollow out the audit log.

- Membership authority: `member.added`, `member.joined_via_invitation`,
  `member.access_changed`, `ownership.transferred`. This is the access
  graph. Losing who-let-whom-in is a security incident, not a storage
  optimization.
- Room lifecycle: `room.created` (genesis; replay anchor), `room.archived`,
  `room.history_visibility_set`, `room.policy_set` and the other
  `room.*_set` policy events (the policy *at the time* an action was taken
  is what an audit needs — current policy is not a substitute).
- Money / receipts / provenance: `bond.proposed/activated/revoked`,
  `verification.recorded`, `owner.decision_recorded`, `decision.recorded`,
  `receipt.evidence_withdrawn`, `referral.completed`. Authorizations must
  replay verbatim.
- Audit-of-audit: `room.exported` (PRIV-2: the audit record of who took
  data out must be appended; deleting export audit records is a compliance
  hole), `message.redacted` (the proof that a removal happened and who
  ordered it).

### Class C — Droppable after summarization

These rows can be *deleted outright* once their aggregate is folded into
the unit's summary event. No per-row archive is needed beyond the count;
the summary is the record.

- `claim.renewed` rows older than the latest per claim (heartbeat churn).
- `message.reaction_set` rows (folded counts survive in the summary).
- Intermediate `message.edited` bodies (latest body survives).
- Superseded `capabilities.advertised` / preference / mute / status rows.
- `commands` rows whose event row is compacted (idempotency keys — see §4).

Note the asymmetry: Class A keeps one summary *event* per unit in the
hot log; Class C deletes rows whose content is fully absorbed by that
summary. A `claim.renewed` burst of 200 heartbeats becomes one summary
event + zero raw rows.

---

## 2. Compaction algorithm

### 2.1 Trigger: watermarks

OR-gate over the two ceilings, mirroring the rotation doc's approach:

| Watermark | Event budget (seq / 1M) | Projection (bytes / 4MB) |
|---|---|---|
| COMPACT | 70% (700,000) | 70% (2.8 MB) |

Who checks: the same server-side watch job the rotation doc proposes
(once per minute, single-writer via a job-claim row). A single job
evaluates both watermark tables — budget, compaction, rotation — so the
three mechanisms never disagree about room state.

Why 70% and not lower: compaction is expensive (full-window scan,
archive write, delete) and each pass consumes head sequences for its
summary events. Running it at 50% wastes budget on summaries; at 70% a
single pass that reclaims ~30-40% of the log buys the room a second
lifetime. Compaction also runs on-demand via an owner command
(`compaction.run`, owner-only, rate-limited) for rooms with known-hot
namespaces.

### 2.2 Where summaries live

**In the log, as real events.** Each pass appends:

1. One `compaction.summary` event *per compaction unit* (per claim, per
   message, per session…), carrying `{ unit, type, summary, compactedCount,
   windowStart, windowEnd }`.
2. One `compaction.window` manifest event per pass: `{ compactionId,
   windowStart, windowEnd, units, rawEvents, summaryEvents,
   reclaimedBytes }`.

Because summaries are ordinary appended events with fresh sequences,
they flow through SSE, `eventsAfter`, export, and replay with zero
special-casing. The projection reducer treats `compaction.*` events as
**state-neutral** (they describe already-applied state; applying them
twice must be a no-op) — this is what makes checkpoint interaction safe
(§4).

Mapping state lives in a new table (not in the log):

```sql
CREATE TABLE event_compactions (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  id TEXT PRIMARY KEY,                 -- compactionId, also the idempotency key
  window_start INTEGER NOT NULL,       -- first compacted sequence
  window_end INTEGER NOT NULL,         -- last compacted sequence (the gap)
  summary_head INTEGER NOT NULL,       -- sequence of the manifest event
  raw_events INTEGER NOT NULL,         -- rows moved to archive
  summary_events INTEGER NOT NULL,     -- summary events appended
  reclaimed_bytes INTEGER NOT NULL,
  namespace TEXT,                      -- for budget credit (§2.5)
  state TEXT NOT NULL,                 -- prepared → summaries_appended → archived → done
  created_at INTEGER NOT NULL
);
CREATE TABLE events_archive (
  room_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  id TEXT NOT NULL, body TEXT NOT NULL,
  compaction_id TEXT NOT NULL REFERENCES event_compactions(id),
  PRIMARY KEY(room_id, sequence)
);
```

The archive is cold storage for audit/forensics (owner exportable on
request). Hot paths never read it.

### 2.3 Step-by-step pass

Precondition: job-claim acquired (first claimant wins; others stand down).

1. **Freeze the window.** Read `room.sequence` as `S`. Choose
   `horizon = S - HEADROOM` where `HEADROOM = 50,000` sequences (and never
   less than 7 days of wall-clock — see §5). The window is
   `[compacted_up_to + 1, horizon]`, where `compacted_up_to` is the
   previous pass's `window_end` (0 on first pass). Nothing in the
   headroom is ever touched: live consumers, dedupe windows, and the
   budget-low wind-down all operate there.
2. **Classify.** Scan the window once, grouping rows by (class, unit):
   Class B rows are skipped (stay in the log, verbatim, forever).
   Class A rows group by unit; Class C rows attach to their unit's
   aggregate.
3. **Build summaries** in memory: one `compaction.summary` event per
   unit + the `compaction.window` manifest. Summaries are small
   (current state + counts + last transition), bounded by a per-summary
   byte cap — a pathological unit (10k renewals) summarizes to the same
   ~500 bytes as a quiet one.
4. **Append summaries through the normal command pipeline** as system
   events (same serialization as every other write, so the 409 checks,
   projection application, and SSE broadcast all behave identically).
   Record `summary_head`. **Compaction summary appends are classified as
   cleanup commands** (alongside the `ending*` set at `store.mjs:4649`)
   so a pass can land even when the room is at 100% budget — compaction
   *frees* budget; refusing to let it write at exhaustion would be a
   deadlock.
5. **Checkpoint, then delete.** Write a fresh `projection_checkpoints`
   row at `summary_head` (projection is unchanged by state-neutral
   summaries, so this is just a sequence bump of the checkpoint). Then,
   in one transaction: `INSERT INTO events_archive SELECT …` for the
   window's Class A/C rows, `DELETE` those rows from `events`, `DELETE`
   their `commands` rows (FK requirement), and mark the compaction
   `done`. Verify counts before commit (rows archived == rows deleted);
   any mismatch aborts the pass (fail-closed, retryable).
6. **Clamp cursors** (§3) and record the compaction row.

Crash safety: the `event_compactions.state` column makes the pass
idempotent. If the process dies after step 4, the manifest event is in
the log and the pass retries: summaries are content-addressed per
`(compactionId, unit)`, so re-appending is a no-op (duplicate `id`
rejected by the `UNIQUE` constraint, same as any retried command).

**Never renumber.** Sequences are append-only and permanent. A compacted
window becomes a *gap* in the log. `eventsAfter` queries
`sequence > ?`, so gaps are transparent to reads; the export path
already renumbers densely (`http.mjs:4197-4200`), so exports stay
importable. Renumbering would invalidate every held cursor, every
`Last-Event-ID`, every member `cursors` row, and the checkpoint
sequence — it is the one thing compaction must never do.

### 2.4 What it costs

Each pass consumes `(#units + 1)` head sequences for summaries. At
swarm scale the win is enormous: the measured ~6.5 events per claim
lifecycle (EVENT-BUDGET-DESIGN) are dominated by renewals and status
churn — a 200-renewal claim collapses to 1 summary + 1 amortized
manifest row. Net budget effect of a pass is strongly positive past a
few hundred compacted units.

### 2.5 Budget interaction

Sequence consumption is what the W7 allocator meters. Compaction
*reclaims* it: the pass records `reclaimed_bytes` and
`reclaimed_sequences = raw_events - summary_events` per namespace in
the compaction row, and the allocator credits the namespace's remaining
budget (floor accounting, not a loan — reclaimed budget is real
headroom). This closes the loop: budgets ration, compaction recycles,
rotation retires.

---

## 3. Cursor survival (the hard part)

### 3.1 The invariant

**Sequences are never reused, never renumbered, never shifted.**
`room.sequence` is monotonic across compactions. A cursor is a promise
— "I have handled everything through N" — and that promise survives
compaction because N still means the same thing after the pass. What
changes is that some sequences in `(0, N]` no longer have rows. The
design problem is not remapping cursors; it is *telling the consumer
that the history under its cursor changed*.

### 3.2 The discontinuity contract

`eventsAfter(token, roomId, after, limit)` gains one envelope field:

```json
{
  "events": [ … ],
  "next": 812040,
  "hasMore": true,
  "compacted": { "upTo": 700000, "window": { "id": "cmp-…", "manifest": 812001 } }
}
```

- `compacted` is present **iff `after < room.compacted_up_to`**, i.e. the
  caller's cursor predates (or sits inside) a compacted window.
- The `events` array still returns everything with
  `sequence > after` (post-gap rows + the pass's summary events, which
  sit at the head of the log — the consumer *does* see the summaries).
- **Consumer contract:** if `compacted` is present, the caller MUST NOT
  treat the page as a clean delta. It must refresh any state it derived
  from the compacted range from a snapshot source (projection, claim
  tables, or the summary events) and then advance its cursor to `next`.
  A consumer that ignores `compacted` and just advances will silently
  miss history — this is documented as a protocol violation, and the
  server cannot prevent it, only announce it.

This is deliberately *not* a sequence-mapping table (which would be one
row per compacted event — the same size as the log it replaces) and
*not* epoch markers with renumbering (which would break every held
cursor and the export contract). Gaps + explicit discontinuity notices
are the only scheme where old cursors stay *valid* (they still order
correctly) while the information loss is announced.

### 3.3 SSE streams

The SSE pump (`stream()` in `http.mjs`, backed by `eventsAfter`) sends a
`compaction.notice` event when the stream's `after` predates
`compacted_up_to`:

```
event: compaction.notice
data: {"upTo":700000,"manifest":812001,"resync":"snapshot"}
```

Client rule, same as polling: on `compaction.notice`, drop derived
state for the compacted range, re-pull the snapshot endpoints
(`roomContext`, claim board reads — the database is the truth), then
resume the stream from the notice's sequence. The existing 409
`cursor_ahead` path stays as the backstop for cursors that are
nonsensical (beyond `room.sequence`), distinct from cursors that are
merely stale (below `compacted_up_to`).

### 3.4 Server-held member cursors

The `cursors` table (`server/store.mjs:1385`, used by notifications and
the per-member feed) is server state, so the server repairs it directly:
at the end of each pass, `UPDATE cursors SET sequence =
max(sequence, <window_end>) WHERE room_id=?`. No member's feed cursor
is left dangling inside a gap. Members whose cursor was clamped get the
`compacted` envelope on their next feed read (the clamp is recorded in
the compaction row's affected-member count for observability).

### 3.5 Export / import

- Export walks the log with the existing dense renumbering; gaps vanish,
  summary events appear in sequence order, and the manifest event makes
  the export self-describing ("sequences 1–700,000 compacted into 412
  summaries on <date>"). Exports stay importable: `importEvents` demands
  dense `i+1` sequences and the export already produces them.
- Import *replaces* history, so export→import is itself a defragmenting
  compaction: the reimported room is dense, summary events become
  ordinary history, and `compacted_up_to` resets. Document this as the
  supported manual defrag path for owners.
- The `room.exported` audit event (Class B) is appended *after* export
  materialization (PRIV-2, `http.mjs`); it is never part of a compacted
  window because it always lands in the headroom.

### 3.6 What changes for tests

- No test may assert `COUNT(*) == room.sequence` or dense sequences on a
  live room; density is asserted only on import files and post-import
  rooms (the existing export/import round-trip tests are unaffected).
- New contract tests: `eventsAfter` with `after` inside a compacted gap
  returns post-gap rows + the `compacted` envelope; SSE emits
  `compaction.notice`; member cursors clamp; replay from a post-compaction
  checkpoint applies summaries as no-ops.

---

## 4. Safety: what can go wrong

| Failure | Mitigation |
|---|---|
| **Compaction races a write.** A member appends while the pass deletes. | The window is frozen at pass start (`horizon = S - HEADROOM`); appends land above `S`, deletes happen below `horizon` — disjoint ranges. Summary appends go through the normal serialized command pipeline. The archive+delete step is one transaction. |
| **Compaction races compaction.** Two job instances pick the same room. | Job-claim row (first claimant wins), same pattern as the rotation claim. The `event_compactions.id` doubles as an idempotency key; a retried pass re-appends nothing (UNIQUE `id` on events). |
| **Crash between summary-append and delete.** Manifest in log, raw rows still present. | `event_compactions.state` marks the pass incomplete; retry is idempotent (content-addressed summaries, count-verified delete). Worst case the room has both summaries and raw rows — correct, just unreclaimed. |
| **Consumer holds a pre-compaction cursor.** | §3: gaps are transparent to `sequence > ?` reads; the `compacted` envelope / `compaction.notice` announces the discontinuity; server-held `cursors` rows are clamped. Consumers that ignore the notice violate the documented contract. |
| **Replay breaks.** A checkpoint sits below deleted rows; replay would reference missing sequences. | The pass writes a fresh `projection_checkpoints` row at `summary_head` *before* deleting, and summary events are state-neutral in the reducer. Replay always starts at the newest checkpoint, which is always ≥ the compaction head. Compaction never deletes at or above the newest checkpoint. |
| **Idempotency keys lost.** `commands` rows for compacted events are deleted; a retried old command would re-execute instead of deduping. | Accepted and bounded: dedupe only matters inside the retry window, and the headroom (50k seq / 7 days, §5) is never compacted. A client retrying a week-old command gets a fresh execution — the same behavior as a room restored from backup today. Documented, not silent. |
| **FK violation on delete.** `PRAGMA foreign_keys=ON`. | `commands` rows are deleted in the *same transaction* as their event rows. The count-verification step fails the pass closed if they diverge. |
| **Compaction at 100% budget deadlocks.** The room is 409ing; compaction needs to append summaries to proceed. | Compaction summary appends are classified as cleanup commands (`store.mjs:4649` pattern), bypassing the budget 409 exactly like `ROOM_ARCHIVED` does. Compaction is the escape hatch from exhaustion, not another victim of it. |
| **Archive write fails / disk pressure.** | Archive insert and source delete are one transaction — a failed archive aborts the delete. The pass is retryable; the room keeps running on the uncompacted log. |
| **Summary lies.** A bug in summarization drops state the DB doesn't hold (violating the design law). | Summaries are built *only* from Class A types, where the table/projection is declared truth (§1). The pass asserts per-unit: `summary.state == <table/projection state>` before archiving the raw rows — a mismatch fails the unit closed (rows stay, unit is skipped, alert emitted). |
| **Projection-byte ceiling hit by summaries.** | Per-summary byte cap + the manifest records `reclaimed_bytes`; a pass that would not go net-negative on projection bytes aborts with an alert (the room needs rotation, not compaction). |

---

## 5. What you would NOT compact and why

1. **`message.posted` / `dm.posted` bodies.** Chat content is the product
   and the history-visibility promise (`room.history_visibility_set` is
   Class B for a reason). Silently deleting what people said — even old
   messages — breaks user trust and the `since_join` visibility contract
   in ways no summary can repair. Message *retention* is a separate
   product decision with its own consent story; it is not compaction.
2. **Membership authority events** (`member.added`,
   `member.joined_via_invitation`, `member.access_changed`,
   `ownership.transferred`). The access graph must be reconstructible
   end-to-end. These rows are tiny and rare; compacting them saves
   nothing and risks everything.
3. **Money, receipts, and authorizations** (`bond.*`,
   `verification.recorded`, `owner.decision_recorded`,
   `decision.recorded`, `receipt.evidence_withdrawn`,
   `referral.completed`). The $DASHA / bounty economy needs replayable
   receipts. A summarized bond history is not a ledger.
4. **Audit-of-audit** (`room.exported`, `message.redacted`). Deleting the
   record of who exported data or who ordered a redaction destroys the
   accountability the events were created to provide (PRIV-1/PRIV-2).
5. **`room.created`.** Genesis is the replay anchor and the room's
   identity. One row; never touched.
6. **Anything in the headroom.** The newest 50,000 sequences (and at
   least 7 days of wall-clock) are never compacted. Live SSE consumers,
   the `cursor_ahead` contract, command idempotency, the budget-low
   wind-down path, and on-call debugging all assume recent history is
   intact and verbatim. Compaction is for the cold past, never the warm
   present.
7. **Policy-at-the-time** (`room.policy_set`, `room.trust_set`,
   `room.spend_pricing_set`, …). Current policy is in the projection;
   but "was this action allowed *when it happened*" needs the policy
   event. Summarizing policy history into "current policy" destroys the
   audit trail.
8. **Targeted DMs' visibility envelopes.** Even for summarizable types,
   the per-viewer DM filter (`roomEventVisible`) must keep working on
   summary events: a summary that leaks a DM's content to non-parties
   (or hides a public summary from members) is a privacy bug. Summary
   events inherit the strictest visibility of their unit's rows.

### Deliberate non-goals

- **Cross-room compaction or global dedupe.** Rooms are the isolation
  boundary; a pass touches exactly one room.
- **Rewriting history.** Summaries are *appended*; raw rows are
  *archived*, not edited. The log never contains a row that wasn't
  appended in order.
- **Changing the 1M / 4MB ceilings.** Compaction recycles budget inside
  the ceilings; raising them is a separate capacity decision.
- **Real-time (per-write) compaction.** Passes are periodic and
  windowed. Per-write summarization would serialize every hot path
  through a classification step; the watermark design keeps the write
  path untouched.

---

## 6. Relationship to sibling designs

- **W7 EVENT-BUDGET-DESIGN:** budgets meter sequence consumption per
  namespace; compaction credits reclaimed sequences back (§2.5). A
  namespace that 409s on its floor can be revived by compacting its
  cold history instead of waiting for owner intervention.
- **W11 ROOM-ROTATION-DESIGN:** rotation is terminal and owner-driven;
  compaction is continuous and automatic. The rotation watch and the
  compaction watch are one job evaluating one watermark table. A room
  that compacts well may never need rotation; a room that can't compact
  (all Class B, e.g. a receipt-heavy room) rotates on schedule.
- **Fast-path law:** every summarization rule in §1 is justified by an
  identified second source of truth. If a future event type has no
  table/projection truth behind it, it defaults to Class B until proven
  otherwise.
