# Cloudflare staging candidate

Status: **locally verified, not deployed**. The existing Node deployment remains
the fallback. No production domain, DNS record, Worker, database or paid resource
was changed. This is the same Room implementation with explicit database, asset,
and visitor-address adapters, not a second product.

## Design

- `room.mjs` is the only deployment entrypoint. It calls the existing HTTP service
  and RoomStore. Authentication, invitation scope, command validation, revisions,
  audit and UI remain shared with Node.
- One SQLite-backed Durable Object holds the pilot workspace. Do not shard by
  member or room: current account/session ownership spans rooms. Later scaling
  requires an explicit account-directory design and tests.
- `storage.mjs` maps prepared statements and synchronous transactions onto
  Durable Object storage. A durable version table replaces unsupported
  `PRAGMA user_version`; exact writer triggers replace Node's UDF fence.
  Neither trigger verification nor audit verification is skipped.
- SQL `changes()` is used for compare-and-swap results; billable `rowsWritten`
  is not equivalent because it includes trigger/index work.
- `bootstrap.mjs` only provisions an empty workspace when operator configuration
  supplies a valid owner-key hash and expiry (at most seven days). It never
  resets an existing room. There is no public provisioning endpoint.
- All public requests must match one configured HTTPS origin. The front Worker
  normalizes Host for the Node bridge and overwrites the internal visitor header
  using Cloudflare's incoming `CF-Connecting-IP`. Local tests simulate that
  trusted edge header; they do not prove the live edge path.
- Asset packaging is an allowlist of the existing HTML, JS and CSS. Databases,
  operator files, tests and source directories are not static assets.
- `*.test-fixture.mjs` exposes synthetic setup for local tests ONLY. Never use
  these files, or `compatibility-worker.mjs`, as deployment entrypoints.

## Reproduce

Use Node 24.19+ and pnpm. From `cloudflare/`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run test:browser
pnpm run build
pnpm exec wrangler deploy --dry-run --outdir dist
```

The browser proof uses the parent checkout's Playwright installation/browser.
Wrangler 4.116.0 and Miniflare 4.20260730.0 use the same stable workerd generation.
Cloudflare dependencies are isolated; the original Node test job does not need
to install or run them. `--ignore-scripts` avoids dependency lifecycle scripts.

Verified locally on September 7, 2026:

- Native incompatibilities explicitly detected: schema-version PRAGMA,
  SQL BEGIN transaction, custom writer function.
- Real schema succeeds with explicit adaptation; rollback, foreign keys,
  missing/newer writer markers and runtime restart preserve their contract.
- Shared store: distinct guests, idempotent join/message retries, guest-scoped
  permissions, invitation journal immutability, failed join rollback, cancellation,
  unchanged guest ownership and message recovery after a workerd restart.
- Shared HTTP: secure cookie, owner creates invite, guest joins/posts, missing
  CSRF and unauthorized reads denied, foreign Origin denied, per-visitor request
  limits cannot be changed through the internal forwarding header.
- Two actual Chromium contexts: owner on desktop and guest in touch/narrow view;
  invitation created in UI, guest joins, mobile Send and desktop Enter submit,
  live SSE exchange, runtime restart, same guest returns to its `?room=commons`
  URL with messages intact. Five non-browser scenarios and one browser journey.
- Screenshots: `test-results/cloudflare-desktop.png`, `cloudflare-mobile.png`,
  `cloudflare-return.png`. Inspected visually. These are local runtime evidence,
  not hosted evidence or physical-device certification. Chromium capture resets
  touch emulation; sending is tested before capture. Existing lengthy member IDs
  and the mobile scroll/focus presentation still deserve a separate UI pass.

## Deployment gate and next steps

John approved Cloudflare-first staging, retaining a fallback, with up to $100/month
of infrastructure headroom (not a spend target). No provider-enforced $100 cap or
billing alerts have been configured; do not call that budget a hard billing cap.
AI execution, bounties and payments are not enabled or included in this approval.

Dashboard login works. Wrangler's initial narrow OAuth login succeeded and its
credential is encrypted with a key in the Mac keychain. Cloudflare rejected the
deployment-list request because Worker script permissions were missing. An
expanded authorization is awaiting explicit user approval: User Read, Background
Access, Account Read, Workers Write, Workers Scripts Write, Workers Routes Write,
Zone Read. The app approval check denied clicking Authorize because these rights
are account-wide, not scoped to this one Worker. **Do not retry or work around
that denial without the user's explicit approval.** No deployment was attempted.

Once authorized:

1. Verify the connected account and that `project-room-staging` does not already
   belong to another deployment. Its absence has NOT been confirmed yet.
2. Re-run checks and exact bundle validation. Stage using only `room.mjs`.
   The checked-in invalid origin deliberately denies all requests until the
   real deployment URL is known and configured. No homepage/routes are modified.
3. Generate the private owner key with `node prepare-owner.mjs`. This has not
   been run. It writes `.operator/owner-key.txt` and `.operator/bootstrap.json`
   with exclusive creation and private permissions; neither may enter Git,
   chat, logs, screenshots, static assets or issue comments.
4. Configure owner hash/absolute expiry through the provider's secrets interface;
   never upload the raw owner key. Initialize and verify the owner session, then
   remove bootstrap configuration once initialization succeeds. Do not blindly
   regenerate keys or replace live data after an uncertain response.
5. Re-run hosted invite/message/reconnect checks with disposable identities;
   verify account isolation, origin and real visitor-IP behavior, and deployment
   persistence. Exercise provider point-in-time recovery in a separate test
   object and define a tested export/recovery procedure before inviting users.
6. Coordinate the unlisted trydemigod.com destination with Instinct. A dedicated
   Room origin avoids sharing auth/storage with marketing-page scripts. The
   current code does not support mounting under `/room` unchanged. No final
   domain/path decision or routing mutation has been made.
7. Set budget alerts, assess SSE duration against the account's other workloads,
   document operational ownership and only then promote the tested candidate.

Known pilot limits remain: eight-hour guest sessions without identity recovery,
seven-day provisioned owner key unless operator-rotated, no self-service account
recovery, no live MCP/agent runner, no payments, and single-workspace scaling.
Per-visitor in-memory rate windows reset on runtime recreation; they are not a
persistent abuse-control service or a billing cap. No existing Node database
has been migrated/imported into Durable Objects.

References: [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[schema/version guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/),
[Node HTTP bridge](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
