# Agent handoff protocol (task 23)

## What this is

When triage returns `needs_human`, the thread doesn't sit in a queue — it is
handed to a named agent (or human) with a compact structured context packet:
summary, open questions, pending actions, and channel constraints, alongside
the source ids, channel, SLA clock, and triage reasons the receiver needs to
pick the thread up. The handoff is journaled, so nothing closes unowned —
the same claim/receipt discipline the room uses for work.

## Packet schema (v1)

`server/inbox-handoff.mjs` — `buildHandoffPacket(input)` validates and
freezes one packet. The shape is strict: unknown fields are rejected.

| field | type | rule |
|---|---|---|
| `packetVersion` | int | `1` |
| `handoffId` | string | 1..128 agent-id chars; assigned by the journal |
| `createdAt` | ISO ts | assigned by the journal |
| `threadId` | string | 1..1024 |
| `channel` | string | 1..64 |
| `sourceIds` | string[] | 1..100 source ids, deduped |
| `sender` | `{ id, label }` | 1..512 / 1..256 |
| `subject` | string | 1..500 |
| `occurredAt` | ISO ts | latest message in the thread |
| `sla` | object? | `{ status, targetMs?, label?, elapsedMs?, awaitingSince?, deadlineAt? }`; `status` ∈ `on_track`/`at_risk`/`breached`/`responded`/`not_applicable`/`unknown_channel` |
| `triage` | `{ action, reasons }` | `action` ∈ the `inbox-triage.mjs` actions; reasons ≤ 20 × 256 chars |
| `summary` | string? | ≤ 2000 chars — the prior summary, authored by the handing party |
| `openQuestions` | string[]? | ≤ 5 × 500 chars |
| `pendingActions` | string[]? | ≤ 10 × 300 chars |
| `excerpt` | string? | ≤ 500 chars — the latest-message excerpt the thread view already shows |
| `from` / `to` | string | 1..128 agent-id chars; `from` defaults to `owner` |
| `constraints` | object | computed by `channelConstraintsOf(channel)`: `channel`, `known`, `tone`, `maxReplyChars`, `threadIdentity`, `readReceipts`, `notes[]` |

The digest's inert handoff action descriptor carries a context of
`{ threadId, channel, sourceIds, senderId, senderLabel, subject, occurredAt,
sla, reasons }` — the journaled packet is its superset (same field names),
so a client can journal a handoff straight from the morning brief.

## PII rule

**No raw PII beyond what the inbox already stores.** The packet references
thread/source ids and sender labels the thread view already shows. Free-text
fields are authored by the handing party or copied from an already-visible
excerpt — all hard-capped, and nothing here fetches a new message, resolves
a new identity, or persists anything outside the handoff journal.

## Channel constraints

`channelConstraintsOf(channel)` tells the receiver how it may reply:

| channel | tone | maxReplyChars | thread identity | notes |
|---|---|---|---|---|
| telegram | chat-concise | 4096 | telegram chat — replies stay in the same chat | bot replies stay in the bot's own chat; no contact sync |
| whatsapp | chat-concise | 4096 | whatsapp conversation | — |
| email | formal | none | email thread (In-Reply-To/References) | changing the subject starts a new thread |

Unknown channels are explicitly `known: false` with the note *"do not reply
until the owner confirms the surface"* — a guessed surface is worse than
none.

## Lifecycle

`open` → `accepted` → `completed`, or `open`/`accepted` → `released`.
`completed` and `released` are terminal and immutable; illegal edges are
refused with 409, never silently rewritten. Every transition appends
`{ status, at, note? }` to the handoff's history.

One open handoff per thread: a repeat create for the same thread returns the
existing receipt with `duplicate: true` (HTTP 200 vs 201), so a thread is
always owned by exactly one open handoff. `GET /api/inbox/handoffs` (optional
`?status=`) is the "nothing closes unowned" sweep.

## Wiring (all additive)

- `server/inbox-handoff.mjs` — packet builder/validator, constraints, and the
  `InboxHandoffJournal` (sqlite `inbox_handoffs` table).
- `server/store.mjs` — `store.handoffs`; schema exec'd in the writer block;
  `verifySchema({ allowAbsent: true })` on read-only opens; `recovery.mjs`
  runs the journal's offline integrity check.
- `server/writer-fence.mjs` — `inbox_handoffs` in `unfencedAdditiveTables`
  (purely additive, no schema version bump; older writers have no code path
  to it).
- `server/inbox.mjs` — `Inbox.handoff()` builds the packet from the recent
  thread view (same reading-view gate as the thread list), `Inbox.handoffs()`
  lists, `Inbox.handoffTransition()` moves state.
- `server/http.mjs` — `POST /api/inbox/handoffs`, `GET /api/inbox/handoffs`,
  `POST /api/inbox/handoffs/transition` (account session + CSRF + rate limit).
- `docs/openapi.yaml` — the three routes documented.
- Packaging: registered in `scripts/runtime-package.mjs`,
  `scripts/candidate-runtime-fixture.mjs`, `tests/runtime-package.test.js`.

Nothing touches login/auth (quill's lane); no sends, no pushes, no scheduler.

## Open taps (John's call)

- Whether a handoff should also notify the named agent (Telegram ping?
  in-app only?) — the journal is the record; notification is a later slice.
- Who the named agents are: `to` is a free-form agent id today; a lane
  registry for inbox agents (mirroring the room's lane registry) is future
  work.
- The digest's handoff tap currently describes the packet; wiring the tap to
  `POST /api/inbox/handoffs` in the UI is client work.
