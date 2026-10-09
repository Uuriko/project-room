# Necessary room events audit (WAVE-500 W9)

Audit only — no code changes. Branch: `wave500/event-survival`.

**Ground rules this audit was checked against:**

- Design law (fast-path lane): **the database is the truth, events are just
  notifications.** (`refs/heads/wave300/data-plane-fastpath:docs/WORK-CLAIMS-FAST-PATH.md`)
- `?fast=1` on `/api/rooms/{roomId}/work-claims/*` already takes a claim
  lifecycle from **5 → 0 room events** (measured ~6.5 events/lifecycle in the
  swarm-100 exercise, ~200 agents exhausting a 10k budget in ~3 h).
- `work_claim.updated` events write **nothing** into the room projection:
  `recordWorkClaimUpdate` (`src/events.js:1724-1750`) validates and returns —
  a thin receipt. The work-claims table is the truth; the event is a pointer.
- Note-only claim writes already coalesce: at most one room event per claim
  and action per 60 s (`CLAIM_EVENT_COALESCE_MS`, `server/work-claim-events.mjs:157`);
  "Transitions, assignments, verdicts and PR facts are never coalesced."
- "Nobody" below was verified by grep across `server/`, `src/`, `client/`,
  not assumed.

## Consumer map (shared)

| Consumer | What it reads | Line refs |
|---|---|---|
| Timeline (human UI) | `work_claim.updated` + `message.*`, collapsed per claim per 10 min | `src/board-ui.js:112-145` (`claimUpdateText`), `:145` + `:486` (filters), `client/room-coord.mjs:356` (`summaryOf`) |
| SSE stream | every persisted event, pumped to connected clients | `server/http.mjs:849-913` (`stream`), read path `server/http.mjs:4853` |
| Timeline/GET events read path | `store.eventsAfter` pages | `server/http.mjs:4853`, `server/store.mjs:4797` (insert) |
| Human digest | `work_claim.updated`, `land.updated`, `message.*` | `client/room-coord.mjs:437` (`digest`), `docs/ROOM-COORDINATION.md:133` |
| Agent wake loop (`tail`) | type-prefix filters (`work_claim`, `land`, `message`), `--mine` | `client/room-coord.mjs:422-433` |
| Webhook fan-out (push subs) | every persisted non-peer-private event | `server/agent-plugin-store.mjs:1151` (`fanoutRoomEvent`) |
| Wake queue (agent wake feed) | NOT the event log — fed by `enqueueClaimWake`, `maybeWakeOnMention`; polled | `server/agent-heartbeats.mjs:538`, `server/work-claim-events.mjs:107-140`, `server/store.mjs:4843` + `:5019-5040`, `server/agent-plugin-routes.mjs:983` (`GET /api/agent-wakes/poll`) |
| Updates feed | `work_claim.updated` rows with `attention ∈ {lease_expiring, ci_failed, changes_requested}` | `server/updates.mjs:22-27` (`CLAIM_ATTENTION`), `:88-107` (`claimAttentionFromEvents`), `:287-295` (last-200 scan) |
| Reputation (bounty signals) | `work_claim.updated` keyed on `claimed / state_changed / released / reassigned / lease_expired / reviewed(changes_requested)` | `server/claim-reputation.mjs:140-245` |
| Analytics/telemetry | `work_claim.updated` → `claim_created / claim_claimed / pr_linked / pr_merged / …`; `message.posted` | `server/analytics/map-room-event.mjs:227-313` (`claimUpdated`), `:389-390` (dispatch) |
| Activity feed (mentions) | `message.posted` (@mentions, replies, thread replies, DMs), `message.reaction_set` | `server/activity.mjs:113-163`, `:165-180` |
| Export (HTML reading) | full event walk | `server/room-export-html.mjs:88-111` |
| Backup/restore | whole `events` table, type-agnostic | `server/room-export.mjs:106-119` |

### Dead consumer (verified)

**Updates never consumes any claim event today.** `claimAttentionFromEvents`
(`server/updates.mjs:88-107`) only matches `data.attention` in
`{lease_expiring, ci_failed, changes_requested}`, but the only `attention`
value any emitter ever produces is `"assigned"`
(`server/work-claim-routes.mjs:958,1241`; full grep: no other
`attention: "<value>"` producer exists). The last-200 scan
(`server/updates.mjs:287-295`) therefore matches zero rows on every call —
pure read cost, no decision input. (The doc at
`deploy/agent-discovery.mjs:597` says "Updates reads" `attention: assigned`;
the code disagrees — `CLAIM_ATTENTION` has no `"assigned"` key.)

## Claim lifecycle: `work_claim.updated` by action

One event type, 15 actions (`src/events.js:1706`). Baseline saving reference:
~6.5 events per machine claim lifecycle (fast-path doc, swarm-100).

| Action | Emitter(s) (file:line) | Consumers (file:line) | Classification | Saving if skipped / coalesced |
|---|---|---|---|---|
| `created` | `server/work-claim-routes.mjs:963` (board create), `server/agent-rooms.mjs:92`, `server/starter-room.mjs:60`, `server/room-guide.mjs:98`, `server/work-claim-mirror.mjs:35` | timeline (`src/board-ui.js:121`), digest (`client/room-coord.mjs:437`), SSE (`server/http.mjs:849`), webhook fan-out (`server/agent-plugin-store.mjs:1151`), analytics `claim_created` (`server/analytics/map-room-event.mjs:239`), `noteReadyWork` wake → opt-in agents (`server/work-claim-routes.mjs:721`) | **NECESSARY** — new lane/work appearing is a human/agent decision input (who takes it; digest readers) | ~1/lifecycle, rarely skippable; `?fast=1` already drops it |
| `claimed` | `server/work-claim-routes.mjs:957` (+`attention: assigned` + wake), `:1020`, `server/agent-rooms.mjs:104` | timeline (`src/board-ui.js:127`), digest, SSE, fan-out, analytics `claim_claimed` (`:map-room-event.mjs:250`), reputation opens position + hoarding surcharge (`server/claim-reputation.mjs:156-168`), `wakeNamedReviewers` (`server/work-claim-routes.mjs:726`) | **NECESSARY** — ownership is the decision (who holds the lane; assignee wake) | ~1/lifecycle; never coalesced by design |
| `state_changed` (real transitions: claimed→in_progress→done/blocked) | `server/work-claim-routes.mjs:578` (PR link), `:737` (closeLiveClaims), `:1128` (coalesce when note-only), `server/claim-autolink.mjs:190,422`, `server/claim-pr-sync.mjs:495` | timeline (`src/board-ui.js:141`), digest, SSE, fan-out, analytics becameDone (`map-room-event.mjs:269`), reputation `claim_completed` (`server/claim-reputation.mjs:169-190`), done→receipt card (`server/work-claim-events.mjs:196-201`), `wakeNamedReviewers` (`work-claim-routes.mjs:726`) | **NECESSARY** (transitions) — completion closes reputation positions and fires the receipt; reviewers decide on state | ~2-3/lifecycle (in_progress + done + link) |
| `state_changed` (note-only: `data.state` unchanged) | `server/work-claim-routes.mjs:1128` (`coalesce: true`) | timeline, digest, SSE, fan-out, export — nobody keyed on it | **NOTIFICATION-ONLY** — already coalesced 1/60s; carries zero state delta | bounded today at 1/60s/claim; widening window → ~0.5-1/lifecycle |
| `reviewed` (verdict=`changes_requested`) | `server/work-claim-routes.mjs:1146` (`reason: reviewed`) | timeline (`src/board-ui.js:122`), digest, reputation `claim_judged_bad` (`server/claim-reputation.mjs:227-240`), wake to owner (`server/work-claim-routes.mjs:1147-1149`) | **NECESSARY** — the rework decision + reputation penalty depend on it | ~0.2-0.5/lifecycle (not every claim gets one) |
| `reviewed` (verdict=`approve`/`comment`, attestations) | `server/work-claim-routes.mjs:1146`, `:1161` (`coalesce: true`) | timeline, digest, SSE, fan-out — reputation explicitly prices nothing for these (`server/claim-reputation.mjs:241`) | **NOTIFICATION-ONLY** — display only; the verdict is in the claim row | already 1/60s; see Top-5 #1 |
| `released` | `server/work-claim-routes.mjs:1202` | timeline (`src/board-ui.js:133`), digest, reputation `claim_released` (`server/claim-reputation.mjs:192-205`), `noteReadyWork` wake (`work-claim-routes.mjs:721`) | **NECESSARY** — lane-open signal agents decide on; reputation prices releases | ~1/lifecycle on the release path |
| `reassigned` | `server/work-claim-routes.mjs:1239-1244` (+`attention: assigned` + wake) | timeline (`src/board-ui.js:136`), digest, reputation position transfer (`server/claim-reputation.mjs:207-214`), wake to target | **NECESSARY** — ownership change; new owner's decision input | ~0.1/lifecycle (rare) |
| `renewed` | `server/work-claim-routes.mjs:1295` (`coalesce: true`) | timeline text only (`src/board-ui.js:135`), digest, export — **no wake, no reputation signal** (`server/claim-reputation.mjs:238-240` names it "the correct escape hatch… no signal"), no Updates attention | **NOTIFICATION-ONLY** — new lease is readable from the claim row; zero decision consumers | ~0.5-1/lifecycle → fully suppressible (Top-5 #5) |
| `lease_expired` | `server/work-claim-routes.mjs:743` (read-path sweep), `server/claim-pr-sync.mjs:529` (per-minute sweep) | timeline (`src/board-ui.js:133`), digest, reputation `claim_flaked` (`server/claim-reputation.mjs:216-225`), one wake per expiry to previous owner (`:743-748` / `:claim-pr-sync.mjs:533-537`) | **NECESSARY** — flake penalty + owner wake are decision inputs | ~0.3/lifecycle; read-path emission is the reducible part (Top-5 #4) |
| `pr_merged` | `server/claim-pr-sync.mjs:313` (`settled.action`) | timeline (`src/board-ui.js:137`), digest, analytics `pr_merged` + minutes-claim-to-merge (`map-room-event.mjs:262-268`) — reputation: explicitly no signal (`claim-reputation.mjs:241-243`) | **NOTIFICATION-ONLY** — fact already in `data.pullRequest` on the row; decision (settle) happened before the event | ~0.5/lifecycle on PR-linked claims |
| `pr_closed` | `server/claim-pr-sync.mjs:313` | timeline (`src/board-ui.js:138`), digest | **NOTIFICATION-ONLY** | ~0.2/lifecycle |
| `ci_changed` | `server/claim-pr-sync.mjs:340-352` (`reason: ci_changed`, `ciState`) | timeline ("CI failed/passed", `src/board-ui.js:116`), digest, wake to owner on success/failure (`claim-pr-sync.mjs:349-351`), `wakeNamedReviewers` (`:352`) — Updates' `claim_ci_failed` attention is dead (no producer, see above) | **NOTIFICATION-ONLY as an event row** — the decision (fix CI / review) flows through the wake queue (`server/agent-heartbeats.mjs:538`), not the event log; CI state is in `item.ci` | pending-churn is the reducible part (Top-5 #2): ~1-2 per PR-linked lifecycle |
| `deleted` | `server/land-queue.mjs:856` (`#emitClaimDeleted`, names dependents) | timeline (generic "updated" line), digest, export | **NECESSARY** — names `dependents` so stranding is visible/recoverable (`land-queue.mjs:850-851`) | rare; ~0.05/lifecycle |
| `premise_flagged` | `server/work-claim-routes.mjs:1359-1363` (+ wake to owner) | timeline, digest, wake | **NECESSARY** — owner's defend/correct decision | rare |
| `premise_cleared` | `server/work-claim-routes.mjs:1343` | timeline, digest | **NOTIFICATION-ONLY** | rare |
| `closed` | `server/work-claim-routes.mjs:528`, `:1183` | timeline, digest, reputation settles lifecycle (`server/claim-reputation.mjs:189` closePosition via done; closed terminals settle) | **NECESSARY** — terminal state; reputation closes positions on it | ~1/lifecycle on the close path |

Also on the claim path: **receipt card** — `message.posted` with
`kind: "receipt_card"`, emitted by `postReceiptCard`
(`server/receipt-cards.mjs:61-94`) on every `state_changed`→`done` with
`deliveryMode ∈ {result, merged, production}` (`server/work-claim-events.mjs:196-201`).
It duplicates the `done` transition one line above it (same `claimUpdateText`
renders the done event). Consumers: timeline, digest, export. Classification:
**NOTIFICATION-ONLY duplicate** — consolidation candidate (Top-5 #3).

## Message lifecycle: `message.*`

Messages are **state-carrying, not notification-only**: the `messages` SQLite
table is double-written with the event log in the command transaction
(`server/messages-store.mjs:1-8`, MSG-1), and read paths still use the
projection (`state.messages`, mutated by the recorders in `src/events.js`).
Skipping a message event diverges state. The projection recorders:

- `message.posted` — chat posts from `store.command` (`server/store.mjs:4797`
  insert), receipt cards (`server/receipt-cards.mjs:79`), code drops
  (`server/code-drops.mjs:267,353`), inbox (`server/inbox.mjs:1350`),
  permission-request notes (`server/member-permission-requests.mjs:127`).
  Consumers: timeline, SSE (`server/http.mjs:849`), webhook fan-out
  (`server/agent-plugin-store.mjs:1151`), activity feed @mentions/replies
  (`server/activity.mjs:113-163`), mention wakes (`server/store.mjs:4843,
  5019`), digest/tail (`client/room-coord.mjs:356,437`), export
  (`server/room-export-html.mjs:88`), analytics (`map-room-event.mjs:389`).
  **NECESSARY** — chat state + every human/agent decision surface reads it.
  ~1/event per post, irreducible (the room's actual content).
- `message.edited` — projection edit (`src/events.js:1308-1326`).
  **NECESSARY** (body is truth). ~0.1/post.
- `message.deleted` — tombstone (`src/events.js:1328-1336`).
  **NECESSARY**. Rare.
- `message.redacted` — body scrub (`src/events.js:1353-1373`).
  **NECESSARY** (compliance/state). Rare.
- `message.reaction_set` — projection reactions map (`src/events.js:1421`).
  Consumers: activity feed (`server/activity.mjs:165`), timeline render.
  **NECESSARY for state fidelity** (messages table + projection both carry
  reactions); decision value low.
- `message.pinned` / `message.unpinned` — projection pins (`src/events.js:2301,
  2326`); pins route reads projection; emitted from `server/pins.mjs:77`,
  `src/app.js:4878`. **NECESSARY for state fidelity** (pin list is the
  projection); decision value low.

No message-lifecycle event is skippable under the fast-path law: the event
row IS part of the write path for chat state (unlike `work_claim.updated`,
which `src/events.js:1724` proves is projection-inert).

## Top-5 event-reduction opportunities beyond `?fast=1`

`?fast=1` already covers machine-to-machine claim traffic (5 → 0 events).
These five target the **default path** — where humans and digest readers
still need visibility — ranked by estimated saving per claim lifecycle.

1. **Extend the note-only coalescing window (60 s → 10 min, or one note event
   per transition pair).** `CLAIM_EVENT_COALESCE_MS`
   (`server/work-claim-events.mjs:157`) bounds note-only `state_changed`,
   `reviewed` attestations, and `renewed` to 1/60 s/claim. A chatty lane
   posting progress notes every minute still emits 1/min/claim — the largest
   *unbounded* term in the default path. The timeline already collapses
   claim updates per claim per 10 min (`collapseClaimUpdates`,
   `src/board-ui.js:145`), so a 10-min event window loses no timeline
   information. **Estimated saving: ~1–3 events/lifecycle** in note-heavy
   lanes (measured 6.5 baseline is note-light; swarm-100 lanes that chatted
   progress ran higher).

2. **Emit `ci_changed` only on terminal transitions (success/failure), not
   pending churn.** `server/claim-pr-sync.mjs:340-352` emits on every CI poll
   that changes state; intermediate `pending` rows are pure churn. The CI
   state lives in `item.ci`; the decision (owner wake) already fires on
   terminal states via `enqueueClaimWake` (`:349-351`), independent of the
   event row. **Estimated saving: ~1–2 events per PR-linked lifecycle**
   (every pending→success cycle sheds one row; multi-poll CI runs shed more).

3. **Fold the done receipt card into the `done` transition event.**
   `state_changed`→`done` and the `message.posted` receipt card
   (`server/receipt-cards.mjs:61-94`) are two rows for one transition; the
   timeline renders the done event directly above the card
   (`src/board-ui.js:141` vs the card body "closed as …"). Skip the card when
   the room has the done event (i.e., non-fast writes), or move the
   receipt-only fields (`evidence`, `closedBy`, `pullRequestUrl`) onto the
   `work_claim.updated` data. **Estimated saving: 1 event per completed
   claim** (~0.6–0.8/lifecycle at typical completion rates).

4. **Emit `lease_expired` only from the per-minute PR-sync sweep, not from
   read-path sweeps.** Default-mode reads run `sweepRoom` and emit one
   `lease_expired` event + one wake per lapsed lease *per read*
   (`server/work-claim-routes.mjs:737-748`); the PR-sync cron already sweeps
   with identical semantics (`server/claim-pr-sync.mjs:506-547`,
   "#1526 B2" comment). The event/wake pair is NECESSARY (flake reputation +
   owner wake), but the *read-path emission* is duplicate coverage — one
   canonical emitter (the per-minute sweep) preserves every consumer.
   **Estimated saving: all read-amplification** — 1 event + 1 wake per lapsed
   lease per default-mode read, unbounded in poll-heavy rooms (this is the
   "reads emit writes" term the fast-path doc prices).

5. **Suppress `renewed` events entirely.** Verified zero decision consumers:
   no wake (`server/work-claim-routes.mjs:1295` emits none), no reputation
   signal (`server/claim-reputation.mjs:238-240` explicitly: renewal is the
   escape hatch, "no signal"), no Updates attention (dead producer set, see
   above). The new `leaseExpiresAt` is readable from the claim row; the
   timeline text ("X renewed Y", `src/board-ui.js:135`) is the only
   consumer-facing loss. **Estimated saving: ~0.5–1 event/lifecycle** on
   claims that renew (long-lived lanes renew multiple times; coalescing
   already caps at 1/60 s, but the rows buy nothing).

### Read-side bonus (not an event row, found during the audit)

`server/updates.mjs:287-295` scans the last 200 `work_claim.updated` rows
with `json_extract` on **every** Updates call, but (see "Dead consumer"
above) the `CLAIM_ATTENTION` filter can never match a produced row. Deleting
or gating that scan removes pure query cost; it changes no behavior.

## Method note

- Emitters found via `emitWorkClaimEvent` call sites (`server/`), land-queue
  `#emitClaimDeleted`, `appendRoomEvent`/`postReceiptCard` paths, and the
  chat `store.command` insert (`server/store.mjs:4797`).
- Consumers found via type-string grep (`work_claim.updated`,
  `message.posted`, etc.) across `server/`, `src/`, `client/`, plus
  per-action grep (`"renewed"`, `"deleted"`, attention values).
- Savings are estimated against the measured 6.5 events/lifecycle baseline
  (fast-path doc) and the coalescing/wake semantics in the code cited above;
  they need lane-level measurement before build.
