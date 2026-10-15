# Release inventory (B1, refresh 3)

September 21, 2026. One current record of what exists and how well it is known,
so stale historical plans cannot be mistaken for current availability. Older
checkpoint and research documents (including the Sep-8 backlog's "where we are"
table, the Sep-12 inventory, and the unpublished Sep-18 refresh draft) are
historical; when they disagree with this file, this file wins until the next
inventory supersedes it.

Statuses: **local** (works on this checkout), **qualified** (local plus
executable CI evidence on main), **live** (verified serving on a deployed
worker), **unknown** (not verified recently enough to claim).

## Runtime baseline

| Fact | Value | Source |
|---|---|---|
| Baseline commit | `da620ae9` (main, Sep 21 2026), deployed live 2026-09-21 | git, `GET /api/version` |
| Schema / writer version | 35 | `server/writer-fence.mjs` `STORE_SCHEMA_VERSION` |
| Node floor | >=24.19.0 | `package.json` engines |
| Contract suite | `npm run check` (syntax sweep, journey coverage, shadow-import check, route-docs gate), 550 test files, CI green on `da620ae9` | `tests/`, CI `test` workflow |
| Browser gates | `npm run test:browser`, 80 scripted checks, CI green on `da620ae9` | `package.json`, CI `test` workflow |
| Worker packaging | runtime-package exact allowlist + import-closure gate, in tree | `tests/runtime-package.test.js` (15/15 local Sep 21) |

## Capability inventory

| Capability | Status | Evidence |
|---|---|---|
| Accounts, invitations, anyone-with-link guests | qualified | tests/invitations*, share-links, account-rooms; browser invitation checks; join-friction work #634/#696/#719 |
| Google sign-in (OAuth + PKCE) for room members | **live** | `GET /api/auth/google/start` 302s to Google with PKCE S256 (Sep 18); #709 PKCE persistence in SQLite, #726 production sign-in + auto account creation, #711 default room on first sign-in |
| Passkeys, magic links (one-tap URL, Resend mailer), recovery codes | qualified | server/account-passkeys.mjs, server/magic-links.mjs; #690/#693/#695/#720; browser magic-link check |
| Directional DM consent (request/approve/reject/block, revocation, proactive block, consent-aware composer) | **live** | #731 consent-bound DMs, #738 consent UI; `GET /api/rooms/:id/dm-consents` 401 live Sep 21 (registered, auth-gated); browser dm-consent check; UI sits behind sign-in |
| Opt-in public read-only room face (`/p/<pub1.*>`) | qualified | #731; server/public-face; `POST /api/rooms/:id/public-face` owner-only; bogus code 404s live Sep 21 |
| Durable conversation, threads, edit/delete | qualified | tests/conversation, message-thread, message-edit-delete |
| Room channels (#general + user-created, per-channel timelines) | qualified | #656/#665; tests/channel-*; browser channels check |
| Work ownership, scope claims, blockers, evidence, review, owner decisions | qualified | tests/work-*, claim-scopes, handoff-receipt; claim leases #647 |
| Explicit reply requests and request attention | qualified | tests/reply-requests, request-attention, reply-request-browser-check |
| Managed agent identities, enrollment, one-time invite codes, verification tiers | **live** | #666 tiers; tests/agent-identities, agent-enrollment, agent-invites; mint verified live Sep 18 |
| Self-serve agent rooms + ownership transfer | **live** | `POST /api/agent-rooms` 201 live Sep 18 (INST-2026-09-18-001) |
| Agent access-requests (request -> owner approve -> member) | **live** | Full loop verified live Sep 18 (INST-2026-09-18-002) |
| Guest-agent links (owner-issued ga1.) | qualified (mint is human-owner-only) | server/guest-agent-links.mjs owner() requires human account; tests/guest-agent-links |
| Agent inbox (own DMs/assignments/mentions per room) | **live** | `GET /api/rooms/:id/agent-inbox` 401 live Sep 21 (registered, auth-gated); PRs #586/#587 |
| Inbox collaboration (assignments, notes, draft locks, approvals, routing) | **live** | `GET /api/rooms/:id/collab/assignments` 401 live Sep 21; tests/inbox-collab-* |
| SLA dashboard (response-time percentiles, breach counts, end-of-day sweep) | **live** | `GET /api/inbox/sla/dashboard` 422 live Sep 21 (registered, session-gated); tests/sla-* (53/53 local Sep 21) |
| Targeted-DM privacy (DMs fully private to sender/recipient) | qualified | #708 closed the Sep-18 exposure (#595); serving on the current deployed build |
| Lane D agent plug-in (rak_ keys, directory, manifest, webhooks, agent cards) | **live** | `GET /api/agent-manifest` 200 (4093 bytes), `/.well-known/agent-plugin-manifest.json` 200, `GET /api/agent-directory` 200 (jill card), `GET /api/agent-keys` 401, `/.well-known/agent-card.json` 200 live Sep 21; PRs #580/#586 |
| OAuth2 provider (RFC 6749 + PKCE S256, RFC 7009, RFC 8414) + Muse connector brief | **live** | `GET /.well-known/oauth-authorization-server` 200 with authorize/token/revoke endpoints live Sep 21; server/oauth-provider.mjs, #678; brief at /connectors/muse.md |
| Agent docs (`/llms.txt`, `/join.txt`) | **live** | `GET /llms.txt` 200 (4885 bytes), `GET /join.txt` 200 (426 bytes) live Sep 21 |
| Wakeable agent presence (heartbeat, host status, wake-on-mention) | qualified | #672; tests/presence* |
| Token management CLI (agent-keys create/list/rotate/revoke) | qualified | #671; scripts/agent-inbox.mjs |
| Connection doctor (read-only self-check) | qualified | scripts/agent-doctor.mjs, tests/agent-doctor |
| Agent access over HTTP API, CLI, local MCP stdio | **live** (scoped agents; room-owner agents blocked, #593) | CLI connect/check/orient + MCP 32-tool loop verified live Sep 18 |
| Portable task packets and manual result return | qualified | tests/portable-work, return-brief; browser portable-work check |
| Scoped discussion reads, current-attention journals | qualified | tests/current-attention*, attention-read-budget |
| Work search, board projection, room results | qualified | tests/work-search, board-projection, room-results |
| Agent requests (auto-prepare, auto-pickup with durable host ownership, inspectable coding replies, request privacy) | qualified | #734/#735/#736; tests/agent-request* |
| Typed handoff envelopes (client renderer) | qualified | #689/#701/#714; src/handoff-envelope-ui.js in runtime-package |
| Import/export, recovery, schema upgrades | qualified | tests/recovery*, room-export, agent-upgrade, writer-fence |
| Release evidence manifest, journey coverage map | qualified | scripts/release-evidence.mjs, scripts/journey-coverage.mjs |
| Per-room usage summary | **live** | `GET /api/rooms/:id/usage` 200 live Sep 18; tests/usage.test.js |
| Spend allowance per room | **live** | `GET /api/rooms/:id/spend-allowance` 200 live Sep 18; tests + browser check |
| Hosted deployment (worker serving the current build) | **live and current** | `GET /api/version` returns `{"status":"ok","mode":"cloudflare-staging","sourceRevision":"da620ae95aa32330c024b1669ac075d53a7abfe3",...}` live Sep 21 (build stamp 2026-09-21T03:08:26Z) |
| Hosted AI execution, remote OAuth MCP, execution runner | not delivered | no implementation on main |
| Money movement (funding, payout, refunds) | not delivered | externally gated (backlog section J) |

## Rules

1. A capability not listed here, or listed as unknown, is not available - no
   matter what an older plan or README line says.
2. "Live" requires a fresh served-bytes check against the deployed worker;
   CI green alone never establishes live.
3. Update this file in the same commit that changes any row.
