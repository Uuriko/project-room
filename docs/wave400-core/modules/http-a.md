# server/http.mjs lines 1–1250 (http-a)

## Purpose

Module head and server factory for Project Room's HTTP layer. This range
holds all imports, module-scope constants/helpers, and the `createRoomServer`
factory up through its request-preamble, auth/rate-limit/origin machinery, and
the first inline route cluster: `security.txt`, the MCP and A2A mounts, the
route-table handoff (`dispatchRoute`), health/version liveness, the Gmail
OAuth callback, Google sign-in start/callback, and the email-verify pair.
Everything after line 1250 (GitHub OAuth, OAuth2 provider routes, public
feeds, account management, guest/invite/join APIs, room-scoped routes) builds
on the primitives established here.

## Public API in this range

- `createRoomServer(options)` (~line 301) — builds the Node HTTP server.
  Validates options (HTTPS origin when `trustedLocalProxy`, positive
  `streamQueueCap`/`streamInterval`, `channelTransports` function shape,
  cookie-namespace charset, magic-mailer interface, Telegram config shape);
  wires service singletons (rate limiter, channel senders, OAuth2 provider,
  agent-plugin/operator/next-actions route modules, send budgets) and returns
  the `node:http` server. Top caller: `server.mjs`.
- `touchLruEntry(map, key, makeValue, capacity)` (line 269) — exported LRU
  helper for small internal caches; used by the channel-transport resolver
  (cap 2000). Exported for unit tests.

## Route registrations (one line each)

- `/.well-known/security.txt`, `/security.txt`, `/room/.well-known/security.txt`
  (951) — serves RFC 9116 contact from `ROOM_SECURITY_CONTACT`; 404 + warn
  once when unset/unusable; GET/HEAD only, else 405.
- MCP mount (986) — any `isRoomMcpPath` (incl. `/room/api` rewrite): rate
  60/IP, POST reads body (larger cap when a `pri_`/`rak_` bearer stages a
  room file), delegates to `writeRoomMcpNode`. Skips the origin gate.
- A2A mount (1001) — `isA2aPath`: rate 60/IP, POST reads JSON body,
  delegates to `writeA2aNode`. Skips the origin gate.
- Edge-door preview bypass (1006) — POST `/api/share-links/preview` (and
  `/room/` twin) from getdasha edge-door origins skips the global
  `checkOrigin`; route-level `checkPreviewOrigin` still runs later.
- Public receipts CORS (1012) — GET/HEAD/OPTIONS on public-receipt paths
  get `Access-Control-Allow-Origin: *`; OPTIONS answers 204 immediately;
  `checkOrigin` skipped.
- Route table (1033) — `await dispatchRoute({...})`; a truthy return ends
  the request. Everything else falls through to the legacy inline chain.
- `/api/health`, `/api/health/`, health aliases, `/api/version` (1071–1077)
  — GET/HEAD liveness; version adds `sourceRevision`/`buildId`. Known
  liveness path + wrong method → 405 with `Allow: GET, HEAD` (1079).
- `/api/auth/gmail/callback` (1088) — rate 20/IP; completes Gmail OAuth,
  clears the `gmail_oauth` cookie, attempts one sync (failures → `sync-error`
  result, never a 500), returns a same-origin meta-refresh page.
- Google start (1104, `GOOGLE_START_PATH`) — GET only; reuses the browser's
  account-slot cookie (replacing only a stale/unauthenticated slot) or mints
  one, binds PKCE state to it, 302s to Google. 503 JSON or HTML redirect to
  `/?google=unavailable` when unconfigured. Rate 10/IP.
- Google callback (1138, `GOOGLE_CALLBACK_PATH`) — GET only; completes
  PKCE, links/provisions the Google subject (`linkGoogleSubject[ToAccount]`),
  rotates the slot token (QAS-702), revokes the old room token, lands on the
  first room or `/?account=1`. Errors return a same-origin HTML page with
  `X-Room-Auth-Failure`/`X-Room-Auth-Diagnostic` headers; tokens never
  appear in error responses.
- `POST /api/auth/email/verify` (1193) — account session + CSRF required;
  consumes the code via `store.accountLogins`.
- `POST /api/auth/email/verify/resend` (1212) — account session + CSRF +
  rate 5/account; mints a fresh code; delivery failures swallowed so the
  response never leaks whether mail sent; 503 `mail_not_configured` when the
  mailer is off; `already_verified` short-circuit.

## Middleware / auth patterns established here

- Global response headers on every request: `Cache-Control: no-store`,
  `nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag`, HSTS (no
  includeSubDomains, deliberate), a fixed CSP, locked-down
  `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`.
- Host gate (946): `Host` must equal the configured origin's host, else 403.
- Origin gate (1016): `checkOrigin(req)` on everything except the two
  carve-outs above; `carriesBearer` waives the Origin requirement for
  requests with an `Authorization: Bearer` credential (the credential *is*
  the auth; validity still enforced per-route).
- `protectWrite` (793): cookie sessions need matching origin + a 64-hex
  `x-csrf-token` compared with `timingSafeEqual` against `auth.csrf`;
  bearer calls skip CSRF.
- Scoped cookies (634): `__Host-` prefix on HTTPS + optional namespace;
  duplicate same-name cookies → 401 `ambiguous_session_cookie`.
- `bearer()` (708): RFC 7235 case-insensitive scheme; token shapes
  43-char, `ga1.`, `pri_`, `rak_`; anything else → 401.
- `rate(id, maximum)` (675): per-family token buckets, 1-minute fixed
  windows, max 2000 live keys per family with LRU-family eviction, durable
  families persisted to the abuse-rate table on a stride; 429 carries
  `X-RateLimit-*` headers and `Retry-After`.
- `signInSlotToken` (1029): sign-in JSON routes accept the slot token from
  the HttpOnly cookie (CSRF-checked here) or an explicit `sessionToken`
  body field for API clients; `exact()` field-shape validation → 422.
- `body()` (821): JSON-only, 16 KiB default cap, 413 names limit and actual
  size; `readText` drains oversize bodies in the background so the client
  still reads the 413.
- `stream()` (838): SSE pump with per-connection send queues; lagging
  consumers get one `stream_lagging` event then a 5 s drain grace before the
  socket is dropped; typing indicators ride as id-less synthetic events;
  401/403 or binding change → `access-ended`.
- Shadow admission (958): `jevShadowAdmission` scores joins and journals the
  would-be decision; never throws, never enforces.

## Invariants

- Route literals stay inline in this file so `scripts/open-routes.mjs` can
  inventory the API (`legalApiPaths` set at 336 names the legal-API paths).
- Trailing slash normalized once up front (950); only the `URL` object is
  rewritten, `req.url` untouched for diagnostics.
- Every `/api/` response carries `X-Operation-Id` (1020).
- `reject()` throws `ServiceError`; the outer catch renders it (later range).
- OAuth PKCE pending state lives in the store (isolate-eviction safe), not
  in memory (google 374, github 425).
- Login rotates the slot token and invalidates the pre-login one (QAS-702).
- The Jev shadow gate and Gmail sync failures can never turn a good request
  into a 500.

## Top callers

- `server.mjs` — constructs via `createRoomServer`.
- `server/routes/dispatch.mjs` + route modules — receive the helpers
  (`json`, `reject`, `rate`, `cookie`, `body`, `bearer`, `protectWrite`,
  `roomAuth`, `signInSlotToken`, …) as the dispatch context.
- Tests — `touchLruEntry`, passkey/magic-link injection points.
- Later ranges of this file — every closure defined here
  (`rate`, `json`, `body`, `cookie`, `accountBinding`, `publicPageLinks`,
  `sessionAccountView`, …).

## Gotchas

- `rate()` sweeps *all* live keys for expiry on *every* call — O(n) per
  request; fine at current scale, a hotspot if key counts grow.
- `timingSafeEqual` in `protectWrite` is length-safe only because
  `store` always mints `auth.csrf` as 64-hex sha256 (store.mjs:430);
  the `bindingPattern` pre-check on the presented token is what keeps the
  compare constant-time.
- The MCP/A2A mounts deliberately skip the global origin gate (they do
  their own auth inside `writeRoomMcpNode`/`writeA2aNode`).
- `dispatchRoute` returning falsy silently falls through to the legacy
  chain — a route-table miss is not a 404 by itself.
- `expectedOrigin()` falls back to `server.address().port`; it must not
  be called before the server is listening.

## Stale comments

- server/http.mjs:199–201 — the `gr1PublicPath` comment says "Static
  marketing (/about, /offers, /compare, images) stays off this server. The
  edge serves those…", but lines 128–130 register `/compare/<name>` AEO
  pages in this server's own `assets` map and serve them inline. One of the
  two statements is outdated.
