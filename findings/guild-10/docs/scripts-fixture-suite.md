# Fixture scripts

_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09 from module header comments,
export lists, and `git grep` caller evidence. Each module below had no dedicated doc page.
Purpose/invariants/gotchas are quoted from the module's own header comment where present._

## `scripts/frozen-runtime-fixture.mjs`  (30 lines)

**Purpose.** Test-only fixture loader. Never mutates a frozen package or changes its manifest.

**Exports:** `frozenAcceptanceFixture`, `frozenRecoveryFixture`, `v10CharterBaseline`, `v11ReplyBaseline`, `v12HelpBaseline`, `v13OfferBaseline`, `v14InboxBaseline`, `v15AdoptionBaseline`, `v16SendBaseline`, `v17EmailBaseline`, `v18EmailSourceBaseline`, `v19EmailExcerptBaseline`

**Callers/importers (git grep HEAD):** `cloudflare/agent-upgrade.check.mjs`, `cloudflare/recovery-switch.check.mjs`, `tests/agent-upgrade.test.js`, `tests/graph-reply-journal.test.js`, `tests/graph-reply-update-journal.test.js`, `tests/help-discovery.test.js`, `tests/help-offer-service.test.js`, `tests/room-lifecycle.test.js`, `tests/runtime-package.test.js`, `tests/work-help-service.test.js`

## `scripts/gmail-contract-fixture.mjs`  (55 lines)

**Purpose.** Invented Gmail API shaped data (users.messages resources). No mailbox export, real people or tokens.

**Exports:** `gmailContractFixture`

**Callers/importers (git grep HEAD):** `scripts/gmail-setup-browser-check.mjs`, `tests/channel-adapter-contracts.test.js`, `tests/gmail-adapter.test.js`, `tests/gmail-mailbox.test.js`

## `scripts/gmail-live-fixture.mjs`  (61 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `gmailLiveFixture`

**Callers/importers (git grep HEAD):** `scripts/gmail-workspace-browser-check.mjs`, `tests/gmail-actions.test.js`, `tests/gmail-live-fixture.test.js`, `tests/gmail-sync.test.js`

## `scripts/in-place-fixture-signin.mjs`  (44 lines)

**Purpose.** Disposable loopback fixtures only. Real visible login keeps pending browser callbacks alive.

**Exports:** `signInFixtureInPlace`

**Callers/importers (git grep HEAD):** `scripts/access-preview-browser-check.mjs`, `scripts/action-recovery-browser-check.mjs`, `scripts/browser-check.mjs`, `scripts/chat-performance-browser-check.mjs`, `scripts/draft-return-browser-check.mjs`, `scripts/inbox-browser-check.mjs`, `scripts/member-perms-browser-check.mjs`, `scripts/owner-project-offers-browser-check.mjs`, `scripts/portable-work-browser-check.mjs`, `scripts/public-work-matching-browser-check.mjs`

## `scripts/inbox-result-fixture.mjs`  (38 lines)

**Purpose.** Scripted participants and synthetic local data only, never hosted execution.

**Exports:** `prepareInboxResult`

**Callers/importers (git grep HEAD):** `cloudflare/agent-upgrade.check.mjs`, `scripts/inbox-browser-check.mjs`, `tests/email-import.test.js`, `tests/inbox-adoption.test.js`

## `scripts/record-rails-fixture.mjs`  (36 lines)

**Purpose.** Synthetic qualification helpers use the real event and durable rail authority.

**Exports:** `acceptedReceipt`, `addRailMember`, `seedRecordRails`, `submittedTrial`

**Callers/importers (git grep HEAD):** `cloudflare/record-rails.test-fixture.mjs`, `scripts/recovery-coverage.mjs`, `tests/buyer-offer-http.test.js`, `tests/buyer-signoff.test.js`, `tests/demigod-contracts.test.js`, `tests/trial-task-http.test.js`

## `scripts/reply-review-fixture.mjs`  (28 lines)

**Purpose.** Deliberately invented provider history. Not a provider driver or runtime asset.

**Exports:** `seedRecordedReply`

**Callers/importers (git grep HEAD):** `cloudflare/http-worker.test-fixture.mjs`, `scripts/inbox-browser-check.mjs`, `scripts/inbox-sandbox.mjs`, `scripts/reply-update-fixture.mjs`

## `scripts/reply-update-fixture.mjs`  (46 lines)

**Purpose.** Shared invented mailbox/update fixture. Never contacts a provider.

**Exports:** `createReplyUpdateFixture`

**Callers/importers (git grep HEAD):** `tests/graph-reply-update-journal.test.js`, `tests/graph-reply-update.test.js`

## `scripts/results-fixture.mjs`  (55 lines)

**Purpose.** Disposable fictional results; no provider reads, execution or publication.

**Exports:** `createResultsFixture`

**Callers/importers (git grep HEAD):** `scripts/room-overview-browser-check.mjs`, `scripts/room-results-browser-check.mjs`, `tests/curiosity-rank.test.js`, `tests/curiosity-sort-mcp.test.js`, `tests/room-results.test.js`

## `scripts/telegram-contract-fixture.mjs`  (22 lines)

**Purpose.** Invented Telegram Bot API shaped data. No bot token, chat export or real people.

**Exports:** `telegramContractFixture`

**Callers/importers (git grep HEAD):** `scripts/inbox-telegram-check.mjs`, `scripts/inbox-unified-check.mjs`, `tests/channel-adapter-contracts.test.js`, `tests/channel-connection.test.js`, `tests/channel-drain.test.js`, `tests/channel-import.test.js`, `tests/channel-inbound-boot.test.js`, `tests/channel-journal-parity.test.js`, `tests/channel-journal.test.js`, `tests/channel-webhook-dedupe-property.test.js`

## `scripts/work-lifecycle-agent-fixture.mjs`  (76 lines)

**Purpose.** Synthetic same-room participation, never a hosted runner or external workspace.

**Exports:** `startWorkLifecycleFixture`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `tests/mcp-lifecycle.test.js`
