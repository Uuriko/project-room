# server/http.mjs lines 1251–2500 (http-b)

## Purpose

This range wires the third-party OAuth2 authorization-server surface and the public
(open-web) face of Project Room, plus the account-management and guest-entry APIs.
Concretely: GitHub sign-in + OAuth2 provider (RFC 6749/8414) endpoints, public
receipt/opportunity/offer feeds, the public acquisition pages (GR2), and
account-session, login-method, recovery-code, and guest-invite routes. All route
literals live inline so `scripts/open-routes.mjs` can inventory them.

## Route registrations / handlers (one line each)

**OAuth2 authorization server (third-party connectors, provider side)**
- `GET {GITHUB_START_PATH}` — binds the browser's account-session slot into a
  single-use PKCE state, 302s to GitHub; 503 + readable HTML landing if GitHub
  isn't configured; rate 10/IP.
- `GET {GITHUB_CALLBACK_PATH}` — consumes PKCE state, exchanges code, links or
  provisions the GitHub subject, rotates the slot token (QAS-702); HTML landing
  page for browsers (`?room=` deep-link), JSON body for API clients; OAuth errors
  mapped to 401/422/503/502.
- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata; public
  clients only, `token_endpoint_auth_methods_supported: ["none"]` (PKCE).
- `GET|HEAD /.well-known/feedback` — /feedback standard discovery card
  (intake template, severities, rate limit, verdict enum); advisory, unsigned.
- `GET /oauth/authorize` — validates the authorization request and renders the
  consent screen; unauthenticated users 302 to login; Mac-app client gets custom
  scope copy and a "which account" warning; `code_challenge_method` must be S256.
- `POST /oauth/authorize` — processes allow/deny; CSRF via `x-csrf-token` header
  or form `csrf_token` (timing-safe compare against session); re-validates the
  request first (QA-Auth #720: killed the open redirect on invalid redirect_uri);
  deny redirects with `access_denied`, allow issues code and 302s to client.
- `POST /oauth/token` — `authorization_code` / `refresh_token` exchange; stamps
  read-only IP + User-Agent issuance metadata per token family (F-02).
- `POST /oauth/revoke` — revokes one token; revoking a refresh token kills its
  whole token family; revoking an access token is surgical.
- `GET /api/oauth/sessions` — lists the signed-in account's live token families
  (client, issued-at, scopes, IP/UA); session-bound, caller sees only their own.
- `POST /api/oauth/sessions/revoke-all` — kills every OAuth family for the
  account.
- `DELETE /api/oauth/sessions/:id` — kills one family; unknown ids and other
  users' families both 404 (no probing).

**Readiness / delegated planes**
- `GET|HEAD /api/ready` — 503 when storage unavailable or no rooms; else ready.
- `growth.handle(...)` — read-only growth analytics, failure-isolated to 503.
- `/api/wiki/*` — prefix-delegated to `server/wiki-read-api.mjs` (throws
  ServiceError; fails closed).
- `isPublicRoomDoorPath(...)` — public door: browsers 302 to the workspace app,
  others get the packet (llms.txt); non-GET/HEAD → 405.
- `discoveryDoc(...)` paths — llms.txt, agent card, skills catalog (live
  `members` array injected from `membersDirectory.publishedMembers()`), MCP
  server card (204 on OPTIONS); wrong method → 405.
- `GET|HEAD /openapi.json` (+ `/room` alias) — spec generated from the canonical
  route table, never hand-maintained.

**Public work / offers / opportunities**
- `GET /api/public/rooms/directory` — owner opt-in room directory for fresh
  identities; registered BEFORE the `/api/public/rooms/{code}` matcher on
  purpose; non-GET → 405.
- `POST /api/public-work/match` — open-work matching; rejects any query params
  (422); rate 60/IP.
- `GET|HEAD /api/public-work/receipts/:id/review` — contributor's own review
  state (identity-secret auth, contributor-scoped); no query params.
- `GET|HEAD /api/public-work/tasks[/:id[/claim|renew|release|finish]]` and
  `GET|HEAD /api/public-work/receipts[/:id[/artifact]]` — public claim board;
  write actions require the identity secret, re-authenticated inside the store
  transaction; `finish` gets a 512KB body limit; artifact download is
  `text/plain` attachment with `nosniff`; owner-only private-receipts toggle
  honored with a member override for rooms that flipped privacy off.
- `GET|HEAD /api/project-offers[/:id[/brief.md]]` — public project offers;
  markdown brief served as `text/markdown`.
- `GET /api/opportunities.json` — read-only opportunity feed v2 with `?since=`
  resume cursor; non-GET → 405.
- `GET /p/:code`, `GET /api/public/rooms/:code`, `GET /api/public/rooms/:code/feed` —
  public room face (HTML or JSON by Accept); unknown codes 404 as
  `face_not_found` inside the module so boundary probes read served-open.
- `GET /a/:code` — delegated to `handleAgentConnect` (ACT-2a page).

**Receipts / acquisition / legal / assets**
- `GET|HEAD /receipts`, `/api/public/receipts`, `/receipts/:id(.json)` — public
  receipts; `Cache-Control: no-store` always (toggle-controlled representations
  must not sit in shared caches); `?limit=abc` → 422 `invalid_receipt_query`
  downstream.
- `301 /join.html → /join`, `/favicon.ico → /favicon.svg`.
- `legalApiPaths` / `isLegalPath(...)` — delegated to `handleLegalRequest`
  (terms, abuse reports, operator unpublish).
- `GET|HEAD /sitemap.xml` — receipt + template + legal + GR2 entries; asset
  bytes confirmed readable before advertising.
- `GET|HEAD /templates`, `/templates.json`, `/templates/:slug(.json)`,
  `/agents`, `/r/:slug(.json)` — GR2 acquisition pages; browsers hitting an
  unknown `/r/<slug>` get a styled HTML 404, not the JSON envelope.
- static assets — canonical redirects, `X-Robots-Tag` on reviewed paths, binary
  caching for png/ttf.

**Account system**
- `GET /api/account-rooms`, `POST /api/account-rooms` (create, 201/200
  duplicate), `POST /api/account-rooms/from-template` (GR2 template → room).
- `POST /api/account/ensure-default-room` — idempotent first-sign-in room;
  never resurrects a room for an account that deliberately left.
- `GET|POST|DELETE /api/account-session` — slot minting (GET mints only for
  anonymous; a supplied binding never mints/rotates), account-key login with
  atomic slot rotation (QAS-702), logout by `expectedSessionRevision`.
- `POST /api/auth/recovery-codes/generate`, `GET .../status`,
  `POST .../redeem` — one-time-shown codes; redeem verifies the session slot
  BEFORE burning a code and rotates the slot on success.
- `GET /api/auth/methods`, `POST /api/auth/methods/{disable,enable,remove}` —
  login-method management; the model refuses to disable/remove the last active
  method; verifiers never exposed.
- `POST /api/auth/password/set` — attach a first password (409 if one exists;
  needs a verified email method + policy check).
- `GET /api/auth/github/link/start`, `GET /api/auth/google/link/start` —
  link-intent OAuth flows; auth runs FIRST so anonymous callers learn neither
  provider config nor anything else (slice 7 hardening).
- `GET|POST /api/account/profile`, `GET /api/account/onboarding`,
  `POST /api/account/onboarding/complete`, `GET /api/account/retention`,
  `GET /api/account/deletion/plan`, `POST /api/account/delete` — profile,
  onboarding, retention policy, and confirm-then-delete: the plan is re-computed
  live and the confirmation token verified against the fresh plan (data changed
  after confirmation → 409 `plan_changed`).

**Guest entry**
- `GET|HEAD /api/guest-agent-links` (contract), `POST` (mint; requires a room
  credential + membership-level auth), `POST /preview`, `POST /join` (admits,
  shadow-mode jev admission journaling), `POST /refresh` (v0 expired-credential
  self-service refresh — possession of the expired bearer is the proof).
- `GET|HEAD /api/guest-invites` (contract), `POST /preview`, `POST /redeem`
  (identity secret as Bearer header, never the body; signed agent card required;
  per-code rate 5), `POST /request` (self-serve: signed card is the entire
  credential; shadow-mode jev journaling).

## Auth patterns

- **Account-session cookie** (HttpOnly slot cookie) + `X-Session-Binding` header
  + `protectWrite(req, auth, ...)` for cookie writes; `checkOrigin` for
  CSRF-sensitive endpoints. `requireAccountSession()` centralizes the
  authenticate → 401 funnel for management routes.
- **QAS-702 slot rotation**: every login path (account key, GitHub, Google,
  recovery-code redeem) mints a fresh slot token in the same store transaction
  and invalidates the pre-login token — a planted pre-login token can never
  authenticate afterward.
- **OAuth provider**: PKCE S256-only; consent CSRF token compared with
  `timingSafeEqual`; refresh-token reuse revokes the whole family (F-01) and
  logs a structured security line; deleted accounts fail closed on token
  verification; session families scoped to the owning user.
- **Guest/public auth**: identity secret travels as `Authorization: Bearer`;
  guest invite codes are public-safe single-use hash-stored handles; the
  `ga1.` credential is only issued at redemption.
- **Rate limiting**: `rate(key, n)` per-IP buckets at every public/mutating
  endpoint; extra per-identity or per-code buckets on sensitive paths
  (public-work identity 60, invite redeem 5/code, recovery redeem 10/15min/email).

## Invariants

- Route literals stay in this file — `scripts/open-routes.mjs` extracts them
  statically; route templates use the extractor-friendly `([^/]{1,128})` form.
- Wrong method answers 405 (with `Allow`), not 404 — a mistaken GET reads as a
  method error, never as a missing route.
- Strict query-shape enforcement on public surfaces: unexpected query params →
  422 with a domain code (e.g. `invalid_public_work`, `invalid_receipt_query`).
- Matcher order is load-bearing: `/api/public/rooms/directory` before
  `/api/public/rooms/:code`; typed-envelope/GR1 aliases rewrite before
  downstream matchers.
- Toggle-controlled representations (`/receipts`, public faces) are never
  cached in shared caches (`Cache-Control: no-store`).
- Error responses on OAuth/account flows never carry tokens; provider
  misconfiguration answers 503 with an honest `*_not_configured` reason.

## Top callers

- `scripts/open-routes.mjs` (route inventory), `scripts/routes-inventory.mjs`,
  `docs/openapi.yaml` gate — all parse this file's literals.
- Room server tests: `tests/http-oauth-*.test.js`, account/recovery/oauth
  suites; public-face tests for receipts/opportunities.
- `server/discoverability.mjs` `buildOpenApiJson` — generates `/openapi.json`
  from the canonical route table.
- External: third-party connector clients (OAuth flow), browsers (consent
  screen, GitHub/Google callbacks), public crawlers (sitemap, receipts).

## Gotchas

- `bearer(req)` returns `null` when the Authorization header is absent but
  `reject(401)`s on a malformed one — handlers that pass it straight to the
  store (`publicWorkClaims.match`, review routes) rely on the store to 401 on
  null; don't assume a non-null credential past the call.
- The `/receipts/:id` detail regex only matches the `/receipts/...` form —
  `/api/public/receipts/:id` is NOT matched by `receiptDetail` and falls
  through to the unknown-route 404.
- `gr1PublicPath` / `gr2PublicPath` mutate `url.pathname` in place before the
  receipts handler runs — alias rewrites are order-sensitive.
- `GET /api/account-session` with a binding header never mints, rotates, or
  clobbers — it only confirms; minting happens only on the anonymous path.
- The public-work `finish` action allows a 512KB body (escaped JSON over the
  64KiB artifact); every other action keeps the default envelope limit.

## Stale comments

- `server/http.mjs:1254–1257` — the header comment says the GitHub callback
  "returns the upgraded session as JSON (a same-origin landing page is out of
  scope for this slice)", but slice 7 added `githubHtml()`/`githubLanding()`
  (lines 1305–1316): browsers now get a 200 HTML landing page that deep-links
  to `/?room=<first-room>`. The parenthetical is outdated.
- `server/http.mjs:1692–1697` (`/.well-known/feedback` comment) — says it
  "Mirrors docs/feedback-endpoint.md §7". The doc now lives at
  `docs/history/feedback-endpoint.md` (not `docs/feedback-endpoint.md`), and
  §7 there is "Adoption guide" — the field list in the comment actually mirrors
  §1 ("Discovery"). Both the path and the section number are stale.
