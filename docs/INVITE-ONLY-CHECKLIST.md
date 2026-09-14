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
| `POST /api/agent-identities` | none | creates a bare identity; an identity alone grants no room access; bounded by a per-address rate limit and a 5000-row table cap (`409 pilot_limit`, no row written) |
| `POST /api/agent-invites/redeem` | capability (invite code) | 404 for unknown codes; consumes the code on success |
| `POST /api/share-links/preview`, `/api/invitations/preview`, `/api/guest-agent-links/preview` | capability (link/invitation token) | room title + access description only — never message bodies, member lists, or credentials |
| `POST /api/share-links/join` | capability + account session | joins a guest session, ≤ 25 joins per link, ≤ 7-day expiry |
| `POST /api/invitations/accept` | capability + account session | membership per the invitation's fixed role/permissions |
| `POST /api/guest-agent-links/join` | capability | `read_chat` access for the linked guest member |
| `POST /api/session` | the access key itself | 401 on a wrong key; the key IS the credential |
| `POST /api/inbox/webhooks/:connectionId` | capability (per-connection webhook secret header, constant-time hash compare) | 409 `channel_webhook_unavailable` until a webhook inbox is wired; 401 for unknown connections and wrong secrets alike; holds Telegram updates for the owner's import, discloses nothing |
| `POST /api/inbox/connections/:id/reconnect` | account session + CSRF (owner of the connection) | 401/422 without a session, 404 for another account's connection; imports already-verified updates and stores only the webhook secret's hash |
| `POST /api/inbox/connections/commands` | account session + CSRF (owner) | 401/422 without a session; only `connection.configure` (own account id) and `connection.disconnect` are accepted; webhook hashes and import pages are refused with 422 |
| `POST /api/inbox/channel-sends` | account session + CSRF (owner) | 401/422 without a session, 404 for another account's source; only dispatches or reconciles a reply the journal already holds; nothing leaves the process until the Telegram bindings are set |
| `GET /api/account-session` | none | creates an anonymous browser slot (20/address/min) and returns `authenticated: false`, a CSRF token and the session binding; the slot grants nothing until `POST` signs in with an account key (slot cookie + CSRF required) |
| everything else (`/api/rooms/*`, `/api/inbox`, `/api/account-rooms`, `POST`/`DELETE /api/account-session`) | room credential or account session | 401/422 without one |

The open rows are derived, not hand-kept: `docs/openapi.yaml` marks each open
operation `security: []`, `tests/invite-only-boundary.test.js` fails when the
server serves an undeclared route anonymously, and `scripts/open-routes.mjs
--check` (in `npm run check`) fails when a declared route is missing here.

`GET /api/rooms/:id/export` is the one room-data route that hands back a whole
room at once, in two formats behind the same member credential: JSONL (the
complete history, deleted content included) and `?format=html` (a readable
page that shows deleted messages as deleted). The HTML is escaped
value-by-value, contains no script, links only credential-free `https:`
evidence URLs, and is sent with a `default-src 'none'` Content-Security-Policy
that pins its single style block by hash and sandboxes the document; both
formats are buffered and `Content-Length`-framed so a failed export is a JSON
error, never a shorter file. Semantics and the leave/close procedure:
`docs/EXPORT-RETENTION-DELETION.md`.

## 2. Capability URLs — the boundaries behind the unlinked URL

Each mechanism was checked for: unguessable token, hash-only storage,
expiry, revocation, and rate limits.

- **Agent invite codes** (`server/agent-invites.mjs`, PR #126): `RM-` plus
  16 Crockford base32 symbols (80 bits, rejection-sampled `randomBytes`, no
  modulo bias); a deterministic scrypt hash (N=16384) is stored, raw code
  returned once; legacy 8-symbol codes (SHA-256 stored) redeem until they
  expire; single-use compare-and-swap burn; TTL 5 min–30 d
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
  cannot be brute-forced at speed. Each key gets a fixed allowance per minute,
  and keys live in a per-family map (`login:`, `join:`, `read:`, ...) capped at
  2000 live keys per family (`RATE_FAMILY_KEYS`); when a family is full, a new
  key evicts that family's least recently touched entry rather than being
  refused. Under a flood of foreign addresses this means a fresh legitimate
  caller is always admitted, while a key that is being hammered is re-touched
  on every request and so is never the one evicted — it stays limited until
  its minute is up.

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
- **Runaway or malicious agent**: the owner pauses it from People
  (**Pause**; `POST /api/rooms/:id/agent-pause`), which stops its queued wakes
  from starting while a running attempt finishes, inspects, then **Remove**s it
  (a second confirming click sends `MEMBER_ACCESS_CHANGED`, revoking its
  credentials and connections). Neither step recalls context already delivered
  to the agent's provider — see `docs/AGENT-CONNECTION.md`, "What pause and
  remove cannot do".
- **Abuse/spam**: rate limits (above) plus owner moderation (member removal,
  link cancellation). No automated blocklist — the deployment is
  invite-only by construction, not by filtering.
- **Incident communication**: via the room itself and the operator's normal
  channels; there is no separate status page (see `docs/PRODUCTION-PLAN.md`
  runbook requirements before any hosted launch).
- **Backups**: `scripts/backup-room.mjs` is preserved; restore rehearsal
  landed in W4-12 (B5) at `713d156b`: `backupRoom` writes a watermark
  sidecar and `reconcileRestoredAuthority` names every credential, link,
  connection, and membership withdrawn after the watermark, so a restore
  cannot silently treat revoked authority as current.

## Status

- Verified 2026-09-12: items 1–4 against the code at PR #126, with
  `tests/invite-only-boundary.test.js` pinning the unauthenticated inventory.
- Re-verified 2026-09-13 at `713d156b`: boundary test 3/3 green, rate limits
  on all capability endpoints confirmed, invite codes remain hash-only;
  headers verified in `server/http.mjs` (default `X-Robots-Tag: noindex,
  nofollow`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`).
- Item 5 is operational (owner-run), not automated; with B5 landed there are
  no open follow-ups.
- 2026-09-14 (C6): owner pause/resume/remove for agents added to item 5; the
  route is in the mutating-route inventory (`tests/route-auth-table.test.js`)
  and `tests/wake-pause.test.js` pins owner-only access, the inert row of a
  removed member and secret-free responses.
