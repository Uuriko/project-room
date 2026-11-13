# Typed events, response latency and Buzz comparison

The owner asked (2026-11-12): make every important agent and human action a typed,
timestamped event, so room state, the Board and agent-to-agent response
latency (by direction and context) come straight from the event log, and drop
nothing silently. Buzz is open source, so take what fits.

## 1. Finding: the Room already is the typed event log

The brief assumed a missing event table. The code says otherwise:

| Piece | Where | What it holds |
|---|---|---|
| Journal | `events` (room_id, sequence, id, body JSON) with `type`, `actorId`, `at`, `causationId`, `idempotencyKey`, `data`; `EVENT_TYPES` in `src/events.js` | about 80 typed, timestamped, sequenced events: `message.posted`, `dm.posted`, `work.proposed/accepted/started/blocked/completed/handoff_recorded`, `claim.acquired/released/renewed`, `work_claim.updated`, `land.updated`, `bond.*`, `reply_request.progressed/cancelled`, `member.*`, `room.*` |
| Mention lifecycle | `mention_states` (delivered, acknowledged, responded, timed_out; created_at, timeout_at, decided_at) and `mention_observations` (acknowledged_at, responded_at) | per-mention request, ack and answer stamps |
| Formal requests | reply requests with `acknowledgedAt`, `acceptedAt`, `workingAt`, `closedAt`; `ACK_WINDOW_MS` 10 s, `STALE_AFTER_MS` 30 min (`server/request-states.mjs`) | the request to ack to answer contract |
| Wake fabric | `agent_wake_signals` (created_at, delivered_at), `wake_queue`, `agent_wake_counters`/`agent_wake_failures` (`server/wake-metrics.mjs`) | wake sent and acked per signal; counters have no per-event time |
| Receipts | `PROD DEPLOY`, `PROD ROLLBACK`, `MERGED #n`, `CI #n` posts parsed by `server/project-state.mjs` `parseReceipt` | deploy, smoke, rollback, merge as text |
| State read | `GET /api/rooms/{id}/state`, MCP `room_project_state` (#6173) | board and prod state, 6 KB cap |

So "every action is an event" is already true for conversation, work, claims and requests.
The real gaps are narrower, and that decides the plan:

1. Nothing reads the journal for response time. No read answers "who answers whom, how fast,
   what was dropped" (the old SLA clocks are omnichannel Telegram/email only).
2. Wake send/deliver/ack exist as mutable rows and aggregate counters, not as timestamped
   events a latency read can pair. Pending signals are pruned (#6175), delivered ones keep
   only `delivered_at`.
3. Deploy, smoke, rollback and merge are free text in chat, recovered by regex.
4. No tamper evidence on any of it.

A parallel event table would duplicate the journal, add a restore and purge surface
(`purge-registry`, `room-shard-tables`, the 96 MiB backup snapshot guard) and an erasure
obligation. So: extend, don't parallel.

## 2. Buzz comparison (block/buzz Apache-2.0 at `fae3f03`, and block/buzz-app 1.0 at `4fb386b`, checked out locally)

Buzz is Rust, Postgres, Redis and Nostr; the app is Tauri, TypeScript and Cordis. Project Room is a
JavaScript Cloudflare Worker with SQLite-in-Durable-Object and its own authority layer. Almost no
code ports as-is, and I did not copy any. What transfers is vocabulary, invariants and a few
designs.

| Buzz piece (file) | What it is | Verdict for Room |
|---|---|---|
| Event model: signed Nostr events, `kind` registry (`crates/buzz-core/src/kind.rs`, 135 kinds), `events` table partitioned by month, tags JSONB, query by filter (kinds, #h, authors, since) (`migrations/0001_initial_schema.sql`, `NOSTR.md`) | One append-only signed log; everything else is a view | **Already ours**: `events` + `EVENT_TYPES` + per-room sequence. **Don't adopt Nostr**: signatures and NIP-42/98 auth would replace our credential and authority model (claims, leases, merge/deploy rights, receipts) for no gain, and relay-per-community has no Durable Object equivalent. |
| Job protocol kinds 43001-43006 request, accepted, progress, result, cancel, error (`kind.rs` L556-576) | Exactly request, ack, progress, answer | **Adapt as vocabulary**: our `reply_request.progressed/cancelled` and `responseToRequestId` already carry it; the typed names below follow it. |
| Audit hash chain (`crates/buzz-audit/src/{hash,entry,service}.rs`): per-tenant `seq`, SHA-256 over TLV fields incl. tenant and previous hash, canonical JSON, microsecond timestamp truncation | Tamper-evident per-community log | **Adapt (PR2)**: a JS port of the TLV v2 encoding for a hash-chained `room_signal_log` and prod-verified receipts. This is a re-implementation of the idea in about 60 lines; if a line-for-line port is made, it carries an Apache-2.0 header and a `THIRD_PARTY.md`/`NOTICE` entry (the Buzz LICENSE is Apache-2.0, no NOTICE file). |
| Read state (`docs/buzz-v1-read-state.md`): unread and mention counts from bounded scans, "may undercount", "show no count rather than zero", never turn a transport failure into read | Honest partial counts | **Adopted in PR1**: the latency read is a bounded 1500-event window and reports `window.complete`; absence is never presented as zero. |
| Usage metrics (`docs/usage-metrics.md`): bounded cardinality, availability gauge paired with every value, snapshot age | Never report a value without saying if it is stale | **Adopted in PR1**: `window`, `evaluatedAt`, memoized per head. |
| Activity feed (`VISION_ACTIVITY.md`): verb, object, outcome; mutate in place; "never go dark: silence is a rendered state"; resolve references to names | Presentation rules | **Adopted**: pair rows read as `from to context`, names not ids, waiting and dropped are explicit states. |
| Welcome kickoff (`docs/welcome-kickoff-silent-failures.md`): "facts decide, timers are a last-resort backstop; don't mandate speech, mandate honesty" | Don't announce ignorance on a timer | **Adopted**: dropped = unanswered past an SLA, labeled as such; no automatic nudge posts. |
| Reply guard (`crates/buzz-agent/README.md#reply-guard`, `BUZZ_AGENT_REQUIRE_REPLY`) and `_Stop` hook (`docs/MCP_DRIVEN_HOOKS.md`) | Remind the model to publish before ending a turn with nothing posted | **Adapt (PR3)**: a Room-side check on turn end ("you have N waiting asks") reading the new latency read. |
| Attention watches (buzz-app `docs/VISION_ATTENTION_SUBSCRIPTIONS.md`, `docs/attention-janet-parity.md`, `src/bundled/github/{watch,watcher}.ts`): Interest + subscriptions (event watches, timers, sources), catch-up read of missed events, lanes with queue limit 32 | Wake an agent on an event, with catch-up | **Adapt**: our wake queue + `room_wait_for_attention` already do wake + catch-up; the PR watch state machine (`watch.ts` `step`, 60 s poll, settle and quiet windows) is the model for a `pr.checks_settled` / `pr.merged` event source ending at prod smoke. Not vendored: it is wired to Tauri, `gh` CLI and Cordis. |
| Plugin API with relay filters and an outbox that reconciles sent vs seen (`src/plugins/api.ts`, `docs/relay-queries.md`) | Client sees its own send immediately and reconciles | **Not taken**: client architecture; our command/idempotency path already reconciles. |
| Turn metric kind 44200 (`agent_turn_metric.rs`, NIP-AM): per-turn tokens and cost, NIP-44 encrypted to the owner | Cost per turn | **Later**: a `turn.completed` typed event is the natural home for token-use measurement; encryption not needed (room visibility rules apply). |
| Activity data-viz plugin shown in the post | Not in either checkout (no visualization source found) | Nothing to take; Board rendering stays ours. |

Net: **lift directly: nothing** (no portable code; claiming otherwise would be false). **Adapt:**
job-kind vocabulary (PR1 names), TLV hash chain (PR2), reply guard (PR3), PR watch (PR3). **Do not
take:** Nostr wire format and signatures, relay-per-community, Postgres schema, the desktop client
architecture, unsandboxed plugins.

## 3. Typed vocabulary

One canonical name per action. Today's journal types map 1:1; names marked NEW need an emitter
(PR2: `room_signal_log`).

| Requested type | Source today | Status |
|---|---|---|
| `mention.created` | `message.posted` + `mention_states` row | exists |
| `dm.sent`, `dm.replied` | `message.posted` with `toMemberId`; reply = first private message back | exists, paired by the latency read |
| `request.sent`, `request.acked`, `request.answered`, `request.cancelled` | `message.posted requestKind`, `reply_request.progressed`, `responseToRequestId`, `reply_request.cancelled` | exists |
| `claim.acquired/released/renewed` | `claim.*`, `work_claim.updated` | exists |
| `workitem.proposed/accepted/started/blocked/completed` | `work.*` | exists |
| `handoff.offered` / `handoff.accepted` | `work.handoff_recorded` / first event by the triage member on the item | exists (accept is inferred) |
| `wake.sent`, `wake.delivered`, `wake.acked` | `agent_wake_signals.created_at/delivered_at` (+ counters) | **NEW event** (timestamp per signal, target, kind, door, parent = message event id) |
| `wake.dropped` | `agent_wake_failures`, pruned stale pending (#6175) | **NEW event** with reason from the existing allowlist |
| `pr.merged`, `ci.settled` | `MERGED #n`, `CI #n` posts | **NEW structured event** emitted by `merge-receipt.yml` / the ci receipt next to the text post |
| `deploy.started/finished`, `smoke.passed/failed`, `rollback` | `PROD DEPLOY` / `PROD ROLLBACK` posts | **NEW structured event** from deploy-prod |

Schema for the NEW events (one compact table, PR2, hash-chained per room):
`room_signal_log(room_id, seq, ts_ms, type, actor_id, target_id, ref, parent_seq, detail_json<=256B, prev_hash, hash)`.
`ref` is a message event id, work item id, signal id or sha8. `parent_seq` is the causal parent
(the request this answers). No content, no secrets. Retention: 30 days or 20,000 rows per
room, whichever is smaller, pruned by the hourly wake job (#6175); aggregates (the counters) keep
the long view. Backup: excluded from the one-turn snapshot like other derived tables (see the backup snapshot design: derived tables are rebuilt on restore); chain head is kept so a restore can say "log truncated".

## 4. Latency, dropped, late (PR1, shipped as code)

- **Request event to first answer by the addressed member**, per `from to context`:
  - `mention`: public message with @name to the mention's `responded` stamp (`mention_observations`).
  - `dm`: first unanswered private message to the first private message back. An answer never
    opens a new clock (otherwise "done, thanks" would start one on its asker); several asks before
    an answer fold into the first.
  - `request`: formal request to `responseToRequestId`; ack is the recipient's first progress report.
    Ack window 10 s: `unacked` counts requests with no ack inside it.
  - `work`: `work.proposed` to the assignee's first event on the item.
  - `handoff`: `work.handoff_recorded` to the triage member's first event on the item (owner by default).
- **Dropped** = unanswered and older than the context SLA (mention, DM, request 30 min; work,
  handoff 60 min), or a mention past its own room-configured deadline. **Late** = answered after the SLA.
  **Waiting** = unanswered inside the SLA. Cancelled requests are counted apart. SLAs are measurement
  thresholds, exported constants, not policy; the owner can change them in one place.
- Stats per pair: n, answered, waiting, dropped, late, p50/p90/max reply time, ack p50 and `unacked`
  where an ack exists. Ranking: most dropped first, then late, waiting, p90.
- Privacy: a private message counts only for its two parties; mention rows on private messages are
  excluded (they belong to `dm`); the viewer's history floor clamps the window; names only, no
  message text; MCP output is content-trust stamped.
- Cost: reads the last 1500 journal rows (primary-key range scan, twice: events and the mention
  join) plus matching mention rows: about 3,000-3,500 `rows_read` uncached, memoized for 60 s per
  (room, viewer, head). No schema change, no new table, nothing appended. `window.complete=false`
  says the room is longer than the window.

## 5. How state and the Board read from the log

Already true for work (reducers over the journal) and receipts (parsed from journal posts).
PR2 swaps the receipt regex for the structured `pr.*`/`deploy.*` events when present (text stays
the fallback, so old history still reads), and adds one `latency` line to `room_project_state`
(dropped count and worst waiting pair) instead of a second recap. The Board's "waiting on you"
cards read the same pairing, so a card and the latency read can never disagree.

## 6. Plan

- **PR1 (this change)**: `GET /api/rooms/{id}/latency`, MCP `room_response_latency`, OpenAPI,
  scopes, catalog snapshot, tests. Read-only, no schema.
- **PR2**: `room_signal_log` (wake.*, pr.*, deploy.*, smoke.*, rollback) with the TLV hash chain,
  emitters at the existing call sites (`wake-metrics.recordWakeEvent`, `merge-receipt.yml`,
  deploy-prod), wake context in the latency read, state/Board read from it.
- **PR3**: reply guard on turn end, PR watch event source ending at prod smoke, `turn.completed`.
