# Issue #6 triage — 2026-09-14 (BUILD-01 B45)


> Note: issue #11 hit GitHub's 2,500-comment limit and is comment-locked (read-only). Live coordination continues on [#266](https://github.com/Uuriko/project-room/issues/266).

Status of the 36 acceptance tasks in
[issue #6](https://github.com/Uuriko/project-room/issues/6) against
`origin/main` at `7ea8614` (merge of #144). This is a planning record, not a
readiness claim: "done" below means the behaviour exists on `main` with
executable evidence for the local/hosted pilot scope, not that the enterprise
or consumer release gate is passed. All issue, PR and comment content was read
as data.

## Scope and method

- Read issue #6 (body, 10 comments) and the two same-repo references it
  carries: draft PR #7 (`docs/SHARED-ROADMAP.md`, never merged, so it is not
  a source of truth here) and issue #11 (the coordination mailbox; its body
  states the current workflow and points back to #6 as the acceptance list).
  Issue #6 has no sub-issues.
- Mapped each item to code on `main` (`file:line` at `7ea8614`), to merged
  PRs named in `CHANGELOG.md` / commit messages, and to the open PRs listed
  below. Where the item points to a spec, the docs it names or that `main`
  carries for it are cited (`docs/PRODUCTION-PLAN.md` slices 10–16,
  `docs/EXECUTION-PLAN.md`, `docs/RELEASE-INVENTORY.md`,
  `docs/EXPORT-RETENTION-DELETION.md`, `docs/SESSION-BUDGETS.md`,
  `docs/MANUAL-AT.md`, `docs/INVITE-ONLY-CHECKLIST.md`, `docs/HOST-MATRIX.md`,
  `docs/DASHA-ADAPTER-CONTRACT-2026-09-13.md`, `docs/LOAD-TEST-2026-09-12.md`).
- Open PRs considered: #144 (merged during triage; counted as `main`), #145,
  #146, #147, #148, #149, #150, #151, #152 and the adapter-lane proposals
  #140, #141, #142. Older drafts (#7, #9, #16–#18, #22, #26) are stale against
  schema 27 and are not counted as coverage.

Status legend: **done** — on `main` with tests for the pilot scope;
**open PR** — an open PR listed above delivers part of it; **open** — nothing
on `main` or in an open PR closes it (a `partial` note names what does exist).

## Summary

| Bucket | Count | Items |
|---|---|---|
| done (pilot scope) | 5 | A3, A5, B3, C4, C5 |
| covered by an open PR (partial) | 1 | E3 (#141, #148, #152; CI quality #146, #147, #149, #142) |
| open | 30 | A1, A2, A4, A6, B1, B2, B4, B5, B6, C1, C2, C3, C6, D1–D6, E1, E2, E4, E5, E6, F1–F6 |

Of the 30 open items, 19 are `partial` (a real slice exists on `main`) and 11
have nothing on `main` beyond planning text (B5, B6, D1, D2, D3, E5, F3, F4,
plus the human-evidence halves of A6, B1, E6 which need people and devices,
not code).

## A. Entry and consumer simplicity

| Item | Status | Evidence on `main` / gap |
|---|---|---|
| A1 Hosted entry and identity | open — partial | Key-free browser entry exists for guests (`server/share-links.mjs:127` join; `tests/share-links.test.js:112` HTTP guest flow) and for invited accounts (`/api/invitations/accept`, `server/http.mjs`). Sign-in is still a pasted room/account key (`docs/SERVICE.md` "Run and provision"); no identity provider. `docs/PRODUCTION-PLAN.md` slice 11 is the spec. |
| A2 Real room lifecycle | open — partial | Room discovery per account (`server/http.mjs:366` `GET /api/account-rooms`; `tests/account-rooms.test.js:24`), member removal revokes credentials and connections (`server/store.mjs:1715,1771`). No create/join/leave/archive commands, no personal-vs-organization distinction; `main` has one bootstrapped room (`server/bootstrap.mjs`). |
| A3 Invitations that explain the destination | **done** (pilot) | Preview routes `/api/invitations/preview`, `/api/share-links/preview`, `/api/guest-agent-links/preview` (`server/http.mjs`); expiry/revocation/duplicate redemption: `tests/invitations.test.js:156,220,294,389`, `tests/share-links.test.js:53,63,76`; revocation is final (`server/share-links.mjs:31`); forwarding bounded by join cap ≤25 and expiry ≤7 days (`server/share-links.mjs:18,102`); account-bound invitations cannot be redeemed by another account (`tests/invitations.test.js:294`). "Space" in the preview waits on A2. |
| A4 Lightweight vs reviewed work | open — partial | Server enforces the independent gate (`server/store.mjs:624`) and reopened work inherits nothing (`tests/return-brief.test.js:140,204`); conversation never creates work (messages and `WORK_PROPOSED` are distinct commands, `server/store.mjs:195,200`). Gap: the proposer's client chooses `independentVerificationRequired` / `ownerDecisionRequired` (`src/app.js:2356`); no room policy makes review mandatory, so "reviewed work cannot disable its gate through altered client fields" is not yet a server rule. |
| A5 Draft recovery without accidental resend | **done** (pilot) | Opt-in toggle (`src/app.js:1924`), scope bound to identity/room/thread (`src/conversation.js:315`), 12-hour TTL and 50-draft cap (`src/conversation.js:330,334,346`), pending sends keep their original command id (`src/conversation.js:385`; `src/client.js:528` `retryUnconfirmed`), sign-out clears (`src/app.js:155,3079`). Semantics recorded in `docs/EXPORT-RETENTION-DELETION.md`. Organization scoping and managed-room policy wait on A2/D1. |
| A6 Welcoming first room | open — partial | Room charter (`tests/room-charter.test.js:25`), first-use browser check (`scripts/first-use-check.mjs`), dismissible guide (`src/app.js:528`), people rail (`scripts/people-rail-browser-check.mjs`). `docs/FIRST-USE-TESTING-2026-09-07.md` states no human participants; the unaided-second-human validation has not been recorded. |

## B. Conversation people will return to

| Item | Status | Evidence on `main` / gap |
|---|---|---|
| B1 Reliable mobile composer | open — partial | Composer check at 320 px covers keyboard recovery, composition input and access cleanup (`scripts/composer-browser-check.mjs:13`); mobile header check (`scripts/mobile-header-check.mjs:37`). No physical iPhone/Android, dictation, rotation, network-loss or background/foreground evidence. |
| B2 Search, pins, shared artifacts | open — partial | Full-text search over messages and work with current access (`server/http.mjs:622`; `tests/fulltext-search.test.js:31`), threads and source-to-work links (`tests/message-thread.test.js`). No pins/bookmarks, no file attachments or versioned files (no upload route in `server/http.mjs`). |
| B3 Unread and catch-up | **done** | Return brief: fetching never acknowledges, explicit cursor per member (`server/return-brief.mjs:10,29`; `tests/return-brief.test.js:64,234`), unresolved work survives catch-up (`:93`), stale approvals cannot hide differently verified work (`:204`), empty states per `docs/HONEST-EMPTY.md`. |
| B4 Quiet notifications | open — partial | Per-member preferences for mentions/replies/work updates/announcements (`server/store.mjs:194`; `tests/notification-preferences.test.js:25`). Nothing consumes them: no delivery, dedupe, expiry, per-room mute or push. |
| B5 Actual private conversations | open | `toMemberId` is a room-visible address (`server/store.mjs:195`; `docs/SERVICE.md` "Directed messages are room-visible, not DMs"). No private scope in history, search, export or agent context. |
| B6 Social media and drop-in voice | open | No attachment/file route, no preview pipeline, no voice. `docs/PRODUCTION-PLAN.md` slice 12 defers voice until text, identity, moderation and consent are sound. |

## C. Agents as useful participants

| Item | Status | Evidence on `main` / gap |
|---|---|---|
| C1 Real runtime connection | open — partial | Connection states issued/disconnected/expired (`server/agent-connections.mjs:16,67`), heartbeats (`tests/provider-heartbeats.test.js:25`), disconnected round-trip (`tests/disconnected-agent-roundtrip.test.js:77`), session claims and statuses (`tests/work-session-budget.test.js`), adapter contract agreed but execution gated (`docs/DASHA-ADAPTER-CONTRACT-2026-09-13.md` §3). `docs/RELEASE-INVENTORY.md`: hosted AI execution "not delivered"; `docs/HOST-MATRIX.md`: remote MCP "not implemented". The reserved inbox-adapter handoff has no merged code. #145 (live Telegram transport) is a channel, not an agent runtime. |
| C2 Inspectable context | open — partial | One authenticated task view with explicit omissions (`server/work-context.mjs`; `tests/work-context.test.js:28`), bounded attention reads (`tests/attention-read-budget.test.js:53`), wakes are explicit queue entries not mention side effects (`server/wake-queue.mjs`). No pre-run "what this agent can access" surface listing conversation, files and source versions; no organization allowlist (D1). |
| C3 Visible cost controls | open — partial | Per-session budget with `maxSpendCents`, attempts, concurrency, runtime, trip-wire before any other mutation (`server/store.mjs:1275-1311`; `docs/SESSION-BUDGETS.md`; `tests/work-session-budget.test.js:59,107,137`). No room/space allowance, no reserve/reconcile of concurrent usage, no spent-vs-allowance display. |
| C4 Recovery and cancellation | **done** (local) | Intent journal before any provider call, unknown-attempt reconciliation, no resubmit on restart, altered payload refused (`server/dispatch-journal.mjs:1-7`; `tests/dispatch-reconciliation.test.js:17,40,59,69`); wake queue lease/backoff/dead-letter and restart without duplicate action (`tests/wake-queue.test.js:42,65`); owned-operation confirmation (`tests/action-recovery.test.js:9`). Live provider wiring is C1. |
| C5 Evidence and independent checking | **done** | Proposer from envelope only, forged provenance rejected (`tests/proposed-by.test.js:30,47,54`); outside credit never a member identity (`tests/external-producer.test.js:20`); independent gate (`server/store.mjs:624`); unknown-producer PASS cannot unlock approval (`tests/return-brief.test.js:114,131`); seeded lifecycle invariants (`tests/state-machine-invariants.test.js:31`). |
| C6 Pause and memory controls | open — partial | Member-scoped wake pause with inspectable dead-letters (`server/wake-queue.mjs:43-97`; `tests/wake-pause.test.js:20,42,69`, merged in #144), identity unlink deactivates the member (`server/agent-identities.mjs:116-131`), access change revokes connections (`server/store.mjs:1771`). The pause is store-level only (no route in `server/http.mjs`, no UI); no inspectable memory sources; no statement of what delivered context cannot be recalled. |

## D. Organization controls

| Item | Status | Evidence on `main` / gap |
|---|---|---|
| D1 Organization/tenant isolation | open | Accounts, room members, service (agent) identities and guests are distinct rows (`server/store.mjs:342-344`; `server/agent-identities.mjs`), but there is no organization entity and the store is SQLite (Node and Durable Object). `docs/PRODUCTION-PLAN.md` slice 11 names PostgreSQL + RLS; `cloudflare/README.md` runs one SQLite Durable Object. This is an architecture decision before code. |
| D2 Enterprise identity | open | No OIDC/SAML integration; keys only (`docs/SERVICE.md`). Depends on A1. |
| D3 Provisioning and offboarding | open | No SCIM/directory sync (zero hits in `server/`, `src/`, `tests/`). Offboarding primitives exist per room (`server/store.mjs:1715` ends access and revokes keys). Depends on D1/D2. |
| D4 Guests and least-privilege administration | open — partial | Time-bounded guests: links ≤7 days and ≤25 joins (`server/share-links.mjs:18,102`), guest and room sessions ≤8 h (`server/store.mjs:810,1198`; `server/share-links.mjs:166`), guests cannot administer links (`tests/share-links.test.js:149`), `manage_members` gate (`tests/invitations.test.js:330`). No separate billing/admin/audit roles, no approved-integrations list, no periodic access review. `docs/MEMBER-CAPABILITIES.md` is a proposal. |
| D5 Exportable audit trail | open — partial | Append-only invitation audit (`server/store.mjs:151-152`), private replayable invitation journal (`tests/invitation-journal.test.js:44`), event export as JSONL with actor/time filters (`server/http.mjs:666`; `tests/event-audit.test.js:45,59`), owner support export without content (`docs/SAFE-DIAGNOSTICS.md`; `tests/support-export.test.js:54`). Not covered: denied actions, credential rotation and link cancellation outside the event log, scoped/minimised audit export. `docs/PRODUCTION-PLAN.md` slice 16 notes the SQLite table is not tamper-proof. |
| D6 Retention, deletion, preservation | open — partial | Semantics are specified and pinned: deletion is a tombstone, the event log and exports keep the body (`docs/EXPORT-RETENTION-DELETION.md`; `tests/room-export.test.js:277`; `tests/message-edit-delete.test.js:28`). No retention policy, purge/redaction, or preservation hold; replay and import restore the original content by design today. |

## E. Reliability, privacy, community operations

| Item | Status | Evidence on `main` / gap |
|---|---|---|
| E1 Tested capacity | open — partial | Command latency under 25/50 agents measured (`docs/LOAD-TEST-2026-09-12.md`; `scripts/load-test.mjs`); pilot limits enforced (`server/store.mjs:1740,1765`); paged reads (`tests/return-brief.test.js:41`). Event-stream fan-out, history growth and wake-queue lag are not measured. |
| E2 Restore and rollback drill | open — partial | Backup round-trip (`scripts/backup-drill.mjs`), restore rehearsal names resurrected authority (`scripts/restore-rehearsal.mjs`; `server/backup.mjs` `reconcileRestoredAuthority`; `tests/restore-reconciliation.test.js:6`), 36-table recovery comparison (`tests/recovery-comparison.test.js:34`). Backups are unencrypted and same-disk (`docs/INVITE-ONLY-DEPLOYMENT.md` "Backup and restore"); deletion obligations (D6) and RTO/RPO are not measured. |
| E3 Durable service operations | **open PR** — partial | On `main`: transactional migrations and writer fence (`tests/writer-fence.test.js:44,81`), SIGTERM close (`server.mjs:31-39`), 22 rate-limit sites with LRU eviction (`tests/rate-limit.test.js:32`, #134), maintenance mode (`tests/maintenance.test.js:17`), bounded diagnostics (`tests/diagnostics.test.js:81`), version receipt (`server/version.mjs`). Open PRs: #141 non-fatal bootstrap window, CPU cap and Workers Logs; #148 operator docs for rate-limit eviction and export memory; #152 open-route inventory derived from `docs/openapi.yaml`; CI quality #146 lint gate, #147 lint job, #149 browser-failure visibility, #142 Node 24 for the isolated conformance workflow. Not covered anywhere: backpressure, storage-full behaviour, database-outage behaviour, secret rotation for deployment bindings, alerting with a consumer. |
| E4 Moderation and abuse handling | open — partial | Owner removal (`server/store.mjs:1715`), message delete (`tests/message-edit-delete.test.js:28`), link cancellation, rate limits; `docs/INVITE-ONLY-CHECKLIST.md` §5: "No automated blocklist". No report, block/mute, spam control, invite-abuse handling or appeal path. |
| E5 Encryption, secrets, data location | open | Pieces are scattered: hashed tokens only (`docs/SERVICE.md`), secrets-history check (`docs/SECURITY-REVIEW-2026-09-12.md`), export files unencrypted (`docs/EXPORT-RETENTION-DELETION.md`). No single document of encryption boundaries, credential storage/rotation, subprocessors, regions or external AI data paths. |
| E6 Accessibility and device evidence | open — partial | Automated AA checks for primary controls, focus return, live regions (`scripts/accessibility-check.mjs:14`), reduced-motion check (`tests/done-chip-motion.test.js`). `docs/MANUAL-AT.md` defines the VoiceOver/NVDA procedure; its result columns are empty. No multi-engine or TalkBack runs. |

## F. Switching, support, proof of value

| Item | Status | Evidence on `main` / gap |
|---|---|---|
| F1 Import without authority laundering | open — partial | Room import replays only the room's own export (`server/http.mjs:682`; `tests/room-export.test.js:100,145`). Channel import (email, Telegram fixtures) keeps source attribution and fingerprints, creates no agent wake (`server/channel-import.mjs`; `docs/UNIFIED-INBOX.md`); open PRs #145, #150, #151, #140 extend Telegram to live transport, hardening, UI and the Worker mount. Slack, Discord and GitHub imports: nothing. `docs/BUILD-PLAN.md` slice 14 is the GitHub spec. |
| F2 Portability and exit | open — partial | Machine-readable JSONL export for any member (`server/http.mjs:666`; `tests/room-export.test.js:43`), support export (`server/http.mjs:735`). No human-readable export, no export test after membership/retention change, no account/space closure flow. |
| F3 Consumer activation experiment | open | Human study not run (`docs/FIRST-USE-TESTING-2026-09-07.md`). Depends on A6, B1. |
| F4 Enterprise design-partner exercise | open | Depends on D1–D6 and E2; nothing to exercise yet. |
| F5 Sustainable packaging | open — partial | Agent identities are separate principals with a cap (`server/agent-identities.mjs:49`; `tests/agent-identities.test.js:193`), session budgets (C3). No per-room usage summary or caps display; pricing undecided by design. |
| F6 Support and trust evidence | open — partial | `docs/INVITE-ONLY-CHECKLIST.md` §5 (owner-run support, no status page), `docs/SAFE-DIAGNOSTICS.md`, three security reviews. No named support contact, incident/status communication plan, privacy/subprocessor terms or procurement packet. |

## Open items as PR-sized tasks

Each task is one branch against `main`. "Dependency" names the external
condition that must be settled before merge: `schema` (a `STORE_SCHEMA_VERSION`
bump and writer-fence migration), `secret` (a new deployment binding),
`account` (a third-party account or tenant), `spend`, or `none`.

### A1 — Sign-in through a maintained identity provider (OIDC)

- Files: new `server/oidc-login.mjs` (authorization-code + PKCE, issuer/audience/nonce checks, no token storage beyond the hashed session slot); `server/http.mjs` routes `GET /api/auth/oidc/start`, `GET /api/auth/oidc/callback`; `server/store.mjs` account lookup by `(issuer, subject)`; `src/app.js` a "Sign in" button beside the key field; `docs/SERVICE.md`, `docs/openapi.yaml`, `docs/ROUTE-AUTH-TABLE.md`.
- Approach: the callback binds the provider subject to an existing local account or creates one; it never grants room membership (A3 invitation acceptance stays the join path). Provisioned keys remain for the development pilot behind `ROOM_DEPLOYMENT`.
- Tests: `tests/oidc-login.test.js` with a local mock issuer (state/nonce mismatch, wrong audience, expired token, replayed code, subject reuse across accounts all refused; happy path creates one session slot); `scripts/invitation-check.mjs` extended for the button.
- Dependency: **account** (an IdP tenant), **secret** (client id/secret bindings), **schema** (`account_identities` table).

### A2 — Room create / archive / leave

- Files: `server/store.mjs` (`createRoom` for an account with `manage_members` elsewhere or the owner; `ROOM_ARCHIVED` event; `MEMBER_ACCESS_CHANGED` self-target as "leave"); `server/http.mjs` `POST /api/account-rooms` and `/api/rooms/:id/commands`; `src/app.js` room switcher rendering archived rooms read-only and never as working buttons; `docs/CURRENT-ROOM.md`.
- Approach: reuse the existing `rooms` table and `member_accounts` binding; archive is an event that closes commands except export and read. Personal vs organization badge is a room attribute until D1 exists.
- Tests: `tests/account-rooms.test.js` (create, switch, leave, archive; archived room rejects `MESSAGE_POSTED` with 409; discovery excludes rooms the account no longer belongs to); new browser check for switcher state.
- Dependency: **schema** (archived flag on `rooms`, or none if carried as an event — decide in the PR).

### A4 — Room policy that makes review mandatory

- Files: `server/store.mjs` (room `policy.requireIndependentReview`, `policy.requireOwnerDecision` set via a `ROOM_POLICY_SET` owner event; `WORK_PROPOSED` handler overrides client fields when policy is on); `src/events.js` reducer; `src/app.js` checkboxes disabled with the reason when policy applies; `docs/WORK-ITEM-SESSION.md` note.
- Approach: policy lives in the projection (event-sourced); old items keep their recorded requirements. Lightweight personal work is the default when policy is off, which is the existing behaviour.
- Tests: `tests/work-actions.test.js` — altered client fields cannot disable the gate under policy; casual message creates no item; pre-policy items unchanged after policy flips; `tests/state-machine-invariants.test.js` seed with policy on.
- Dependency: **none**.

### A6 — Record the unaided-newcomer session

- Files: `docs/evidence/first-room-human-2026-09-XX.md`; fixes discovered land as separate small PRs.
- Approach: one person who has not seen the room joins through a guest link on the hosted staging, says hello, finds who is present, leaves and returns; record the transcript of confusion points, no task creation required.
- Tests: none new; the record names the exact hosted revision.
- Dependency: **none** (needs a second human, ~30 minutes).

### B1 — Physical-device composer checklist and emulated failure modes

- Files: `docs/MOBILE-COMPOSER-CHECKLIST.md` (iPhone Safari + Home Screen, Android Chrome; keyboard, dictation, long paste, rotation, offline, background); `scripts/composer-browser-check.mjs` add Playwright emulation for `context.setOffline(true)` mid-draft, viewport rotation and `visibilitychange`.
- Approach: assert the draft body, recipient and reply target are unchanged after each event and that no send fires without an explicit action.
- Tests: the extended browser check (wired into `test:browser`); device rows filled by hand with the revision SHA.
- Dependency: **none** (devices needed for the manual half).

### B2 — Pinned messages and bookmarks

- Files: `src/events.js` (`MESSAGE_PINNED` / `MESSAGE_UNPINNED`, projection `pins[]`, cap 50 per room), `server/store.mjs` field allowlist, `src/app.js` "Pinned" section in catch-up and a pin action in the message menu, `server/http.mjs` search `kind=pinned`.
- Approach: pins reference message ids; deleted messages drop from the pinned list (reuse tombstone rules). Files/versioned artifacts are a separate task under B6.
- Tests: `tests/conversation.test.js` (pin/unpin idempotent, cap, tombstone removal, search filter honours access); browser check for keyboard access to the pin action.
- Dependency: **none**.

### B4 — Notification feed that honours preferences

- Files: `server/notifications.mjs` (derive per-member notifications from the event tail using `notificationPreferences`; dedupe by `(member, messageId|workItemId, kind)`; expire with the room cursor), `server/http.mjs` `GET /api/rooms/:id/notifications`, `src/app.js` badge and list; `docs/NOTIFICATIONS.md`.
- Approach: read-model only, no delivery yet; access removal makes the feed empty on the next read (recheck membership per read as every route does). Push is a follow-up requiring VAPID keys and a service worker; lock-screen bodies stay out by default when it lands.
- Tests: `tests/notification-feed.test.js` (mentions-only filter, dedupe of edits, expiry after caught-up, revoked member gets 401 not stale items, no notification grants any wake).
- Dependency: **none** (push follow-up: **secret** for VAPID keys).

### B5 — Private conversations as a scope

- Files: `server/store.mjs` (`conversations` table with `room_id`, `visibility`, member set; message `conversationId`; every read path filters by conversation membership), `server/http.mjs` (conversation-scoped `events`, `search`, `export`, `stream`), `src/app.js` conversation list, `docs/SERVICE.md`, `docs/EXPORT-RETENTION-DELETION.md`.
- Approach: a DM/private group is a conversation inside a room with its own member set; agent context reads (`work-context`, `orient`) exclude private conversations unless the agent is a member.
- Tests: `tests/private-conversations.test.js` covering history, search, stream, export, agent context and notifications across the boundary; recovery comparison updated for the new table.
- Dependency: **schema**.

### B6 — Image and file sharing with safe previews (first half of B6)

- Files: `server/attachments.mjs` (content-type allowlist, size cap, hashed object key, signed short-lived URL minted per read after access check), `server/http.mjs` upload/download routes, `cloudflare/room.mjs` R2 binding, `src/app.js` attachment chip and preview (images only, no remote fetch), `docs/EXPORT-RETENTION-DELETION.md`.
- Approach: metadata in the event log, bytes in object storage; downloads recheck current access and never rely on a stale signed link alone (B2 requirement). Voice/screen sharing is explicitly deferred.
- Tests: `tests/attachments.test.js` (type/size refusal, access recheck after removal, tombstone hides the chip, export lists attachment metadata not bytes); browser check for keyboard upload.
- Dependency: **account** and **spend** (object storage), **schema** (attachments table), **secret** (bucket binding).

### C1 — First real runtime through the dispatch journal

- Files: `server/runtime-adapter.mjs` implementing `docs/DASHA-ADAPTER-CONTRACT-2026-09-13.md` §3 (submission key `dasha:<workItemId>:<attempt>`, intent before submit via `server/dispatch-journal.mjs`), `scripts/agent-inbox.mjs` `run` subcommand, `src/app.js` session card states disconnected/queued/running/blocked/terminal read from `SESSION_*` events only; `docs/HOST-MATRIX.md` row moves to "working" only with linked evidence.
- Approach: one harmless task type; a fake adapter stays labelled `fixture` in the UI and never as live.
- Tests: `tests/runtime-adapter.test.js` with a local HTTP stub provider (lost response reconciles, duplicate delivery no second run, cancel-vs-complete race yields one terminal state); hosted evidence recorded separately.
- Dependency: **account** (provider), **secret** (provider key binding), **spend**.

### C2 — "What this agent can access" preview before a run

- Files: `src/app.js` panel rendered from `client.workContext(workId)` and the room roster (conversation scope, source message ids, linked evidence versions, budget), `server/work-context.mjs` add `accessSummary`, `docs/WORK-CONTEXT.md`.
- Approach: read-only; shows the exact omissions the server already reports. Organization allowlists wait on D1.
- Tests: `tests/work-context.test.js` (summary lists only what the member can read; quoted mention or imported message adds nothing); browser check for the panel.
- Dependency: **none**.

### C3 — Room-level spend allowance

- Files: `src/events.js` (`ROOM_BUDGET_SET` owner event with `allowanceCents`, `periodDays`), `server/store.mjs` (sum `SESSION_STOPPED.spendCents` in the period; refuse `SESSION_STARTED` when the remaining allowance is below the session's declared `maxSpendCents`, reserving it; reconcile on stop), `src/app.js` allowance/spent/remaining card, `docs/SESSION-BUDGETS.md`.
- Approach: reservation is the declared session cap; retries share the item's logical budget through `maxAttempts` already on `main`; a mention or assignment never sets a budget.
- Tests: `tests/work-session-budget.test.js` (two concurrent claims cannot both reserve the last allowance; stop below reservation frees the difference; unknown spend never authorises overage).
- Dependency: **none**.

### C6 — Owner-facing pause/remove and memory statement

- Files: `server/http.mjs` `POST /api/rooms/:id/agent-pause` (owner or the member itself; wraps `wakeQueue.pause/resume/inspect`), `src/app.js` People panel actions "Pause", "Resume", "Remove" (the last reuses `MEMBER_ACCESS_CHANGED`), `docs/AGENT-CONNECTION.md` section "What pause and remove cannot do" (context already delivered to an external provider is not recalled; retained summaries follow D6).
- Approach: no new store logic; expose the merged W4-48 surface and state the boundary honestly.
- Tests: `tests/wake-pause.test.js` HTTP cases (non-owner cannot pause another member; paused agent's queued wake does not start; removed member's pause row is inert); browser check for the actions.
- Dependency: **none**.

### D1 — Organization boundary: decision record and first model

- Files: `docs/ORGANIZATION-BOUNDARY.md` (decision: keep SQLite-per-workspace Durable Objects with one organization per object, or move to PostgreSQL with RLS as `docs/PRODUCTION-PLAN.md` slice 11 says; the issue's D1 test plan requires a real restricted database role, which the Durable Object path cannot provide), then `server/store.mjs` `organizations` table and `rooms.organization_id`.
- Approach: the PR is the decision plus the additive table and a migration; no policy engine. Similar names and email domains are never authorisation (test).
- Tests: `tests/organizations.test.js` (two organisations with similar names cannot read each other's rooms, search, exports, invitations or agent context).
- Dependency: **schema**; if PostgreSQL is chosen, **account** and **spend** as well. Blocks D2, D3, F4.

### D2 — Organization-enforced sign-in

- Files: `server/oidc-login.mjs` per-organization issuer configuration, enforcement that a consumer login cannot enter an organisation room without the organisation's issuer, session inventory route `GET /api/account-session/sessions`, logout-all; `docs/SERVICE.md`.
- Approach: builds on A1 and D1; SAML only through the provider's OIDC bridge (document it, do not implement SAML).
- Tests: `tests/oidc-login.test.js` (issuer mismatch refused, revocation ends streams, emergency admin path audited).
- Dependency: **account**, **secret**, **schema**; blocked by A1 and D1.

### D3 — SCIM lifecycle

- Files: `server/scim.mjs` (Users/Groups endpoints, bearer per organisation, idempotent sync, group-to-role map), `server/http.mjs`, `docs/SCIM.md`.
- Approach: deprovision runs the existing access-ending path (`server/store.mjs:1715`) for every room in the organisation and revokes agent connections; re-add never restores former grants (test).
- Tests: `tests/scim.test.js` (create, patch, deactivate, reactivate, group change, replayed request).
- Dependency: **schema**, **secret** (SCIM bearer binding), **account** (a directory to test against); blocked by D1/D2.

### D4 — Periodic access review report

- Files: `scripts/access-review.mjs` (read-only: members, grants, guests with expiry, links with remaining joins, agent identities and connections, last activity), `server/http.mjs` owner route `GET /api/rooms/:id/access-review`, `docs/INVITE-ONLY-CHECKLIST.md` §5 pointer.
- Approach: report only; separate billing/admin/audit roles wait on D1. Time-bounded guests already exist.
- Tests: `tests/access-review.test.js` (non-owner 403; report contains no tokens or hashes; expired guests shown as expired).
- Dependency: **none**.

### D5 — Unified, scoped audit export with denied actions

- Files: `server/audit-export.mjs` (merge room events, `membership_invitation_events`, `share_links`, `agent_connections`, `wake_queue` dead-letters into one actor/operation/target/time/result/provenance shape), `server/store.mjs` durable `denied_actions` table written on 401/403/409 for authenticated callers (bounded, no bodies), `server/http.mjs` `GET /api/rooms/:id/audit-export?from&to&actor`, `docs/EXPORT-RETENTION-DELETION.md` audit section stating the SQLite table is consistency-checked, not tamper-proof.
- Tests: `tests/audit-export.test.js` (denied action recorded without content; filter scoping; export completeness after a storage failure; owner-only).
- Dependency: **schema**.

### D6 — Redaction that survives replay and restore

- Files: `server/store.mjs` (`MESSAGE_REDACTED` command by owner or author: replaces the event body of the target message and its edits with a redaction record carrying the original body hash; export, import and recovery comparison treat the hash as the content), `src/events.js` tombstone rendering, `docs/EXPORT-RETENTION-DELETION.md` new "Redaction" section and a retention-policy stub with a preservation-hold role deferred to D1.
- Approach: this is the one deliberate exception to append-only bodies; the event id, sequence and hash chain stay, so replay reproduces the redaction, not the text.
- Tests: `tests/message-edit-delete.test.js` (redacted body absent from projection, search, export, import round-trip and restored backup; hash verifies; a second redaction is idempotent).
- Dependency: **schema**.

### E1 — Measure streams and queue lag

- Files: `scripts/load-test.mjs` add N open SSE streams and wake-queue enqueue/lease lag histograms; `docs/LOAD-TEST-2026-09-XX.md`.
- Tests: none new (measurement script); CI unchanged.
- Dependency: **none**.

### E2 — Encrypted off-host backup and timed restore drill

- Files: `scripts/backup-room.mjs` (`--encrypt` with a key from a deployment binding, age-style or AES-GCM with a versioned header; receipt records cipher and key id, never the key), `scripts/restore-rehearsal.mjs` measure elapsed time and event loss versus the watermark, `docs/INVITE-ONLY-DEPLOYMENT.md` "Backup and restore" and `docs/V8-RECOVERY-RUNBOOK.md`.
- Approach: reapplying deletion obligations before serving depends on D6; record it as a named step that fails closed until then.
- Tests: `tests/backup-encrypt.test.js` (wrong key refused, tampered ciphertext refused, round-trip equal on all 36 tables).
- Dependency: **secret** (backup key binding), **account** (off-host storage), **none** for the drill timing.

### E3 — Backpressure, storage-full and outage behaviour

- Files: `server/http.mjs` (per-connection SSE send-queue cap with a `stream_lagging` close), `server/store.mjs` (map `SQLITE_FULL` / `ENOSPC` and read-only database errors to `503 storage_unavailable` without partial writes), `server.mjs` readiness turns 503 on repeated storage failures, `docs/SAFE-DIAGNOSTICS.md` alert rows with a named consumer.
- Approach: complements #141 (Worker cold start), #148 (operator docs) and #152 (route inventory), which should merge first.
- Tests: `tests/storage-failure.test.js` (injected `SQLITE_FULL` leaves log and projection unchanged; slow SSE client is closed without affecting others).
- Dependency: **none**.

### E4 — Report and mute

- Files: `src/events.js` (`MESSAGE_REPORTED` to the owner, `MEMBER_MUTED` per viewer as a preference), `server/store.mjs`, `src/app.js` report action and muted-message collapse, `docs/MODERATION.md` (removal, appeal via the owner, invite-abuse response by link cancellation, malicious-agent isolation via C6 pause + access change).
- Tests: `tests/moderation.test.js` (report visible only to owner; mute hides for the muter only; reported agent can be paused and removed; rate limit on reports).
- Dependency: **none**.

### E5 — Data boundaries document

- Files: `docs/DATA-BOUNDARIES.md`: what is encrypted where (TLS at the edge, hashed credentials, unencrypted SQLite and exports), where deployment secrets live and how they rotate, the current subprocessors (edge/hosting, any provider used by an adapter), region facts for the Durable Object, and the plaintext path to any external AI runtime with the explicit statement that no end-to-end encryption is claimed.
- Tests: none; link from `docs/SECURITY-REVIEW-2026-09-14.md` follow-ups.
- Dependency: **none** (owner confirms the subprocessor list).

### E6 — Assistive-technology runs recorded

- Files: `docs/MANUAL-AT.md` result columns filled for VoiceOver + Safari and NVDA + Chrome at the exact revision; add a TalkBack row set and a second-engine (Firefox) pass; `docs/evidence/at-2026-09-XX.md`.
- Tests: fixes found become their own PRs with browser checks.
- Dependency: **none** (people and devices).

### F1 — GitHub read import as evidence

- Files: `server/github-import.mjs` (fetch issue/PR/commit/check metadata with a least-privilege App installation token; store immutable references, author as provenance label not a member; delivery-id dedupe), `server/http.mjs` owner route, `src/app.js` evidence chips; `docs/BUILD-PLAN.md` slice 14 stays the spec.
- Approach: imports create no agent wake and never fetch with a member's personal credential; inaccessible sources stay "unavailable". Slack/Discord follow the same shape later, reusing `server/channel-import.mjs`.
- Tests: `tests/github-import.test.js` with recorded fixtures (dedupe, renamed repo, deleted source, rate limit, edited comment).
- Dependency: **account** (GitHub App), **secret** (App key binding).

### F2 — Human-readable export and closure notice

- Files: `server/http.mjs` `GET /api/rooms/:id/export?format=html` rendered from the same event walk as JSONL (messages, work, evidence links, tombstones as "deleted"), `docs/EXPORT-RETENTION-DELETION.md` "Leaving a room / closing an account" section describing what the operator does today.
- Tests: `tests/room-export.test.js` (HTML export escapes bodies, hides tombstoned content, respects current membership after removal).
- Dependency: **none**.

### F3 / F4 — Human exercises

- F3: two unaided newcomers on hosted staging after A6 and B1; record in `docs/evidence/`. Dependency: **none** (people). Blocked by A6, B1.
- F4: two synthetic organisations plus a guest and an agent; blocked by D1–D6 and E2. Dependency: follows those tasks.

### F5 — Usage summary per room

- Files: `server/http.mjs` `GET /api/rooms/:id/usage` (human members, agent identities, sessions and reported spend in the period, pilot caps and remaining), `src/app.js` card, `docs/RELEASE-INVENTORY.md` row.
- Tests: `tests/usage.test.js` (agents never counted as human seats; caps match `server/store.mjs` limits).
- Dependency: **none**.

### F6 — Trust and support packet

- Files: `docs/TRUST-PACKET.md`: named support owner and channel, incident and status communication steps, links to the security reviews, `docs/DATA-BOUNDARIES.md` (E5), retention semantics (D6), and an explicit "not obtained" list for certifications.
- Tests: none.
- Dependency: **none** (owner names the support contact).

## Suggested order for the next batch

1. No-dependency code tasks that unblock human evidence: A4, C6, B4, C2, E3, F2, D4, C3, B2, E4.
2. Documents the owner can confirm quickly: E5, F6.
3. Schema tasks, one at a time behind the writer fence: A2, D6, D5, B5.
4. Human evidence: A6, B1, E6, then F3.
5. Decision first, then code: D1 (storage architecture), C1 and F1 (accounts, secrets, spend), B6 (object storage), E2 (backup key and off-host target).
6. Blocked until D1–D2: D3, F4.
