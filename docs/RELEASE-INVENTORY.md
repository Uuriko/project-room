# Release inventory (B1)

September 12, 2026. One current record of what exists and how well it is known,
so stale historical plans cannot be mistaken for current availability. Older
checkpoint and research documents (including the Sep-8 backlog's "where we are"
table) are historical; when they disagree with this file, this file wins until
the next inventory supersedes it.

Statuses: **local** (works on this checkout), **qualified** (local plus
executable CI evidence on main), **live** (verified serving on a deployed
worker), **unknown** (not verified recently enough to claim).

## Runtime baseline

### Current integration checkpoint (September 12, 2026)

Current integration worktree: `/Users/johnpotter/src/project-room-integration`,
branch `codex/project-room-integration`, schema/writer version **33**. Runtime
checkpoint `155a33c` (grant schema preflight hardening on the `4ac7bfc` entry point).
These are local
checkpoints, not claims about main, CI, a deployed website or enterprise readiness.

Receive-only grants, signed background SMS/WhatsApp imports, concise consent/stop
UI and optional loopback startup are implemented. The complete browser → consent
→ sign-out → signed HTTP delivery → private Inbox → stop journey passes for both
providers on 390px and 1280px. Runtime package includes 132 files. This remains
local fixture evidence: no live grants, number, provider callback or receiver was
enabled. Telegram background import is unfinished. See
[receive-grant boundary](MESSAGING-RECEIVE-GRANTS-2026-09-12.md).

| Current capability | Evidence | Remaining boundary |
|---|---|---|
| Gmail read-only private Inbox | Local pilot imported 25 real messages | No new live verification in this inventory pass; not email sending |
| Telegram bot receive | Local pilot imported 2 real messages; last manual sync 0 new, page not full | Bot-selected chat, not personal Telegram history; durable receiver not activated |
| Telegram durable receive/control path | Encrypted queue, registry, auth, disconnect, desktop/mobile acceptance; 35 targeted checks | Background receiver/replies/live secure configuration unfinished |
| SMS/WhatsApp Business receive | Signed HTTP → private journal → UI → persisted disconnect; four real-application-layer desktop/mobile journeys with fixture-signed ingress | No paid provider account, number or live webhook; not personal phone history |
| Messaging account controls | Compact consent/stop disclosure, 24h grants, receipt and stale-account fences; existing-store startup with explicit loopback port | No live configuration, public HTTPS proxy or credential onboarding; permission is not proof of live receiving |
| Slack | Signed HTTP event parsing with selected-channel boundary | No live installation, durable Inbox adapter or runtime |
| Sign-in and request recovery | Compact entry, service-error Refresh, large-text wrapping, exact-request retry lock | Chromium evidence is not physical-device or assistive-technology certification |
| Hosted current integration | Unknown | No deployment/served-byte verification; no release claim |

Executed evidence:

- `4ac7bfc`: **1491/1491** full Node tests, **9/9** runtime/deployment checks,
  **6/6** background browser/package checks. Exact `5a6bdc9` full browser
  regression completed **317/317**, zero skipped, in 326 seconds. This is the
  latest full browser checkpoint, before the schema-only runtime fix.
- `155a33c`: reproduced and fixed same-name malformed grant schemas and
  unexpected triggers; **11/11** focused schema/grant/runtime checks passed
  before the final additional name-prefix assertion (schema tests reran 2/2).
  Exact final checkpoint then passed **1493/1493** full Node tests and **6/6**
  background browser/package checks, zero skipped.
- `2bfc108`: **1480/1480** Node tests, zero skipped, and **10/10** focused
  client/controls/full-path browser checks. Exact row validation and immutable
  disconnect intent close the independent review's client finding.
- `bbed875`: **317/317** full scripted Chromium browser tests and **1472/1472**
  Node tests, zero skipped. Historical full browser checkpoint.
- `627b4db`: **1474/1474** Node tests after messaging UI integration.
- `07c7d80` runtime plus the failure tests committed in `5ea28ec`:
  **1479/1479** Node tests. No runtime edits during this run. Targeted messaging
  tests additionally cover mobile and desktop controls, signed delivery,
  disconnect, rollback/retry, and incomplete-body timeout.
- Independent Grok reviews received for Telegram runtime/packaging, Twilio
  private import/registry/webhook, request recovery and compact entry. Later
  UI/startup reviews subsequently passed at `627b4db`/`14e8055` and `07c7d80`.
  Subsequent independent passes: `2bfc108` client, `17d9e31` grant layer,
  `cec3879` consent UI, `3bf54df` browser journey, `2d65ee5` background webhook.
  Integrated import/consent and newer runtime/entry-point review receipts remain
  pending reconciliation; queued work is not a pass.

These checks do not certify hosted operations, physical devices, SSO/SCIM,
PostgreSQL tenant isolation, retention/backup deletion, or compliance. Detail:
[messaging readiness](MESSAGING-READINESS-2026-09-12.md) and
[Telegram receiver](TELEGRAM-DURABLE-RECEIVER-2026-09-12.md).

### Historical main baseline

| Fact | Value | Source |
|---|---|---|
| Baseline commit | `1a24ad1` (main, Sep 12 2026) | git |
| Schema / writer version | 27 | `server/writer-fence.mjs` `SCHEMA_VERSION` |
| Node floor | >=24.19.0 | `package.json` engines |
| Contract suite | `npm run check`, 138 test files, green on main | `tests/`, CI |
| Browser gates | `npm run test:browser`, 47 scripted checks, green on main | `package.json`, CI |
| Worker packaging | runtime-package exact allowlist + import-closure gate, green | `tests/runtime-package.test.js` |

## Historical main capability inventory

The following qualified labels describe the recorded main baseline above, not a
fresh CI verification of the local integration. Use the current table for newly
implemented connectors and the explicit evidence checkpoints for local readiness.

| Capability | Status | Evidence |
|---|---|---|
| Accounts, invitations, anyone-with-link guests | qualified | tests/invitations*, share-links, account-rooms; browser invitation checks |
| Durable conversation, threads, edit/delete | qualified | tests/conversation, message-thread, message-edit-delete |
| Work ownership, scope claims, blockers, evidence, review, owner decisions | qualified | tests/work-*, claim-scopes, handoff-receipt |
| Explicit reply requests and request attention | qualified | tests/reply-requests, request-attention, reply-request-browser-check |
| Managed agent identities, enrollment, one-time invite codes | qualified | tests/agent-identities, agent-enrollment, agent-invites (PR #126) |
| Connection doctor (read-only self-check) | qualified | scripts/agent-doctor.mjs, tests/agent-doctor (PR #125) |
| Agent access over HTTP API, CLI, local MCP stdio | qualified | tests/mcp-stdio, mcp-lifecycle, mcp-integration, scripts/agent-inbox.mjs |
| Portable task packets and manual result return | qualified | tests/portable-work, return-brief; browser portable-work check |
| Scoped discussion reads, current-attention journals | qualified | tests/current-attention*, attention-read-budget |
| Work search, board projection, room results | qualified | tests/work-search, board-projection, room-results |
| Import/export, recovery, schema upgrades | qualified | tests/recovery*, room-export, agent-upgrade, writer-fence |
| Release evidence manifest, journey coverage map | qualified | scripts/release-evidence.mjs, scripts/journey-coverage.mjs |
| Hosted deployment (worker serving the current build) | **unknown** | Last recorded live: fb90a70 / Worker 901be347 / schema 7 (Sep 8 research). Not reverified since; B7/B8 gate any live claim |
| Hosted AI execution, remote OAuth MCP, execution runner | not delivered | no implementation on main |
| Money movement (funding, payout, refunds) | not delivered | externally gated (backlog section J) |

## Rules

1. A capability not listed here has no availability claim. Unknown means not
   verified, not proof that it is absent. Local implementation is not live service.
2. "Live" requires a fresh served-bytes check against the deployed worker;
   CI green alone never establishes live.
3. Update this file in the same commit that changes any row.
