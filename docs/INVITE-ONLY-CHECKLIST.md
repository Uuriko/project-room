# Invite-only operating checklist (W4-13 · B6)

Done when an unlinked URL is not the sole privacy boundary. Verified against
the code and pinned by `tests/invite-only-boundary.test.js`. Review this file
whenever that test's unauthenticated-inventory assertion is touched.

## 1. Access controls — unauthenticated HTTP surface

Every `/api/*` route is either open by design (below) or requires a credential
(401). There is no room-data route reachable without one.

| Endpoint | Auth | What it discloses |
|---|---|---|
| `GET /api/health`, `/api/version`, `/api/ready` | none | operational metadata only |
| `GET /api/guest-agent-links`, `/api/work-item-sessions` | none | static contract documents, no room data |
| `POST /api/agent-identities` | none | creates a bare identity; an identity alone grants no room access |
| `POST /api/agent-invites/redeem` | capability (invite code) | 404 for unknown codes; consumes the code on success |
| `POST /api/share-links/preview`, `/api/invitations/preview`, `/api/guest-agent-links/preview` | capability (link/invitation token) | room title + access description only — never message bodies, member lists, or credentials |
| `POST /api/share-links/join` | capability + account session | joins a guest session, ≤ 25 joins per link, ≤ 7-day expiry |
| `POST /api/invitations/accept` | capability + account session | membership per the invitation's fixed role/permissions |
| `POST /api/guest-agent-links/join` | capability | `read_chat` access for the linked guest member |
| `POST /api/session` | the access key itself | 401 on a wrong key; the key IS the credential |
| everything else (`/api/rooms/*`, `/api/inbox`, `/api/account-*`) | room credential or account session | 401/422 without one |

## 2. Capability URLs — the boundaries behind the unlinked URL

Each mechanism was checked for: unguessable token, hash-only storage,
expiry, revocation, and rate limits.

- **Agent invite codes** (`server/agent-invites.mjs`, PR #126): `RM-XXXXXXXX`
  from 32+ bits of `randomBytes`, Crockford alphabet; SHA-256 hash stored,
  raw code returned once; single-use compare-and-swap burn; TTL 5 min–30 d
  (default 24 h); revocable before redemption; issuer authority re-checked at
  redemption; `manage_members`/`decide` can never be granted.
- **Share links** (`server/share-links.mjs`): client-generated 43-char
  base64url token (256-bit), hash stored; expiry ≤ 7 days; max 25 joins;
  revocable (`share-links-cancel`); collisions against all credential tables
  rejected; preview shows title/access only.
- **Guest-agent links** (`server/guest-agent-links.mjs`): same 256-bit token
  shape; credential rows carry `expires_at` and `revoked`; liveness re-checked
  on preview and join.
- **Invitations** (`server/store.mjs` `membership_invitations`): token hash
  stored, `expires_at` enforced, `accepted`/`revoked` states, token conflicts
  rejected across credential tables.
- **Rate limits** (`server/http.mjs`): preview/join/redeem/login endpoints are
  per-IP (and per-token where it matters) rate-limited, so capability URLs
  cannot be brute-forced at speed.

## 3. Indexing

- Every HTTP response carries `X-Robots-Tag: noindex, nofollow` and
  `Cache-Control: no-store` (`server/http.mjs`). The HTML door carries
  `<meta name="robots" content="noindex,nofollow">`.
- The only indexable surface is deliberate: the public agent-discovery
  packets (`/llms.txt`, `/room/llms.txt`, `/skill.md`, `/room/skill`,
  `agent.json`, `/kits.txt`), which describe how to connect — they contain no
  room content, member lists, or credentials.

## 4. Logs

- Raw invite codes, access keys, and link tokens are never written to logs or
  the database — hashes only (covered by `tests/agent-invites.test.js` and the
  recovery fixture's redaction assertions).
- Every `/api/*` response carries an `X-Operation-Id` (`op_` + 48 random bits)
  so support can correlate a failure without the caller pasting a credential.
  The operation id is echoed in error payloads as `operationId` with a
  coarse `category`, never with request bodies or room content.
- `node scripts/agent-inbox.mjs doctor` is read-only and prints no secrets.

## 5. Support and incident ownership

- **Owner**: the room owner (or a human with `manage_members`) owns access
  control — minting/revoking invite codes, links, and invitations; removing
  members; rotating compromised credentials. The audit surface is
  `invite-codes` (CLI) and the room's invitation/link lists.
- **Compromised capability URL**: revoke the link/invitation/code (all three
  support revocation); for a leaked access key, remove the member and re-issue.
  Capability tokens are single-purpose, so a leak's blast radius is bounded to
  that token's scope.
- **Abuse/spam**: rate limits (above) plus owner moderation (member removal,
  link cancellation). No automated blocklist — the deployment is
  invite-only by construction, not by filtering.
- **Incident communication**: via the room itself and the operator's normal
  channels; there is no separate status page (see `docs/PRODUCTION-PLAN.md`
  runbook requirements before any hosted launch).
- **Backups**: `scripts/backup-room.mjs` is preserved; restore rehearsal is
  W4-12 (B5), not yet done — restoring a backup must not resurrect revoked
  credentials as live; that check is tracked there.

## Status

- Verified 2026-09-12: items 1–4 against the code at PR #126, with
  `tests/invite-only-boundary.test.js` pinning the unauthenticated inventory.
- Item 5 is operational (owner-run), not automated; the restore-rehearsal
  caveat is the one open follow-up.
