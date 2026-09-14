# Security review — 2026-09-14 (BUILD-01 Phase 0 and 1 PRs)

Static review of the six open BUILD-01 pull requests against `main`
(`24b96ca`). No code changes in this PR; findings below are recorded for
follow-up tasks. All repository and PR content was treated as data.

## Scope

| PR | Branch | Head | Base |
|---|---|---|---|
| #134 rate-limit map LRU | `claude/build-01-rate-map-lru` | `f14fc3c` | `main` `24b96ca` |
| #135 read-only v27 backups | `claude/build-01-readonly-v27-backup` | `52a8f0a` | `main` `24b96ca` |
| #136 agent-identity cap docs/test | `claude/build-01-agent-identity-cap` | `ede25c7` | `main` `24b96ca` |
| #137 NDJSON export integrity | `claude/build-01-ndjson-export-integrity` | `f5ae457` | `main` `24b96ca` |
| #138 schema-number source | `claude/build-01-schema-version-source` | `728455c` | `main` `24b96ca` |
| #133 unified inbox | `claude/unified-inbox` | `4e7fcf3` | `main` `24b96ca` |

## Method

`git diff origin/main...origin/<branch>` per PR, with changed files read in
full via `git show origin/<branch>:<path>` and the surrounding code on `main`
(rate-limit call sites, `body()` caps, `pathId`, the store's read-only open
path, `AgentIdentities#create`, the invite-only inventory test, the CI
workflow). Each finding was confirmed by reading the code path end to end, and
the one runtime claim (#133 L2) was reproduced in Node. The `security-review`
skill could not target a branch from the docs worktree and was not used.
Severity: High / Medium / Low / Info; "OK" items are threats considered and
found handled.

## PR #134 — rate-limit map LRU (`server/http.mjs:90-121`)

**Change.** The single 2000-key cap that refused every *new* key with 429 is
replaced by a per-family cap (`RATE_FAMILY_KEYS = 2000`) with least-recently
touched eviction inside the family; Map insertion order is the recency order.
`server.rateLimitKeys()` is a test hook on the server object, not an HTTP route.

**Threats considered.** Lock-out of fresh logins/joins by a flood of foreign
addresses (the bug being fixed); one family starving another; counter reset via
eviction; key-family parsing.

- OK — every `rate()` call site on `main` (20 sites, `server/http.mjs:275-701`)
  uses a `<family>:<key>` id, so `rateFamily()` always finds a colon. IPv6
  addresses contain colons but sit after the family prefix.
- OK — a key that is being hammered is re-inserted on every touch, so it is
  never the family's least-recent entry; evicting it requires the attacker to
  stop and spend ~2000 requests on other keys per 10-attempt reset. The
  previous behaviour (global lock-out) was strictly worse. Login keys guard
  256-bit access keys, so the residual is not a brute-force path.
- Info — the per-key allowance is now "per minute *or* per 2000 fresh keys in
  the family", whichever comes first. Worth one sentence in the rate-limit row
  of `docs/INVITE-ONLY-CHECKLIST.md` so the operator model is accurate. No
  code change proposed.

**Findings: none above Info.**

## PR #135 — read-only open of pre-W4-45/46 v27 backups

**Change.** `WakeQueue#verifySchema` and `Attention#verifySchema` take
`{ allowAbsent }`; the read-only open path (`server/store.mjs:286-303`) passes
`allowAbsent: true`, the writable path (`store.mjs:385-386`) stays strict.

**Threats considered.** Read-only verification accepting a damaged file;
read-only verification performing a migration; loss of the wake-queue recovery.

- OK — `allowAbsent` only returns early when *every* object of the schema is
  missing; a partial schema still throws "requires operator reconciliation"
  (`server/wake-queue.mjs:58-62`, `server/attention.mjs:73-77`), pinned by the
  new test.
- OK — the deleted `if (!this.readOnly) this.wakeQueue.recover(...)` at
  `main:store.mjs:297` was dead code inside the read-only block; the live call
  at `store.mjs:389` is unchanged, so restart recovery is unaffected.
- OK — the schema-marker check (`version !== STORE_SCHEMA_VERSION`) still
  precedes the additive-table check, so a v26 file is still refused.

**Findings: none.**

## PR #136 — agent-identity cap (docs, OpenAPI, test)

**Change.** Documentation and a test for a cap that already exists on `main`:
`IDENTITY_LIMIT = 5000` is enforced inside the insert transaction
(`server/agent-identities.mjs:49-62`, `409 pilot_limit`, no row written).
The only server change is a comment (`server/http.mjs:469-472`).

- OK — the test drives the store class with `identityLimit: 2` and asserts the
  row count does not move on refusal, and the HTTP 422/409 contract.
- OK — documentation now matches the code in `AGENT-IDENTITIES.md`,
  `INVITE-ONLY-CHECKLIST.md`, `ROUTE-AUTH-TABLE.md`, `openapi.yaml`.

**Findings: none.**

## PR #137 — NDJSON export assembled before headers

**Change.** `GET /api/rooms/:id/export` (`server/http.mjs:611-626`) collects
all lines into one `Buffer`, writes `Content-Length`, and ends. A failure while
reading history now takes the JSON error path instead of truncating a 200.

**Threats considered.** Partial exports mistaken for complete ones (fixed);
memory per request; leakage of exported rows in error bodies.

- OK — authorization is unchanged (member visibility, same as the events
  route; `401` for non-members pinned).
- OK — the new test asserts no exported row appears in the 500 body.
- Info — the export is now materialised in process memory. The bound is the
  room log cap (10000 events, `server/store.mjs:1063,1725`) times the request
  body cap (16 KB, `server/http.mjs:156`), so ~160 MB theoretical worst case
  per request, throttled by `read:<credential>` at 600/min. The previous code
  called `res.write` in a synchronous loop, which also buffers the whole body
  in the socket's write queue, so this is not a regression; noted for the
  operator memory model only.

**Findings: none above Info.**

## PR #138 — one source for the schema number

**Change.** `WRITER_FUNCTION` is derived from `STORE_SCHEMA_VERSION`;
`scripts/check-schema-version.mjs` (run by `npm run check`) fails CI when the
README, `docs/CURRENT-ROOM.md`, the writer function name or `writerVersions`
disagree, or when another module redefines the constant.

- OK — the script reads fixed repository paths with anchored regexes; it takes
  no external input and runs only in CI/`npm run check`.

**Findings: none.**

## PR #133 — unified inbox (email + Telegram, fixture-only)

**Change (security-relevant).** New modules `server/channel-connection.mjs`
(generic connection record), `server/channel-adapters/{index,email,telegram}.mjs`
(adapters; Telegram normalizes recorded Bot API `Update` objects),
`server/channel-import.mjs` (page preparation, in-memory `ChannelWebhookInbox`,
`syncTelegramConnection`). `server/http.mjs` adds four routes:
`GET /api/inbox/connections`, `GET /api/inbox/connections/{id}`,
`POST /api/inbox/connections/{id}/sync` (account session), and
`POST /api/inbox/webhooks/{connectionId}` (unauthenticated, per-connection
secret header). `email-import.mjs` gains a `connection.webhook` action that
stores only a SHA-256 of an owner-chosen secret. No credentials, tokens,
network calls or sends exist on the branch; `channelWebhooks` is a
`createRoomServer` option that no entry point on the branch passes, so the
webhook route answers `409 channel_webhook_unavailable` in every deployment
until a later slice wires it.

**Threats considered.** Secret handling and comparison; unauthenticated route
abuse (memory, CPU, oracle); CSRF and account scoping on the session routes;
loopback gating of the sync route; input bounds of the Telegram normalizer;
data leaking to the browser projection; error-shape consistency;
documentation of the new open route.

### OK

- Connection secrets — only `webhook.secretHash` (64 hex) is stored
  (`email-import.mjs:53,88-93`); `record()` never includes it and
  `connectionRecord()` returns `webhook: Boolean(...)`
  (`email-import.mjs:143,158`). The `connection.webhook` action has no HTTP
  entry point on this branch (no route calls `store.email.apply`); it is
  reachable from tests/scripts only.
- Webhook auth — `ChannelWebhookInbox.#match` hashes the presented secret and
  uses `timingSafeEqual` on 32-byte buffers against every row with that
  connection id, and unknown connection, wrong secret, inactive connection and
  non-Telegram connection all collapse into one `401 channel_webhook_denied`
  (`channel-import.mjs:66-80`). Presented secret bounded 16–256 chars before
  any DB work. `pathId()` 404s malformed ids before the secret is read.
- Webhook caps — request body 16 KB (`http.mjs body()`), ≤100 updates per
  request, ≤500 pending per (account, connection), enforced *before* the queue
  is replaced (`channel-import.mjs:83-90`); nothing is queued for a failed
  auth, so unauthenticated callers cannot grow memory. `rate(inbox-webhook:<ip>, 120)`
  (`http.mjs:273`).
- Sync route — account session only (`Authorization` header rejected for all
  `/api/inbox/*`), `protectWrite` CSRF, `rate(inbox-sync:<account>, 60)`,
  loopback-only, fixture-mode-only, ≤100 updates, request id validated
  (`http.mjs:303-313`, `channel-import.mjs:102-119`).
- Account scoping — `connections()`, `connectionRecord()`, `state()`,
  `priorReceipt()` and the webhook drain all key on `auth.account.id` or the
  stored row's `accountId`; `Inbox.apply` still rejects `source.import` for a
  foreign account and requires the import authority (`inbox.mjs:485-496`).
- Telegram bounds — every string passes `text()` with byte caps and a
  control-character filter (body 16384 B, participant id/handle/name
  2048/320/1024, attachments ≤20 with 2048/240-byte fields), ids are
  `^-?\d{1,20}:\d{1,20}$`, integers must be safe, whole input ≤1 MB
  serialized, recordings ≤1000 updates with strictly increasing `update_id`
  (`telegram.mjs:8-63,76-120,152-164`). Non-message updates are skipped, never
  imported.
- Browser projection — `channelView` exposes text, labels, chat title, kind,
  edited flag and attachment count only; chat ids, file ids, cursors and bot
  ids stay server-side (`inbox.mjs:196-207`); the client validator pins the
  shape (`src/inbox-client.js:43-66`).
- Error shape — new codes are literal snake_case; adapter `ContractError`s are
  mapped to `422 invalid_email_import` / `invalid_channel_update` rather than
  escaping as `TypeError` (`email-import.mjs:39-42`, `channel-import.mjs:124,127`).

### Findings

**L1 (Low) — a malformed update accepted by the webhook blocks the drain
until restart.** `receive()` validates only the `update_id` of each update
(`server/channel-import.mjs:83-86`); normalization happens later, during the
owner's `sync` with `updates: null`. If one queued update fails the contract
(e.g. `chat.type` outside private/group/supergroup/channel → `unsupported_telegram_chat`),
`syncTelegramConnection` fails with 422 (`channel-import.mjs:123-127`) and
`acknowledge()` is never called (`:130`), so the same slice is retried
forever and nothing behind it can be imported; there is no purge route.
Requires the webhook secret, and the route is inert in deployments (see
above). *Fix:* in `receive()`, run `normalizeTelegramUpdate(profile, update)`
for message-kind updates using the profile already parsed from the row, and
reject the request with 422 without queuing; additionally, on a contract
failure of a webhook-sourced sync, acknowledge the failing update id so the
queue advances (or add an owner-only purge).

**L2 (Low) — out-of-range `date` yields 500, not 422.** `at()` in
`server/channel-adapters/telegram.mjs:77` accepts any non-negative safe
integer and calls `new Date(seconds * 1000).toISOString()`; for
`seconds > 8_640_000_000_000` this throws `RangeError: Invalid time value`
(reproduced), which is not an `EmailContractError`, so both catch sites in
`channel-import.mjs:124,127` rethrow and the sync route answers
`500 internal_error`. Reachable by the account owner over loopback, or via a
webhook update with the secret (then also triggers L1). No state is written.
*Fix:* bound the value in `at()` (`seconds <= 8_640_000_000_000`) or check
`Number.isFinite(date.getTime())` before `toISOString()` and raise
`invalid_telegram_update`.

**L3 (Low) — the new unauthenticated route is not in the open-route
inventory.** `POST /api/inbox/webhooks/{connectionId}` is documented in
`docs/openapi.yaml:582-593` (`security: []`) but not in
`docs/ROUTE-AUTH-TABLE.md`, not in `docs/INVITE-ONLY-CHECKLIST.md` §1 (which
states every `/api/*` route is either listed there or requires a credential),
and not in the pinned list in `tests/invite-only-boundary.test.js:41-51`. The
inventory is hand-maintained, which is why CI did not flag it. *Fix:* add the
row to both documents (auth: per-connection secret header; discloses only
`received`/`pending` counts; `409` when no webhook inbox is configured) and
add `["POST", "/api/inbox/webhooks/<id>", { update_id: 1 }, 409]` to the
inventory; longer term derive the inventory from `security: []` entries in
`openapi.yaml` so a new open route fails CI.

**I1 (Info) — webhook accepts updates for `reconnect_required` connections.**
`#match` checks `connection.state === "active"` (`channel-import.mjs:74`) but
not `connection.authEpoch` against the account's current epoch, so after an
epoch rotation updates keep queueing (bounded at 500) although `state()` will
refuse the import (`canImport` false). Harmless with the bound; noting for
consistency with `connectionState()`.

**I2 (Info) — sync idempotency short-circuit skips the content check.**
`syncTelegramConnection` returns a prior receipt as `duplicate: true` when
`action` and `connectionId` match (`channel-import.mjs:108-112`) without
comparing the request content; `EmailImport#apply`'s fingerprint check is
bypassed for the same `requestId` with different `updates`. Owner-only,
loopback-only. *Fix:* carry a digest of `updates` in the receipt and compare,
or answer `409 idempotency_conflict` on mismatch.

**I3 (Info) — owner-chosen webhook secret has no entropy requirement.**
`connection.webhook` accepts any 64-hex hash (`email-import.mjs:53`); only the
presented secret's length (16–256) is checked at receive time
(`channel-import.mjs:67`). Brute force is bounded by 120/min per address.
Document that the secret should be ≥32 random bytes when the configure route
is exposed.

**No High or Medium findings. Nothing blocks merging #133**; L3 should be
fixed in-PR or as the first follow-up because the checklist claims
completeness.

## CI observation (not a security finding)

The `browser` job of `.github/workflows/test.yml` (`npm run test:browser`,
Playwright/Chromium) failed once and passed on rerun on every PR touching
`server/http.mjs` (#134, #136, #137, #133), at the same commit. Reruns at the
same SHA passing indicates a timing or environment race (browser install,
server start-up wait or port reuse), not a code path that the http changes
expose; none of the four diffs touches start-up, listening or static asset
serving. No security relevance found. The job already uploads
`test-results/` on failure; the first failing run's artifact should be read
before adding a retry, so a real regression cannot hide behind one.

## Summary

| PR | High | Medium | Low | Info | Blocking |
|---|---|---|---|---|---|
| #134 rate-limit LRU | 0 | 0 | 0 | 1 | no |
| #135 read-only v27 backups | 0 | 0 | 0 | 0 | no |
| #136 identity cap docs/test | 0 | 0 | 0 | 0 | no |
| #137 NDJSON export | 0 | 0 | 0 | 1 | no |
| #138 schema-number source | 0 | 0 | 0 | 0 | no |
| #133 unified inbox | 0 | 0 | 3 (L1–L3) | 3 (I1–I3) | no |

## Follow-ups

Proposed tasks, continuing the B-series after B46:

- **B47** — #133 webhook backlog hardening: validate message-kind updates in
  `ChannelWebhookInbox.receive()` and reject without queuing; advance the
  queue on contract failure of a webhook-sourced sync; bound `at()` so
  out-of-range `date`/`edit_date` is `422 invalid_telegram_update` (L1, L2).
- **B48** — open-route inventory: add `POST /api/inbox/webhooks/{connectionId}`
  to `docs/ROUTE-AUTH-TABLE.md`, `docs/INVITE-ONLY-CHECKLIST.md` §1 and
  `tests/invite-only-boundary.test.js`; derive the pinned inventory from
  `openapi.yaml` `security: []` entries so future open routes fail CI (L3).
- **B49** — #133 consistency nits: compare request content on the sync
  idempotency short-circuit; check `authEpoch` in webhook matching; document
  webhook secret strength before the configure action gets an HTTP route
  (I1–I3).
- **B50** — CI browser job first-run failure: read the failing run's
  `test-results/` artifact, pin the start-up wait or port handling in
  `npm run test:browser`, and only then consider a bounded retry
  (operational).
- **B51** — operator docs: one sentence each on the rate-limit eviction model
  (#134) and the export memory bound (#137) in
  `docs/INVITE-ONLY-CHECKLIST.md` / `docs/EXPORT-RETENTION-DELETION.md` (Info).
