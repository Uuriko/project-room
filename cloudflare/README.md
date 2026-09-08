# Cloudflare staging candidate

Status: **deployed to isolated staging on September 7, 2026** at
[Project Room](https://project-room-staging.getdasha.workers.dev).
Current accepted app `fb90a70`, Worker `901be347-7a39-4b56-8777-f4052bf81b38`;
[latest checkpoint evidence](../docs/ASSISTED-WORK-CHECKPOINT-2026-09-07.md).
Assisted-work release passed exact-source CI and hosted acceptance. The older
full-journey results below remain historical evidence. Code rollback baseline is
`c9ad5cfa-8a3b-4d54-876d-9a7a052cf222`; rollback removes overlap enforcement.
All three CI jobs passed; all ten live assets match the reviewed source.
Health and readiness pass;
two real HTTPS browsers completed owner login, invite creation, guest joining,
mobile Send, desktop Enter and bidirectional live updates. The Node service remains
the fallback. A new Worker and SQLite Durable Object were created; existing site
Workers, DNS and routes were not changed. This is the same Room implementation with explicit database, asset,
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
  Wrangler rebuilds the ten files from the current checkout before both dry-run
  and deployment. Unknown files/directories or symlinks in the output cause a
  failure; the packager does not silently upload or delete them.
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
The CI workflow now has separate contract, browser and Cloudflare jobs. The
Cloudflare job runs all six local scenarios and the exact deployment dry-run;
it never gets operator credentials or calls the hosted acceptance script.

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

John subsequently explicitly approved the account-wide Worker script/route access
and retrying the declined publishing commands. Expanded OAuth succeeded; its
credential remains encrypted with a key in the Mac keychain. The candidate was
pushed to the existing PR #23 branch. The Worker name was confirmed absent before
creation. Deployment uses only `room.mjs` and ten allowlisted static assets.

The owner key was generated once into private ignored `.operator/owner-key.txt`.
Only its hash and expiry were uploaded. Both one-time bootstrap settings were
removed after successful owner login and invitation acceptance. Never regenerate
the key blindly or reset the live room. No existing local database was imported.

Hosted browser evidence is in `test-results/hosted-desktop.png` and
`hosted-mobile.png`, visually inspected. It includes synthetic test messages and
a test guest in the pilot room. `node hosted-check.mjs` explicitly performs the
operator acceptance journey; `node hosted-check.mjs --return` checks the privately
saved guest session after redeployment. Neither runs in ordinary CI; browser
credentials stay in `.operator/` and TLS verification is enabled.
The return check passed after bootstrap settings were removed: the same guest
identity and messages survived redeployment. A signed-out room read returned 401.
`test-results/hosted-return.png` records the returning guest. This is deployment
persistence evidence, not a provider restore or disaster-recovery test.
Historical deployed version after the first-use interface update:
`5b052420-ec55-4fe3-8a35-7f0ac1347bcb` (source `0e20615`).
Existing guest-session return and the new hosted suggestion-to-work flow passed;
see [first-use testing](../docs/FIRST-USE-TESTING-2026-09-07.md). The earlier
bootstrap-removal version was `6575030d-d72f-4e8e-b256-fc18ecc6719b`.
The runtime source at `7c9292a` passed the existing remote CI workflow; the
Cloudflare and hosted operator suites were run separately as described above.

For the latest candidate and published version, use
[release review and polish](../docs/RELEASE-POLISH-2026-09-07.md).
The explicit hosted acceptance script offers `--help`; unknown or conflicting
modes stop before credentials/browser access. Synthetic guest checks now create
a one-hour, one-join invitation. The separate `--invite-user` mode retains its
deliberate 24-hour, ten-guest defaults; no invitation value belongs in source or
public evidence. `--work` adds a clearly labeled synthetic work item and starts
it; it does not claim human review or completion.

Remaining gates:

1. Expand hosted account-isolation, origin and real visitor-IP validation.
   Exercise provider point-in-time recovery in a separate test
   object and define a tested export/recovery procedure before inviting users.
2. Coordinate the unlisted trydemigod.com destination with Instinct. A dedicated
   Room origin avoids sharing auth/storage with marketing-page scripts. The
   current code does not support mounting under `/room` unchanged. No final
   domain/path decision or routing mutation has been made.
3. Set budget alerts, assess SSE duration against the account's other workloads,
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
