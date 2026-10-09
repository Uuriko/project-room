# Notify, legal, ops and boot

_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09 from module header comments,
export lists, and `git grep` caller evidence. Each module below had no dedicated doc page.
Purpose/invariants/gotchas are quoted from the module's own header comment where present._

## `server/attachment-schema.mjs`  (44 lines)

**Purpose.** Room-owned staging. HTTP upload routes stay separate. server/room-attachment-bytes.mjs is the store API: stage, list, download, discard, and commit (message_id + state committed).

**Exports:** `attachmentLimits`, `attachmentSchema`, `attachmentSchemaV28`, `ensureAttachmentSchema`, `verifyAttachmentSchema`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/inbox-attachment-bytes.mjs`, `server/mcp-hosted-tools.mjs`, `server/room-attachment-bytes.mjs`, `server/store.mjs`, `tests/audit-wave-low-a.test.js`, `tests/fixtures/pr-overlap-2026-09-26.json`, `tests/room-attachment-quota-ratchet.test.js`, `tests/room-mcp-files.test.js`

## `server/boot-options.mjs`  (21 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `defaultServerArgs`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server.mjs`, `tests/channel-inbound-boot.test.js`

## `server/connect-snippets.mjs`  (126 lines)

**Purpose.** Connect-your-agent table for docs pages and the room CLI. The connect sheet UI and llms.txt import this module; they do not copy it. Snippets name the env var. They never contain an identity secret.

**Exports:** `AIDER_CONVENTIONS`, `HOSTED_MCP_URL`, `SECRET_ENV`, `SERVER_NAME`, `WORK_LOOP`, `agentDocRoutes`, `claudeHeaderValue`, `connectSnippets`, `cursorInstallLink`, `envHeader`, `installLinkFor`, `renderedSnippet`

**Callers/importers (git grep HEAD):** `cli/commands/doctor.mjs`, `cli/commands/setup.mjs`, `deploy/public-search.mjs`, `scripts/build-agent-docs.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/routes/agent-connect.mjs`, `tests/connect-snippets.test.js`

## `server/conversation-sync.mjs`  (135 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `readConversation`

**Callers/importers (git grep HEAD):** `cloudflare/projection-at-rest.test-fixture.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/http.mjs`, `tests/mcp-room-messages-paging.test.js`, `tests/projection-at-rest.test.js`

## `server/feedback-store.mjs`  (568 lines)

**Purpose.** Feedback endpoint core: validation, dedup/clustering, Mark-staked triage economics, filer lifecycle (credit loop, appeals, reviewer economics, cluster velocity, severity routing). Production port of ~/workspace/feedback-endpoint/feedback.mjs (spec: docs/feedback-endpoint.md). Pure module in the repo's conventions: injected clock, caller-owned state, frozen outputs, domain errors thrown (no HTTP status); the HTTP mapping lives in server/feedback-routes.mjs. The Jev triage-advisor seam is deliberately NOT wired here (owner call: leave Jev open, build without it). Triage is lane-operated; the advisor interface is documented in docs/feedback-endpoint.md §5 for a future slice. Anti-spam design (the load-bearing question): junk must have a price and signal must earn. Filing costs Mark standing; accepted-as-real refunds the cost and pays a reward; duplicates cost nothing (encourages filing even

**Exports:** `APPEAL_WINDOW_MS`, `CLUSTER_FAST_TRACK_PER_DAY`, `CLUSTER_FILEDAT_CAP`, `CLUSTER_SEVERITY_BUMP_PER_DAY`, `FEEDBACK_ID_PATTERN`, `MARK_ACCEPT_REWARD`, `MARK_APPEAL_COST`, `MARK_FILING_COST`, `MARK_JUNK_SUSPEND_AFTER`, `MARK_JUNK_SUSPEND_RATE`, `MARK_MERGE_BONUS`, `MARK_REVIEWER_CONFIRMED`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/feedback-routes.mjs`, `tests/audit-wave-3b.test.js`, `tests/feedback-routes.test.js`, `tests/feedback-store.test.js`

## `server/graph-reply-update-review.mjs`  (58 lines)

**Purpose.** Post-write inspection and review qualification. No provider I/O or send grant.

**Exports:** `buildUpdateInspection`, `buildUpdateReview`, `inspectUpdate`, `replyAttemptWithObservation`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/graph-reply-journal.mjs`, `server/inbox.mjs`, `tests/graph-reply-update-journal.test.js`

## `server/handoff-case.mjs`  (78 lines)

**Purpose.** CASE handoff contract (research slice R2). Handoffs are freeform text and the receiver re-asks everything; CASE fixes the shape: Customer/auth, Aim/urgency, Steps/sources, Escalation/ownership — with an epistemic label on every step, so a verified fact never reads the same as a guess. Pure module: no database, no network, no clock. Validation raises ServiceError (422) from ./store.mjs so the same codes read in unit tests and through the journal/store layer. Unknown keys and unknown epistemic labels are rejected, never silently accepted — an unlabeled step is the failure mode this contract exists to kill.

**Exports:** `caseOf`, `caseVersion`, `epistemicLabels`, `validateCase`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/inbox-handoff.mjs`, `tests/handoff-case.test.js`

## `server/instance-lock.mjs`  (85 lines)

**Purpose.** Single-instance boot lock for server.mjs. The room store is SQLite (serializes writes), but the growth snapshot is a plain JSON file: two server.mjs processes on one database race it (last-writer-wins / torn write on concurrent shutdown). The lock is an exclusive-create file next to the database holding the owner's PID; a stale lock (dead PID or malformed content) is reclaimed exactly once. The lock holder keeps the fd open for the process lifetime and releases (close + unlink) on graceful shutdown; a crash leaves a stale file that the next boot reclaims via the PID-liveness check. This replaces the deleted src/multi-instance-election.mjs: that module was a lease election for a multi-instance deploy that was never wired to any production path. The supported topology is one server per database.

**Exports:** `INSTANCE_LOCK_ERRORS`, `acquireInstanceLock`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server.mjs`, `tests/instance-lock.test.js`

## `server/legal-pages.mjs`  (161 lines)

**Purpose.** Public legal pages rendered from docs/legal. The worker bundle falls back to the embedded copy when the files are not on disk.

**Exports:** `ABUSE_EMAIL`, `LEGAL_CACHE_CONTROL`, `LEGAL_FOOTER_LINKS`, `LEGAL_PAGE_CSP`, `LEGAL_SITEMAP_PATHS`, `REPORT_PAGE_CSP`, `legalPageHtml`, `readLegalFile`, `renderMarkdown`, `reportHref`, `reportPageHtml`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/http.mjs`, `server/legal-routes.mjs`, `server/public-face.mjs`, `server/public-rooms.mjs`, `server/receipts-page.mjs`, `tests/demo-room.test.js`, `tests/legal-pages.test.js`, `tests/qa4-legal-door-alias.test.js`

## `server/legal-routes.mjs`  (132 lines)

**Purpose.** HTTP for the legal pages, public reports, terms acceptance, and operator unpublish.

**Exports:** `handleLegalRequest`, `isLegalPath`

**Callers/importers (git grep HEAD):** `scripts/routes-inventory.mjs`, `scripts/runtime-package.mjs`, `server/http.mjs`, `tests/legal-pages.test.js`

## `server/legal-store.mjs`  (134 lines)

**Purpose.** Terms acceptance, public abuse reports, and operator unpublish. No import from store.mjs: room-directory and the store both call this module.

**Exports:** `REPORT_PROOF_BITS`, `SIGNUP_ORIGINS`, `TERMS_VERSION`, `acceptCurrentTerms`, `accountTermsSchema`, `countOpenPublicReports`, `hashReportAddress`, `isUnpublished`, `publicAbuseSchema`, `publicUnpublishSchema`, `recordSignupTerms`, `reportChallenge`

**Callers/importers (git grep HEAD):** `cloudflare/room.mjs`, `scripts/runtime-package.mjs`, `server/http.mjs`, `server/legal-pages.mjs`, `server/legal-routes.mjs`, `server/public-read-model.mjs`, `server/room-directory.mjs`, `server/store.mjs`, `tests/legal-pages.test.js`, `tests/legal-templates-grounding.test.js`

## `server/mcp-arg-errors.mjs`  (228 lines)

**Purpose.** Structured MCP tools/call errors. Callers get unknown_tool, auth_required, or invalid_arguments instead of one fixed "Unknown tool or invalid arguments" string. The JSON-RPC code stays -32602 for schema problems and -32001 when a room tool is called with no identity bearer.

**Exports:** `MCP_AUTH_HINT`, `MCP_AUTH_MESSAGE`, `closestToolName`, `diagnoseArguments`, `mcpCallError`, `mcpInvalidRequest`, `mcpTransportError`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/http.mjs`, `server/mcp-http.mjs`, `server/mcp-identity-mint.mjs`, `server/mcp-public-work.mjs`, `server/mcp-room-profile.mjs`, `tests/qa5-agent-errors.test.js`, `tests/video-walkthrough-shots.test.js`

## `server/mcp-identity-mint.mjs`  (94 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `anonymousIdentityMintMcpTools`, `handleIdentityMintMcp`, `identityMintMcpDefinitions`, `isIdentityMintMcpTool`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/mcp-discovery.mjs`, `server/mcp-http.mjs`, `server/mcp-room-profile.mjs`, `src/room-mcp-join.js`, `tests/agent-discovery.test.js`, `tests/mcp-tools-reconciliation.test.js`

## `server/mcp-public-work.mjs`  (67 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `anonymousPublicWorkMcpTools`, `handlePublicWorkMcp`, `isPublicWorkMcpTool`, `publicWorkMcpDefinitions`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/mcp-discovery.mjs`, `server/mcp-http.mjs`, `server/mcp-room-profile.mjs`, `tests/agent-discovery.test.js`, `tests/mcp-openapi-drift.test.js`, `tests/mcp-tools-reconciliation.test.js`, `tests/public-work-mcp.test.js`, `tests/qa5-agent-errors.test.js`

## `server/notify-policy.mjs`  (303 lines)

**Purpose.** Notification policy (HB-1a). One pure engine for push, relays, the morning brief, and the later email batch (NOTIFY). Nothing here delivers: callers pass already-resolved prefs and get a decision back. Email delivery is inert. `emailDelivery` defaults to "inert", so `decide` never schedules an email. NOTIFY turns that on (`"needs_me"` or `"brief"`) after a verified address exists. It must not grow a second quiet-hours, cap, or batching implementation. `needs_me` is the policy default. notify-prefs.mjs still stores all | mentions | muted until HB-1b adds the level there. Pass either a resolved level string or `{ level, quietHours, wakeFor }`.

**Exports:** `BATCH_WINDOW_MS`, `DESKTOP_FOCUS_MS`, `DESKTOP_RECHECK_MS`, `EMAIL_DELIVERY`, `EMAIL_MODES`, `FOLLOWING_KINDS`, `NEEDS_ME_KINDS`, `NEEDS_ME_LEVEL`, `POLICY_DEFAULT_LEVEL`, `POLICY_LEVELS`, `PUSH_PER_AGENT_HOUR`, `PUSH_PER_HUMAN_DAY`

**Callers/importers (git grep HEAD):** `scripts/reachability.mjs`, `tests/notify-policy.test.js`

## `server/og-render.mjs`  (293 lines)

**Purpose.** Runtime Open Graph renderer (VL-1a). Dependency-free. Composites sanitized text onto og/base-receipt.png using the committed Inter glyph atlas (og/atlas-inter-*.png + og/atlas.json). The marketing images og/{home,about,offers,compare,receipts}.png belong to the static share set and are not written here. PNG bytes are zlib-wrapped on Node (stable for a given Node major) and CompressionStream("deflate") on a runtime without node:zlib. CRC32 is computed in JS. Text is stripped of control characters and capped at 120 characters before it is wrapped. A title occupies at most 3 lines and the last line ends with an ellipsis when the rest does not fit.

**Exports:** `OG_HEIGHT`, `OG_TEXT_LIMIT`, `OG_WIDTH`, `decodePng`, `encodePng`, `renderOgPng`, `sanitizeOgText`, `wrapOgText`

**Callers/importers (git grep HEAD):** `scripts/build-og-atlas.mjs`, `tests/og-render.test.js`

## `server/operator-purge.mjs`  (466 lines)

**Purpose.** Confirm-then-delete for rooms, identities, and accounts. Planning and find are read-only apart from the operator audit row. Execute recounts, refuses with 409 plan_changed when the counts moved, and deletes inside one writer transaction. The integrity snapshot is rewritten in that same transaction.

**Exports:** `countPurge`, `createOperatorPurge`, `hashPurgeCounts`, `protectedRoomIds`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/operator-routes.mjs`, `tests/operator-purge.test.js`, `tests/room-assistant.test.js`, `tests/trial-task-http.test.js`

## `server/operator-routes.mjs`  (62 lines)

**Purpose.** Operator HTTP surface. Mounted from createRoomServer. When the operator secret is unset this returns false and the request falls through to the same not_found path as any unknown URL.

**Exports:** `createOperatorRoutes`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/http.mjs`, `tests/operator-purge.test.js`

## `server/operator-status.mjs`  (90 lines)

**Purpose.** Operator status. One read of version, readiness, the largest tables, and the latest operator actions. The server does not call GitHub. Job heartbeats live on the Worker, which this process does not reach without the Durable Object entrypoint, so jobs points at that route.

**Exports:** `collectLargestTables`, `lastColdStart`, `operatorDrift`, `operatorReady`, `operatorStatus`, `revisionDrift`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/operator-routes.mjs`, `tests/operator-purge.test.js`

## `server/persisted-row.mjs`  (85 lines)

**Purpose.** Replay-safe persisted-row envelope (UFO-steal slice 3, RC-2026-09-27-2730). Audit (2026-09-27): persisted rows across the room are written with bare JSON.stringify and read with bare JSON.parse — no version envelope, no writer identity, no defaults layer at the read site: - server/work-claim-sqlite.mjs: work_claims.item_json stored whole; the read site parsed and trusted; defaults live inside workOf() and only run when callers remember to validate first. - server/dispatch-journal.mjs: JSONL entries carry no schema version; apply() throws on unknown states and requires key/state — every field evolution has to be hand-rolled per module. - server/bounty-escrow.mjs: bounty_disputes.body hydrated with a bare JSON.parse at boot; the dispute machine reads fields directly. No class names are baked into stored JSON (plain-object culture), so the fragility is the inverse of UFO's: nothing identifi

**Exports:** `MOVED_KINDS`, `ROW_FORMAT_V`, `decodeRow`, `encodeRow`, `resolveKind`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/bounty-escrow.mjs`, `server/work-claim-sqlite.mjs`, `tests/chaos/work-claim-chaos-scaffold.mjs`, `tests/identity-mint-capacity.test.js`, `tests/persisted-row.test.js`

## `server/projection-at-rest.mjs`  (145 lines)

**Purpose.** Phase 1a: message bodies at rest outside the room projection row. The reducer, the cache and every reader keep full message bodies in memory. Only the stored row changes: a message body at or above BODY_AT_REST_MIN_CHARS is replaced by `bodyRef` (its sha256) and the text is kept once in projection_bodies, keyed by content. Rows are immutable, so a write that is later rolled back or skipped can never change what an existing bodyRef means. A trigger on rooms deletes every body the stored projection no longer references, in the same statement, so deleted, redacted and purged text does not outlive the projection that held it. Rollout: hydration is always on. Slimming is on only when the store was opened with bodiesAtRest (ROOM_BODIES_AT_REST=1). Turning it off makes the next write of each room store full bodies again; store.rehydrateAllProjections() does that for every room at once, in one t

**Exports:** `BODY_AT_REST_MIN_CHARS`, `PROJECTION_BODIES_SCHEMA`, `atRestBodyBytes`, `hydrateProjection`, `hydrateRecordText`, `storedProjection`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/conversation-sync.mjs`, `server/message-redaction.mjs`, `server/messages-store.mjs`, `server/store.mjs`, `tests/projection-at-rest.test.js`

## `server/purge-registry.mjs`  (1724 lines)

**Purpose.** Every application table that carries a room, identity, or account key, plus child tables that point at those rows through a parent. `retain` is only used with a reason. Room purge deletes `delete` rows for that room, then the room itself. Identity purge revokes the identity and deletes its `delete` rows. Account purge runs the account-deletion executor and then the account-scoped `delete` rows.

**Exports:** `PURGE_TABLES`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/operator-purge.mjs`, `tests/operator-purge.test.js`, `tests/wake-live.test.js`

## `server/required-reading.mjs`  (96 lines)

**Purpose.** Per-lane required reading on enrollment (backlog W012). When an agent enrolls in a work lane — takes a claim — the claim response carries the reading list for that claim's kind. The list is advisory: enrollment never gates on it, so there is nothing to bypass and no existing flow can break. A read-acknowledgment (who confirmed what, when) is recorded on the claim item itself (see stampReadingAck), carried by the claim canonicalizer and the durable registry, and also stamped into the claim history for the audit trail. Pure: no imports of its own beyond the claim history stamper, frozen outputs, domain errors with no HTTP status.

**Exports:** `REQUIRED_READING`, `readingAcksOf`, `requiredReadingFor`, `stampReadingAck`, `validateReadingDocs`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/work-claim-routes.mjs`, `tests/required-reading.test.js`

## `server/retention-response.mjs`  (297 lines)

**Purpose.** Retention response mechanics (research brief 2026-09-28, agent-retention mechanics #1 and #2): first-contribution response SLA + no-zero-reply watchdog. Pure, dependency-free, deterministic; frozen outputs. It reads the same normalized work-claim item shape server/work-claims.mjs produces (id, owner, history: [{ at, agentId, action, note }]) and never writes anything itself — the HTTP layer applies retentionAck() and serves retentionReport(). Model: - A contribution is a claim event (the item's first "claimed" stamp) or a receipt event (the "state:done" stamp). The author is the stamp's agentId. - A member response is any later history entry by a different member — never "system", never the author. Verdict-class responses are "reviewed" stamps (recordReview verdicts: approve / changes_requested / comment, and attestWork review notes): the machine-readable verdict the SLA asks for. - The 

**Exports:** `FIRST_RESPONSE_SLA_HOURS`, `RETENTION_METRIC_WINDOW_DAYS`, `ZERO_REPLY_WINDOW_HOURS`, `assessFirstContributionSla`, `assessZeroReply`, `firstResponseLatency`, `isFirstContribution`, `retentionAck`, `retentionReport`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/agent-rooms.mjs`, `server/routes/work-claims.mjs`, `server/work-claim-routes.mjs`, `tests/work-claim-retention.test.js`

## `server/room-assistant.mjs`  (223 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `RoomAssistant`, `roomAssistantSchema`

**Callers/importers (git grep HEAD):** `scripts/recovery-coverage.mjs`, `scripts/runtime-package.mjs`, `server/mcp-full-profile.mjs`, `server/routes/room-assistant.mjs`, `server/routes/table.mjs`, `server/store.mjs`, `tests/room-assistant.test.js`

## `server/room-key-presence.mjs`  (56 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `assertRoomKeyPullOnly`, `roomKeyHostId`, `roomKeyPresenceAuth`, `roomKeyPresenceView`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/agent-plugin-routes.mjs`, `tests/room-key-heartbeat.test.js`

## `server/web-push.mjs`  (470 lines)

**Purpose.** Web Push delivery: VAPID (RFC 8292) and encrypted payloads (RFC 8291 over the aes128gcm content coding of RFC 8188). Why this exists: server/notifications.mjs derives a per-member feed but says in its own header that it "delivers nothing". Nothing else in the product delivers either - server/channel-adapters/email.mjs declares outbound "none", and no wrangler config carries a cron trigger, a queue or an email binding. So a member who is not looking at the page has no way to learn that anything happened. This module is the delivery half. Constraints it is written under: Web Crypto only. The runtime package has zero dependencies and this must run unchanged in a Cloudflare Worker, so there is no node:crypto here. Pure and injectable. Key generation and the random salt come in through arguments with real defaults, so every value in a test can be pinned and the published RFC vectors can be re

**Exports:** `buildPushRequest`, `constants`, `decryptContent`, `encryptContent`, `encryptPushPayload`, `fromBase64Url`, `generateKeyPair`, `generateVapidKeys`, `hkdfExpand`, `hkdfExtract`, `toBase64Url`, `vapidAuthorization`

**Callers/importers (git grep HEAD):** `cloudflare/store-worker.test-fixture.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/human-push-browser-check.mjs`, `scripts/push-doctor.mjs`, `scripts/runtime-package.mjs`, `server/push-subscriptions.mjs`, `tests/human-push-preferences.test.js`, `tests/human-push.test.js`, `tests/push-subscriptions.test.js`, `tests/rich-push.test.js`
