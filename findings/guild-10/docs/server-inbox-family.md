# The inbox/* subsystem

_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09 from module header comments,
export lists, and `git grep` caller evidence. Each module below had no dedicated doc page.
Purpose/invariants/gotchas are quoted from the module's own header comment where present._

## `server/inbox-agent-routing.mjs`  (181 lines)

**Purpose.** @agent mention routing for the inbox (lane C, inbox-agent-collab). When a message or note mentions @agent, this module decides where it goes: direct delivery to the named agent, or escalation to a human (or another agent) first — per a per-agent policy. Every routing decision is journaled so a mention can never vanish silently; escalated records stay open until resolved. extractAgentMentions is the pure parser: "@claude look" → ["claude"]. Email-style user@host matches are skipped (a mention is not preceded by a word character). Pure, in-memory, dependency-free, deterministic; frozen outputs. Clock and id generator are injected so fixtures control time and ids.

**Exports:** `RoutingError`, `createAgentRouter`, `defaultPolicy`, `extractAgentMentions`, `routingModes`, `routingStatuses`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/inbox-collab-store.mjs`, `tests/audit-wave-3b.test.js`, `tests/inbox-agent-routing.test.js`, `tests/mention-lifecycle.test.js`, `tests/routing-address-properties.test.js`

## `server/inbox-approval.mjs`  (160 lines)

**Purpose.** Human-in-the-loop approval queue for agent-drafted outbound (lane C, inbox-agent-collab). An agent proposes a draft; nothing sends until a human approves it. The queue is the paper trail: propose → approve / requestEdits → resubmit → approve | reject, every edge journaled with who and when. Only human identities may approve, request edits, or reject — an agent can never clear its own draft. Pure, in-memory, dependency-free, deterministic; frozen outputs. Clock and id generator are injected so fixtures control time and ids.

**Exports:** `ApprovalError`, `approvalStatuses`, `createApprovalQueue`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/inbox-collab-store.mjs`, `server/supervision-routes.mjs`, `tests/audit-wave-3b.test.js`, `tests/inbox-approval.test.js`

## `server/inbox-assign.mjs`  (141 lines)

**Purpose.** Thread assignment journal (lane C, inbox-agent-collab). Who owns a thread right now — an agent or a human — so parallel collaborators never work the same thread blind. assign/release/claim with a full event journal per thread; additive alongside server/inbox-handoff.mjs (which hands a thread to* a named agent with context; this module owns the durable agent-or-human assignment state and releases). Pure, in-memory, dependency-free, deterministic; frozen outputs. Identity and validation raise AssignError (coded, never silent). Clock and id generator are injected so fixtures control time and ids. Clock is injected so fixtures control time.

**Exports:** `AssignError`, `assigneeKinds`, `assignmentStatuses`, `createAssignmentJournal`, `identityOf`, `threadIdOf`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/inbox-agent-routing.mjs`, `server/inbox-approval.mjs`, `server/inbox-collab-store.mjs`, `server/inbox-collision.mjs`, `server/inbox-internal-notes.mjs`, `tests/inbox-assign.test.js`

## `server/inbox-collab-routes.mjs`  (389 lines)

**Purpose.** Lane C inbox collaboration HTTP routes (task RC-2026-09-18-011). Room-scoped handlers mounted by server/http.mjs inside the authenticated room block, after the shared credential, fence and rate-limit checks. All nineteen operations live under /api/rooms/{roomId}/collab/* and are documented in docs/openapi.yaml (the route-docs gate requires it). Error contract: the pure Lane C modules throw typed errors (AssignError, NoteError, CollisionError, ApprovalError, RoutingError) carrying a stable .code but no HTTP status; collabHttpError maps those codes to statuses and wraps them in ServiceError so the outer handler returns stable 4xx codes instead of 500. The handoff journal already throws ServiceError, which passes through untouched. Unknown errors are rethrown for the generic 500 path — never wrapped, so no internal detail leaks. Identity: the caller is the authenticated room member ({kind, 

**Exports:** `collabHttpError`, `handleInboxCollab`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/routes-inventory.mjs`, `scripts/runtime-package.mjs`, `scripts/untested-modules-lint.mjs`, `server/http.mjs`, `server/work-claim-routes.mjs`

## `server/inbox-collab-store.mjs`  (767 lines)

**Purpose.** Lane C inbox collaboration: durable, room-scoped HTTP backing store. Task RC-2026-09-18-011. The six pure Lane C modules (server/inbox-assign.mjs, server/inbox-internal-notes.mjs, server/inbox-collision.mjs, server/inbox-approval.mjs, server/inbox-agent-routing.mjs, server/inbox-handoff.mjs) are read and reused but never modified here. Each owns an in-memory journal; this wrapper keeps one lazy journal set per room, persists every mutation to SQLite (write-through), and replays the persisted rows onto fresh journals after a restart. Replay model: the persisted rows are the *operation log*, not just the final records — some transitions are lossy in the record alone (e.g. a forced assignment takeover drops the intermediate assignee from history), so replay re-runs the exact op sequence. Exactness of time and ids: every journal is built with an injected clock and id source; while live, this

**Exports:** `InboxCollabStore`, `inboxCollabSchema`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `scripts/untested-modules-lint.mjs`, `server/store.mjs`

## `server/inbox-collision.mjs`  (149 lines)

**Purpose.** Concurrent draft/reply detection for the inbox (lane C, inbox-agent-collab). Two agents (or an agent and a human) composing on the same thread at once get a soft lock: advisory, expiring, never a hard gate on sending — the failure this module prevents is silent last-writer- wins, not slowness. detectCollision names the other editor and ships a merge hint so the pair can reconcile before either sends. Pure, in-memory, dependency-free, deterministic; frozen outputs. Clock and id generator are injected so fixtures control time and ids.

**Exports:** `CollisionError`, `createCollisionTracker`, `defaultLockTtlMs`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/inbox-collab-store.mjs`, `tests/inbox-collision.test.js`

## `server/inbox-internal-notes.mjs`  (169 lines)

**Purpose.** Internal side-notes on inbox threads (lane C, inbox-agent-collab). Agents and humans leave private context on a thread — what was tried, what the sender really wants, what not to promise — that must never reach the channel. The contract is enforced in code, not just convention: 1. Notes live only in this journal; no method here builds or returns a channel payload, so there is no accidental path from note to wire. 2. assertNoInternal(payload) recursively scans any outbound-bound value and throws note_contract_violation if it finds an internal-flagged node or a banned internal field name — the channel layer calls it before sending and fails closed. 3. stripInternal(payload) deep-copies a value with all internal material removed (defense in depth for callers that must pass untrusted aggregates through). Pure, in-memory, dependency-free, deterministic; frozen outputs. Clock and id generator 

**Exports:** `NoteError`, `assertNoInternal`, `createInternalNotes`, `internalFieldNames`, `stripInternal`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/inbox-collab-store.mjs`, `tests/inbox-collab-http.test.js`, `tests/inbox-internal-notes.test.js`

## `server/inbox-search.mjs`  (66 lines)

**Purpose.** Full-text search (A011). A pure in-memory inverted index over message envelopes: indexMessages builds the index, search runs a query against it with term-frequency ranking. Pure, dependency-free, deterministic; frozen outputs. The caller decides which text fields to index (subject + body by default). Store integration is a later slice.

**Exports:** `indexMessages`, `search`, `SearchError `

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/inbox.mjs`, `tests/inbox-search.test.js`

## `server/inbox-stitch-store.mjs`  (477 lines)

**Purpose.** Cross-channel thread stitching (task #19) — the stitch graph store. Hash-only persistence: stitch tables carry HMAC keys, channel names, and opaque source ids. Raw emails, handles, and display names are NEVER written here; they are read from envelopes in memory and only hashes cross the store boundary. The per-installation salt is injected, never stored. Design: docs/CROSS-CHANNEL-THREAD-STITCHING.md (PR #543).

**Exports:** `InboxStitchStore`, `inboxStitchSchema`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/inbox-stitch.mjs`, `server/inbox.mjs`, `server/store.mjs`, `tests/audit-wave-low-a.test.js`, `tests/inbox-stitch.test.js`

## `server/inbox-stitch.mjs`  (304 lines)

**Purpose.** Cross-channel thread stitching (task #19) — pure functions. Identity resolution across Gmail/Telegram/X channels with hash-based keys only: raw emails, handles, and display names are never persisted by the stitch layer. The salt is an injected dependency (see stitchConfigFromEnv); the store module (server/inbox-stitch-store.mjs) owns persistence. Design: docs/CROSS-CHANNEL-THREAD-STITCHING.md (PR #543). Stitching is a read-path enrichment: envelopes stay channel-native, the stitch layer only produces a stitch graph (stitched_thread_id -> [{channel, sourceId}, ...]) computed from participants, never from message bodies. Everything here is pure and deterministic: no store reads or writes, no network, no randomness. Frozen outputs; malformed inputs throw StitchError.

**Exports:** `STITCH_DEFER_REASONS`, `STITCH_ENABLE_BINDING`, `STITCH_EPOCH`, `STITCH_ID_TYPES`, `STITCH_METRICS`, `STITCH_SALT_BINDING`, `STITCH_SPLIT_REASONS`, `candidateKeys`, `deferReason`, `nameSimilarity`, `normalizeIdentifier`, `scorePair`

**Callers/importers (git grep HEAD):** `cloudflare/room.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server.mjs`, `server/inbox-stitch-store.mjs`, `tests/audit-wave-3b.test.js`, `tests/audit-wave-low-a.test.js`, `tests/inbox-stitch-fuzz.test.js`, `tests/inbox-stitch.test.js`

## `server/inbox-threads.mjs`  (67 lines)

**Purpose.** Thread view (A010). A pure thread builder: given a list of message envelopes, it groups them by threadId, rebuilds the reply tree from inReplyTo references, and flattens each thread with depth so the UI can indent replies. Pure, dependency-free, deterministic; cycles and dangling references are tolerated (they become top-level), never throw. No store reads or writes — the caller supplies the messages; store wiring is a later slice.

**Exports:** `buildThreads`, `threadFor`, `ThreadError `

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/inbox.mjs`, `tests/audit-wave-low-a.test.js`, `tests/inbox-threads.test.js`

## `server/inbox-transport.mjs`  (287 lines)

**Purpose.** Fixture qualification driver. Real providers require a separately reviewed adapter, credentials, capabilities and external-send authority.

**Exports:** `FixtureChannelSender`, `GmailSender`, `SyntheticInboxTransport`, `buildGmailRawMessage`, `buildTelegramDirectRequest`, `directSendChannels`, `gmailCredentialsFor`, `sendTelegramDirect`

**Callers/importers (git grep HEAD):** `scripts/account-workspace-check.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/inbox-browser-check.mjs`, `scripts/inbox-sandbox.mjs`, `scripts/runtime-package.mjs`, `server/action-classes.mjs`, `server/http.mjs`, `server/routes/inbox.mjs`, `tests/channel-import.test.js`, `tests/inbox-outbox.test.js`
