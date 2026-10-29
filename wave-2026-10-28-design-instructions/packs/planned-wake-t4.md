# PLANNED WAKE REBUILD T4 — Wake onto the Event Sequence

Status: PLANNED piece, executable at its own charter. This pack is the
charter-ready instruction; a coordinator chartering T4 is the only
activation act it needs. It is **not** gated on the redesign
typed-object unpause (see §1.3 for why, verified at source). Budget of
record: **24–33 lh** (deep-pass verdict; §4.8 breaks it down). It
**supersedes Wake Steps 2 and 3** as chartered (Step 2 claimer,
17.25–19.5 lh operative; Step 3 completion ledger, 8.75–9.75 lh
operative — `wave-2026-10-25-wake-adoptions/REPORT.md` R-1/R-2/R-3):
do not build either step in its chartered form once T4 is chartered.

## 1. The piece

### 1.1 What it is

Today a wake is a **second, side-table write** that shadows the room's
event log: a message commits to the room's event sequence, and then a
separate fan-out inserts a row into `agent_wake_signals`, coalesces it,
journals it in wake-metrics, and pokes an in-process waiter. T4 deletes
the shadow. **A wake becomes a derivation over the room's event
sequence**: the triggering event already carries a per-room sequence
number; a wake for agent A in room R is "an event at seq > A's wake
cursor in R whose type/addressing resolves to A, not yet claimed or
settled." The poll holds on the sequence, the cursor is the queue
position, claim/settlement ride the doors Wake Step 1 built, and the
completion ledger (Step 3's product) becomes a **projection** over
sequence + claim/settlement records instead of a new store built over
the signals table. The design target in one line: **wake latency =
event-commit latency** — there is no second write left to wait for,
fail, coalesce wrongly, or drift from the log.

### 1.2 Where it lives (verified at main `aaa749065a6451321a949ddcb923f3174504fe35`)

Read via `git archive` / `git grep` at that SHA this lane; production
is a different tree (`ca37fee4`, read from `GET /api/version`
2026-10-28) and is **not** the target tree — T4 targets main.

- **The event sequence (already exists, this is the foundation):**
  `server/store.mjs` — `events (room_id, sequence, id, body)`,
  `PRIMARY KEY(room_id, sequence)` (schema at line ~1601);
  `rooms.sequence` is the head; appends are
  `sequence = room.sequence + 1; INSERT INTO events …; UPDATE rooms
  SET sequence=?` inside the command transaction (e.g.
  `appendSideTableEvent`, line ~3586). `cursors (room_id, member_id,
  sequence)` already exists (line ~1609). Message rows carry the same
  seq: `server/messages-store.mjs` (`messages.seq`,
  `messages_room_seq` index).
- **The stream surface (already exists):** route table
  `server/routes/table.mjs` line 126 — `GET
  /api/rooms/{roomId}/stream?after=0`, plus the room events route
  (OpenAPI fragment `0030-api-rooms-roomId-events.yaml`,
  `0031-…-stream.yaml`).
- **The wake side-table being retired as the queue of record:**
  `server/agent-heartbeats.mjs` (1,298 lines at this SHA) —
  `enqueueWake()` (line 1025: `INSERT OR IGNORE INTO
  agent_wake_signals`, coalesced on `(agent_id, room_id, message_id)`,
  then `_releaseWakeWaiter`); `pendingWakePage()` (line ~1063: reads
  `delivered_at IS NULL` rows, merges a **second store** —
  `store.workWakes.pending()` from `server/work-wakes.mjs` — sorts,
  and counts the page serve as a `delivered` wake-metrics event);
  `notePoll()`; `addWakeWaiter()` / `_releaseWakeWaiter()` (in-process
  waiter map, one per agent+host); `wakeIfOffline()`.
- **The poll door:** `server/agent-plugin-routes.mjs` lines ~935–970 —
  `GET /api/agent-wakes/poll?hostId&waitMs` (default 25,000 ms, max
  55,000 ms; rate `agent-wake-poll:<identity>` 30/min at this SHA);
  heartbeat + ack doors in the same file; MCP parity in the hosted
  profile.
- **Enqueue callers (every one must be re-pointed or named a gap, §4.4):**
  `server/store.mjs` `maybeWakeOnMention()` (line ~6602, mention/DM
  fan-out for `message.posted`, called with the event's room/state)
  and the bond enqueue (line ~6376); `server/work-claim-events.mjs`
  line 130 (mention); `server/work-wakes.mjs` (work store);
  `server/inbox-collab-routes.mjs` line 134 (`assignment`);
  `server/land-queue.mjs` line 1205 (`land`); `server/public-agent-page.mjs`
  line 386 and `server/sleeper-wake.mjs` (`ask` / sleeper path).
  `WAKE_KINDS = [mention, dm, bond, assignment, land, ask]` at
  `agent-heartbeats.mjs` line 29.
- **Accounting:** `server/wake-metrics.mjs` (`recordWakeEvent`,
  `wakeAccounting`) — every emission today resolves to exactly one
  outcome (`emitted / coalesced / suppressed_no_host /
  suppressed_no_identity / delivered / acked …`).
- **Consumers:** Jill's VM bridge (`room-wake-check.mjs`, hook-driven,
  long-poll + dispositions) is the only proven always-on consumer
  (E5 §1); session consumers reconcile on start. T4 changes the server
  contract; bridge adoption is a named phase (§4.6), not an assumption.

### 1.3 Why T4 does not depend on the paused typed-object phase

The typed-object phase (Record #4551 → Verdict → Queue view, redesign
Phase 2) is PAUSED under FOCUS-REVIEW, and SYNTHESIS D-1/D-10 sequence
the old wake work behind it. T4 does not inherit that dependency,
because **nothing T4 reads is a typed object**: the `events` table, the
per-room `sequence`, the `cursors` table, and the `message.posted` /
`dm.posted` event bodies T4 derives wakes from all exist at main
`aaa749065a` today, landed independently of #4551/#4496 (neither is in
the current bindings file — checked this lane). Claim, Record and
Verdict, if the phase ever unpauses, arrive as *more event types in
the same sequence*; a sequence-derived wake subscribes to them by
adding a type to its addressing rule, with no redesign. Flag, stated
plainly: if an implementer's design draft makes any T4 read depend on
a Record/Claim/Verdict object existing, the draft is wrong — stop and
re-derive from the event types that exist at the build base.

### 1.4 Sequencing vs #4934 (Wake Step 1) — hard predecessor

#4934 (Wake Step 1 substrate: claim + release doors
`POST /api/agent-heartbeats/claim` / `release-claims` with HTTP/MCP
parity, carried idempotency key on `agent_wake_signals`,
claims-evidence holder/lease-expiry snapshots, stale-write journal) is
**OPEN, unmerged**, bound at head `f6b2d81306e2b5ae3799526d28ba00936d600cd1`
(bindings file, record `5a1ba5c7`), state **REBIND-WITH-NAMED-RED**:
the red is exactly main's 3 manifest-drift unit tests, discharge on
**#4960 landing** (#4960 is OPEN at `5d83e7ce` at this lane's read —
GitHub API, 2026-10-28). T4's sequencing rule:

1. T4 build does **not** start until #4934 has landed **and deployed**
   and its post-land discharge read has run (claim/release doors live
   in production, key + journal readable). T4's claim/settlement leg
   (§4.5) is built *on* those doors; re-implementing them inside T4
   is a non-goal and a duplicate-build defect.
2. #4934's own body names the residue T4 inherits: the claim path's
   legacy `delivered` listener-transport leg ("the residual for Step
   2's vocabulary gate") and `dead_at` **not** built in Step 1 (it is
   #4531's vehicle; Step 2's G5 gate reads its absence as NO-GO).
   T4 must dispose both explicitly (§4.5, §5) — inherit them, don't
   rediscover them.
3. Steps 2–3 activation is already PAUSED (FOCUS-REVIEW, recorded in
   #4934's body). Chartering T4 is the coordinator act that converts
   that pause into supersession; until that act, Steps 2–3 stay
   paused, not cancelled.

## 2. Current state

Executed evidence on file; nothing here is re-derived.

- **Wake works for exactly one seat, via a private bridge.**
  `pr-redesign-2026-10-23/e5-wake-presence.md` §1: Jill's bridge is
  the only proven consumer; measured mention→wake **p50 1.22 s / p90
  20.4 s over 84 signals**, with **40% of poll invocations degraded by
  generic-bucket 429s** (MIG-WAKE, 7,025 hook invocations). Codex-class
  session seats have no proven unsolicited delivery (37 h 02 m silence
  specimen, E5 §1/§3 G-E5-1).
- **Serve is counted as delivered.** Deepdive erratum **E-01**
  (`wave-2026-10-25-deepdive/wake-presence/SYNTHESIS.md` §1): production
  wake accounting defines delivery as inclusion in a served page —
  verified at main above (`pendingWakePage` records event
  `"delivered"` per page serve). #4934 corrects the signals-page leg
  to `served` once it lands; the vocabulary confusion is structural
  while the queue is a table whose *reading* is the delivery event.
- **The four states are not server facts.** E5 §3 G-E5-2: received /
  started / evidence / accepted live in consumer journals;
  `delivered_at` is written at ack time. Steps 2–3 were chartered to
  fix exactly this over the signals table (claimer + completion
  ledger, 26–29.25 lh combined operative) — T4's claim is that fixing
  it over a derived cursor is the same work, once, on the log itself.
- **Cursor advance can silently erase unprocessed mentions.** The
  notifications feed derives unread strictly from after the caught-up
  cursor (500-event tail), so one `markCaughtUp` to head erases
  unprocessed mentions permanently (deepdive wake-presence SYNTHESIS,
  QA claim 10 CONFIRMED; PR #4571 was a bounded cure, "lossless
  historical pagination remains separate work"). Any sequence-derived
  wake inherits this failure shape unless the cursor guard is a build
  rule (§4.3) — this is T4's named falsifier-class defect.
- **Wake-stack discharge is still UNPROVABLE.** `wake-stack-discharge.md`
  (E5 C1, 2026-10-24): the five queue PRs (#4494 rate budget, #4497
  wake states, #4522 wake health, #4530 provenances, #4531
  TTL/dead-letter) had not landed; defects measured live in production
  (53 erroring bridge invocations in 24 h). Per #4934's body, the D4
  KEEP-set vehicles (#4494/#4522/#4530/#4531) were **re-closed by the
  2026-10-25 cleanup** and need re-flipping. T4 does not silently
  absorb them: §4.7 names which ones T4 still needs.
- **Two stores already merge at read time.** Verified at main above:
  `pendingWakePage` merges `agent_wake_signals` with the work-wake
  store and re-sorts — the "one queue" is already a read-time fiction.
  T4 makes the fiction the design (one sequence, per-source addressing
  rules) instead of a sort.
- UNVERIFIED: per-kind enqueue latency and the share of wake cost in
  the message-commit transaction at current tempo. The implementer's
  first hour (§4.1) measures this; no number in §3 depends on it.

## 3. What fantastic means

Concrete end state, all server-measurable:

1. **Wake = commit.** A held poll for agent A releases in the same
   server operation that commits the triggering event: server-measured
   commit→waiter-release **p50 ≤ 250 ms, p99 ≤ 2 s** on the room's own
   bench + a production hook-log window, replacing the 1.22 s p50 /
   20.4 s p90 baseline — and the number is *structurally* the commit
   latency, because there is no enqueue write after the commit.
2. **Nothing lost, ever, by cursor movement.** Advancing, catching up,
   or expiring any cursor never removes an unclaimed wake from the
   pending read. The two-mention specimen (§5, probe N4's shape) is
   the standing proof: mention 2 posted while mention 1 is unhandled
   is still pending after any catch-up operation.
3. **One pending read, one truth.** `pendingWakes` for an agent is a
   pure function of (event sequence, wake cursor, claim/settlement
   records): recomputable from the log alone, identical across the
   HTTP poll, the heartbeat snapshot drain, and the MCP door. The
   signals table, if it still exists, is a cache whose contents a
   checker can regenerate and diff — not a second truth.
4. **Four states as server facts.** queued (seq > cursor, unclaimed) →
   claimed (via #4934's claim door, fencing + holder evidence) →
   settled (settlement record, EG-1 shape) or `unknown` (its named
   home is this projection's ledger view, per ruling R-3) or
   dead-lettered (only via #4531's `dead_at` leg, §4.7). A coordinator
   reads all four from server state alone — no consumer journal, no
   hook log archaeology (closes E5 G-E5-2).
5. **Sender-exclusion and suppression stay honest.** No self-wake
   (E5 G-E5-10); `suppressed_no_host` / `suppressed_no_identity`
   remain counted wake-metrics outcomes, now emitted at derivation
   time with the event's seq attached.
6. **Exemplars to match:** the transactional-outbox discipline in
   E5 §4.3 (the durable row *is* the event — T4's endpoint of that
   logic: no outbox row at all, the log is the outbox); Kafka-style
   consumer offsets (cursor = offset, replay = re-derive, never
   destructive); Ably/Pusher presence-delta lesson (snapshot read
   behind every delta — the pending read is the snapshot, the poll
   the delta).

## 4. The instruction

Ordered. Standing constraints throughout: fix lanes never merge;
no `git stash`; TMPDIR/scratch under the lane's named dir; a GitHub
429 is a fleet-wide stop; CI read at most once per 10 min per PR;
**zero new tables is the default** — any schema beyond the existing
`events` / `cursors` / claim / settlement records stops the lane for a
re-charter (schema work is freeze-class and lands singly; T4 is
priced as non-freeze precisely because it needs none).

### 4.1 First hour — re-read at build base (no code)

Re-read, from the GitHub API and a fresh `git archive` of then-main:
#4934's landed head and its discharge read; #4960's state; the D4
KEEP-set states (#4494/#4522/#4530/#4531 — re-flipped or not);
`agent-heartbeats.mjs` enqueue/poll/claim surfaces at build base.
Measure and file: per-kind enqueue call sites then live, and the
message-commit path's wake cost (bench:room, named sizes). Restate
the charter in the lane STATE.md with these numbers; if #4934 has not
landed+deployed, file BLOCKED-not-landed (per §1.4) and stop.

### 4.2 Derivation core

Build a wake-derivation module (server-side, name at build base;
candidate `server/wake-sequence.mjs`) that, given (agentId, roomId,
cursorSeq), returns the pending set by scanning the room's events
from cursorSeq: event types `message.posted` / `dm.posted` plus the
event types behind kinds `bond`, `assignment`, `land`, `ask` where a
room event exists, addressed by reusing the **existing** resolvers —
`agentWakeTargets` + `identityIdForWakeMember` (guest-aware) for
message kinds, the work-claim addressing for work-origin events.
Addressing logic is reused, never re-implemented: a second mention
resolver is a defect by definition. Sender excluded; paused rooms
held (existing `pausedRoomsOf` semantics); coalescing is free and
must be proven so — one event, one seq, one wake per addressed agent
(the old `(agent, room, message)` tuple collapses to `(agent, room,
seq)`).

### 4.3 Cursor discipline (the falsifier leg — build before any cutover)

- The wake cursor is per (agent, room) and lives on the existing
  `cursors` pattern; it advances **only** by claim or settlement,
  never by reading, serving, polling, or catching up. A catch-up /
  mark-read operation on any feed must not move the wake cursor —
  write this as a code-level separation (distinct cursor rows /
  distinct advance functions), not a comment.
- Serving a page stamps nothing as delivered. The `served` leg from
  #4934 remains a diagnostic counter only (Step 3 charter S3-01's GO
  condition, carried forward).
- Negative probe N4 (from Step 2 charter S2-10) is adopted verbatim
  as a build-time test: two mentions, drain/catch-up between them,
  second mention still pending — silent disappearance fails the
  whole proof pass.

### 4.4 Poll and waiter rewire

- `GET /api/agent-wakes/poll` keeps its contract (hostId, waitMs
  ≤55,000, response shape incl. `cadenceSeconds`) but its waiter
  registers on the **room sequence head**, not on `enqueueWake`: any
  commit advancing a room the host's agent is addressed in releases
  the waiter, which then derives the pending set. The in-process
  waiter map (`addWakeWaiter`) is re-keyed accordingly; per-host
  replacement semantics (the two-host livelock note in the current
  code) are preserved and re-tested.
- Heartbeat snapshot drain and the MCP wake door return the derived
  set identically (parity is §5-checked, not asserted).
- Work wakes: the `work-wakes.mjs` store stays a separate source in
  this build **only if** its entries carry or gain a room seq at
  their origin event; otherwise work wakes are a named, filed gap
  with the signals path retained for that source alone (§4.6
  retirement is per-source, never big-bang).

### 4.5 Claim, settlement, ledger — on #4934's doors, superseding Steps 2–3

- Claim = #4934's claim door, re-keyed: a claim records (agent, room,
  seq, event id) plus #4934's holder/lease-expiry snapshot and carried
  idempotency key — the key is the ledger join key (Step 3 S3-03 /
  EG-2, carried forward; renaming a signal/message/seq id as "the
  idempotency key" is forbidden, exactly as chartered there).
- Settlement is its own act, split from the legacy bare ack (Step 2
  S2-07 / EG-1 carried forward): bare ack stays as legacy-ack
  compatibility, labelled, never counted as settlement. Claimed-never-
  settled items resolve only to `unknown` or dead-letter, never
  done-but-not-processed (Step 3 S3-15 path rule, carried forward).
- The completion ledger (Step 3's product) ships as a **read
  projection**: per-agent / per-room stage counts and ages derived
  from sequence position + claim/settlement records, computed from
  stored timestamps only. Every count derives from stage/ledger
  records, never from a serve counter (Step 3 S3-09 source rule).
- **Exit-gate EG-S2 is not silently dropped.** EG-1 (settlement
  shape), EG-2 (key naming), EG-3 (fencing journal across
  `stale_listener` / `listener_fenced` / `wake_signal_fenced` —
  #4934's journal leg), EG-4 (`unknown` home) are each either
  satisfied by a T4 artefact named in the PR body or carried as an
  open gate with a named owner. Supersession of a criterion requires
  a coordinator ruling recorded in the room, not a lane decision.
- The legacy `delivered` listener-transport leg #4934 left as Step
  2's residue: T4 renames or retires it, with the vocabulary audit
  (Step 2 S2-01: no evidence pack may cite a serve as stage evidence)
  applied to every T4 surface.

### 4.6 Migration, dual-run, retirement

1. **Backfill:** in-flight `agent_wake_signals` rows at cutover are
   mapped to (room, seq) via their message_id → `messages.seq` /
   events lookup; unmappable rows are listed by id in the PR body
   and drained through the old path — none silently dropped.
2. **Dual-run:** for one full landing cycle, the derived pending set
   and the signals-table pending set are both computed on every poll;
   divergences journal into wake-metrics as a named mismatch outcome
   (counted, never served). Cutover per source (§4.4) only when a
   source's mismatch count is zero over the cycle.
3. **Bridge adoption:** Jill's bridge switches its poll consumption
   to the derived contract in the same PR series (consumer change
   rides the server change, per E5 C3's rule); dispositions /
   subscription work (E5 C5) is **not** in T4 — the bridge's local
   dispositions file is untouched by this build.
4. **Retirement:** `enqueueWake` call sites are deleted per source as
   that source cuts over; when the last source retires, the signals
   table becomes read-only legacy (purge-registry entry updated, not
   dropped — dropping is a later, separate act).

### 4.7 Named dependencies and non-goals

- **#4531 (`dead_at` / TTL / dead-letter):** T4 needs the landed
  `dead_at` shape for its dead-letter state; if #4531 has not been
  re-flipped and landed by §4.5's start, that state ships as a named
  gap (claimed → `unknown` path only) and the lane files the blocker
  — it does not mint its own `dead_at`.
- **#4494 (wake rate budget):** still required for the §3 latency
  numbers to hold under load; T4's acceptance latency window is
  measured with #4494 landed, or the measurement is filed as
  fair-weather-only, labelled.
- **Non-goals:** Wake Subscription object (E5 C5); MCP wake
  notifications (E5 C6); presence work of any kind (cadence is
  already server-assigned at this main; Gap 4 / tombstone are other
  charters); waking a closed session app (physically out of scope,
  E5 §7); the intent queue (`server/wake-queue.mjs` — a different
  queue; its `dead` state is fenced off from T4's dead-letter by
  name, per Step 3 S3-07); any typed-object (Record/Claim/Verdict)
  build (§1.3); any change to money, auth, or membership semantics.

### 4.8 Budget (24–33 lh of record, broken down)

Derivation core + addressing reuse 6–8 · cursor discipline + N4
class tests 3–4 · poll/waiter rewire + parity 4–5 · claim/settlement
rebind + ledger projection (Steps 2–3 replacement) 5–7 · backfill +
dual-run + per-source cutover 3–5 · bridge adoption + retirement +
acceptance evidence 3–4. Total 24–33 lh. 50% report at 12–16.5 lh;
BLOCKED-budget at 100% unless the coordinator extends on the record.
Kill criteria: derivation scan adds >5 ms p50 to message commit on
bench:room at the named sizes (the E5 C5 bench bound, applied here —
routing/derivation must not tax the write path; the design then
moves to commit-time seq stamping in a re-charter), or the dual-run
mismatch cannot be brought to zero for the message source within the
budget — either files BLOCKED with the bench/mismatch evidence, not
a workaround.

## 5. Acceptance

Coordinator/Jill runs these; the lane does not self-certify.

**Executed checks (commands / suites by name, at the exact head):**

1. `npm run verify:affected` green, plus `CI=1 npm run check` (the
   diff touches `server/**`), plus by name: `tests/agent-wake-poll.test.js`,
   `tests/agent-wake-listener-lease.test.js`, `tests/agent-wake.test.js`,
   `tests/agent-heartbeats.test.js`, `tests/wake-pagination.test.js`,
   `tests/wake-accounting.test.js`, `tests/wake-completion.test.js`,
   `tests/wake-path.test.js`, `tests/native-wake-bridge.test.js`,
   `tests/room-mcp-wake.test.js`, `tests/sleeper-wake.test.js`,
   `tests/pull-only-heartbeat-wakes.test.js` (all exist at main
   `aaa749065a`), and the lane's new T4 suites.
2. **Commit-latency probe:** in a QA room, a second seat posts a
   mention while the target host holds a poll; server-side timestamps
   show event commit → waiter release within the §3.1 bounds over a
   20-mention run; the same run's pending read is identical on poll,
   heartbeat drain, and MCP.
3. **N4 cursor specimen:** two mentions, catch-up + page-serve +
   cursor operations between them; both remain pending until claimed;
   neither a serve nor a catch-up moves the wake cursor (read the
   cursor row before/after).
4. **Kill-mid-handling:** claim, kill the worker, lease expiry →
   redelivery with `redelivered` set and the claim's holder evidence
   still readable (the #4934 / E-11 property, re-proven on seq-keyed
   claims).
5. **Dual-run evidence:** the filed mismatch report for one landing
   cycle shows zero mismatches per cut-over source; backfill's
   unmappable-row list is empty or each id is accounted for.
6. **Accounting reconciliation:** wake-metrics emitted / served /
   claimed / settled / `unknown` / suppressed counts reconcile against
   a from-log re-derivation the coordinator runs independently
   (two agreeing reads); no count cites a serve as delivery.
7. **EG-S2 disposition table** in the PR body: EG-1…EG-4 each marked
   satisfied-by (artefact named) or open (owner named) — acceptance
   fails on a missing row, not on an open gate honestly carried.
8. Post-deploy: E5 C1-style discharge window re-run for the wake path
   (hook log over a comparable window vs the p50 1.22 s / 40% 429
   baseline), filed before the build is called landed-and-alive.

**Registration sweep (per AGENTS.md pre-flight list):**

- Runtime-package closure — **applies** if a new `server/**` module
  is added (§4.2's module): allowlist in `scripts/runtime-package.mjs`
  including full import closure **and** `scripts/candidate-runtime-fixture.mjs`
  path list; closure test green, never by eye.
- Error-code catalogue, both copies — **applies conditionally:** any
  new code (e.g. a cursor-scope refusal beyond the existing
  `invalid_wake_cursor`) → row in
  `skills/project-room/references/errors-catalog.md` + `node
  scripts/skills-sync.mjs` so the `plugins/` mirror is byte-identical;
  no new code → n/a, stated in the PR body.
- Route triple — **applies:** any changed/new route (poll response
  shape, cursor reads) → `server/routes/table.mjs` row with parity
  note (`parity: "mcp:<tool>"` or `exempt:<reason>`), legacy-allowlist
  baseline if on the legacy chain, `docs/openapi.yaml` operation +
  bare-path quickstart example.
- Harness copy sets — **applies conditionally:** if a test harness
  copies/transforms any module T4 touches, wire it into that harness's
  copy/re-point set; otherwise n/a (no harness copies).
- Store registries — **applies as a negative:** T4's zero-new-tables
  constraint (§4) means no writer-fence / purge-registry /
  recovery-audit registration should appear; if the diff adds one,
  that is the re-charter trigger, not a sweep item to complete.
  The signals table's purge-registry entry **is** updated at
  retirement (§4.6.4).
- Generated/mirrored artifacts — **applies:** no `EVENT_TYPES` growth
  is permitted by this design (wakes derive from existing types); if
  the MCP wake door's shape changes, regenerate
  `tests/fixtures/mcp-catalog.snapshot.json` in the same diff and run
  the count pins `tests/mcp-search-actions.test.js` +
  `tests/mcp-untrusted-content.test.js` by name (verify:affected does
  not select them).
- Diff hygiene — **applies:** >300 changed lines is expected at this
  budget; the `## Large diff justification:` section goes in the PR
  body at filing.
- Landing discipline — server/shared-core surface: lands **singly**,
  green at exact head, `ready-to-land` label added once by a user/App
  token before CI is read as evidence; Ruling 41 tree-SHA inheritance
  does **not** apply to the claim/settlement leg (shared-core).

## 6. Routing

- **Implementer: Codex** — server/core work on the store's own
  transaction and sequence machinery, and the claim-door substrate is
  his Step 1 build (#4934); continuity of authorship on the wake
  ladder is worth more here than a fresh reader. Handover channel:
  `room_request_reply` to Codex's exact member with a concrete ask,
  a `workItemId`, and the expected result named (the tracked-ask
  protocol) — noting on the record that the ask does not wake an idle
  session; the charter waits for an attended session rather than
  escalating silence.
- **Landing seat: Grok Bot** with John's Tab — singly, per §5, in
  stack order after #4934 (and #4960's discharge of #4934's named
  red) has landed; no batching with other PRs.
- **Verification: Jill's fleet** — the §5 probes, the dual-run
  mismatch audit, and the post-deploy discharge window are fleet work;
  the fleet never merges. **John's Tab:** post-deploy verification of
  the production wake window (probe 8's production leg).
- **Not routed to:** Claude (client surfaces — T4 has none; the
  client is untouched and stays vanilla JS) and Fo (no browser-shard
  evidence is load-bearing here; responsive duty only if the landing
  seat needs CI evidence chased).
