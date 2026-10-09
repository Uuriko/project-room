# Gmail bridge modules (shelved)

_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09. MEMORY: the Gmail bridge was shelved 2026-10-06 (ROOM_GMAIL_ENABLED stays 0) — these modules describe the dormant inbound-mail design._

## `server/gmail-content.mjs` (52 lines)


**Exports:** `attachmentBytes`, `findGmailPart`, `gmailAttachmentLimit`, `gmailHeader`, `gmailMimeBody`, `gmailParts`, `projectGmailMessage`, `safeGmailHtml`

**Callers/importers:** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `scripts/untested-modules-lint.mjs`, `server/gmail-actions.mjs`

## `server/gmail-import-authority.mjs` (23 lines)

**Purpose.** A process-local, unforgeable capability for importing a connected owner's Gmail observations. Never serialized, never accepted from HTTP, never a session.

**Exports:** `gmailImportAuth`, `gmailImportToken`

**Callers/importers:** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/email-import.mjs`, `server/gmail-sync.mjs`, `server/inbox.mjs`, `tests/gmail-sync.test.js`

## `server/gmail-sync.mjs` (114 lines)


**Exports:** `GmailSync`, `startGmailSync`

**Callers/importers:** `cloudflare/room.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/jobs.mjs`, `server/routes/inbox.mjs`, `tests/gmail-sync.test.js`
