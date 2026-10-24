# Local human–agent handoff checkpoint

7 September 2026 UTC (6 September in Los Angeles). Active goal: `GOAL-LOCAL-MILESTONE-2026-09-07.md`. This is a local implementation checkpoint, not release approval.

## Latest addition: anyone-with-the-link guest entry

Follow-up: **155/155 syntax/core/API tests pass** after preserving existing account ownership during link preview, acceptance and ordinary rejection. Returning to the same authenticated room refreshes instead of clearing drafts. Client tests prove the ownership behavior; actual dialog, focus and draft interaction remains pending allowed browser testing. The [requirement-by-requirement acceptance audit](ACCEPTANCE-AUDIT-2026-09-07.md) identifies the exact tested source state and remaining work. Older counts below are historical checkpoints.

John selected reusable guest invitation links. The implementation, browser flow, service contract, migration and explicit limits are documented in `SHAREABLE-GUEST-LINKS.md`. The current schema is **v7**, extending the v6 foundation described below with two link tables and current-writer guards. Targeted invitations are unchanged; every link join produces a separately attributed guest membership and ordinary audited invitation acceptance. The preview database was backed up and restarted on its existing loopback address; `/api/health` returned 200.

The final syntax/core/API check passes **152/152 tests**, including nine share-link service/HTTP checks, two additional client ownership checks and a v6-to-v7 compatibility check. Visual browser inspection remains blocked by the required admin-policy check. Earlier 28 browser passes do not cover this UI. No external hosting, live agent runtime, publication or independent security-review claim is made. The current editing checkpoint is released; the broader goal remains open for allowed browser validation and subsequent user feedback.

## What changed

The invitation audit now validates the complete deterministic joined-event envelope, including idempotency and causation fields, its stored event identity and sequence bounds, the account binding, and immutable member name, role, kind, accountable human, and origin. Legitimate later permissions, suspension, and revision changes remain separate current-authority checks.

Schema v6 adds a compatibility fence on all 14 application tables: inserts, updates, and deletes require a connection-local service function. The startup migration takes one write transaction for all migration helpers, validation, fence installation, and version advancement. A connection opened before migration cannot perform ordinary writes afterward without the new service function. Current service startup and read-only audit verify the fence definitions; conflicting definitions are not silently replaced. This does not defend against a database administrator deliberately altering schema or registering functions.

The existing work model already supported much of the handoff. A new shared `src/workflow.js` describes the next responsible member and action. The browser work card, return-brief attention list, and structured client now use the same next-step logic. Running work does not repeatedly request attention. A changed result returns to review; approval is not external execution.

`client/room-agent.mjs` provides a small HTTP client, and `scripts/agent-inbox.mjs` exposes read-only orientation, changes, and return briefs. This is not an AI runtime, MCP server, or public discovery service. MCP remains an explicit next integration decision, not a claim of completed compatibility.

## Evidence and its limits

- Current core/API suite: **140/140 passed** after the evidence, migration, shared next-step, and client changes.
- Focused foundation suite: **18/18 passed**, including deterministic acceptance evidence, historical baseline preservation, rollback, and pre-existing writer exclusion.
- New API handoff: **2/2 passed**. Separately authenticated scripted producer/reviewer clients exchange a source-linked assignment, an exact text hash, a finding, a corrected revision, and a decision. The service actually closes and reopens its persisted database mid-workflow. A repeated review persists once, and key rotation prevents further use of the prior producer key.
- Existing Chromium suite: **28/28 passed against the foundation corrections before the subsequent next-step UI change**. That result is not approval of the newer interface.
- Interactive inspection of the updated screen was blocked because the in-app browser could not verify an admin-enforced policy. No alternate browser-control path was used to bypass that restriction. Updated visual, keyboard, and narrow-screen verification remains pending.

All handoff participants and decisions in the test are synthetic. The two scripted agent identities share the test operator; they are not independently controlled organizations or live models. The checked artifact is text contained in the receipt with its SHA-256 version. Its explicitly synthetic `example.invalid` URL is not a fetched artifact or real external evidence. This test proves local record exchange and revision behavior, not remote evidence retrieval, real AI quality, human usability, or independent approval.

No producer self-review is presented as an independent review of this implementation. No production data was migrated during development: migration checks use disposable databases only.

## Run the checks

Use the supported Node runtime (at least the version declared in `package.json`) and the existing dependencies:

```sh
npm test
npm run check
npm run test:handoff
npm run test:browser
```

The HTTP checks need permission to bind temporary loopback servers. A sandbox refusal to bind is an environment limitation, not a test PASS. Browser tests require an allowed browser-testing environment; do not use them to bypass an admin restriction.

## Migration and rollback boundary

Stop old service processes, make a consistent backup, and validate an isolated copy before any separately authorized upgrade of actual user data. Schema v6 is additive to v5 and keeps invitation journal bodies and existing records. Failed startup migrations roll back together. Older binaries opening the new database reject its version, and the fence also rejects ordinary writes from older already-open connections.

Rollback means restoring the matching pre-upgrade backup with the service stopped, not editing the version marker or deleting guard triggers. Old connections can still read information their existing database access allowed; this is writer compatibility protection, not retroactive data revocation. Future schema migrations must explicitly preserve or replace the compatibility contract within their migration transaction.

Implementation references: [Node SQLite connection functions and transaction state](https://nodejs.org/api/sqlite.html), [SQLite transaction semantics](https://sqlite.org/lang_transaction.html). These APIs support the mechanism; the bounded local tests are the evidence for this implementation.

## What remains before this goal is complete

Verify the updated human interface in an allowed browser, provide a clean interactive handoff that John can try, and resolve any resulting findings. A real retrieved artifact and live runtime integration remain explicitly distinct from the synthetic contract test. Independent code review and the broader production/device/operations/dogfooding gates are still open.

No publish, deploy, push, merge, live account connection, spending, or other product changes occurred. The goal remains active.
