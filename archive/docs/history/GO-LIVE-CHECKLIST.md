# Go-live checklist

The human steps that stand between `main` and a live room with Telegram and
email switched on, in order, with the exact command or console path and the
document each one comes from. Owners follow [AGENT-LANES.md](AGENT-LANES.md):
John holds the Cloudflare account, domains and every secret; Grok Bot owns
`cloudflare/` and production Worker deploys; Instinct owns production
verification and infrastructure. Nothing on this page can be done by a
Claude session: the session has no Cloudflare credential (see "What Claude
did / verified").

Deployment is [ROOM-DEPLOYMENT.md](../ROOM-DEPLOYMENT.md): one Room service, two
entry points. `project-room` (`wrangler deploy --env production --keep-vars`)
is the canonical Worker. It owns the Durable Object namespace and serves
https://room.trydemigod.com, with `env.production.limits.cpu_ms` at 30000.
`project-room-staging` (`wrangler deploy --keep-vars`, no `--env`) is the
public entry Worker. It forwards through a cross-script binding to that same
namespace, serves the getdasha.com `/room` routes, and keeps a one-second
forwarding budget. Deploy the canonical service first, then the entry. Both
configurations disable workers.dev. The name `project-room-staging` is the
public entry, not a separate user workspace.

GitHub stays code-only. Receipts for these steps go to the Project Room
coordination room (`muse-room` at https://room.trydemigod.com), not to a
GitHub issue.

Status words used below: **live** means running on the Worker today;
**on main, not mounted** means the code and tests are merged but
`cloudflare/room.mjs` does not yet wire it; **proposal** means an open draft
PR that Grok Bot must review and merge before the step applies.

## 1. Human steps, in order

### 1. Reconcile the live Workers with `main` (Grok Bot)

`project-room` serves https://room.trydemigod.com and owns room storage.
`project-room-staging` is the public entry and must not run a second cron
against that store. Before any deploy, confirm nothing is live that is not
on `main`; if it is, commit or port it first. See
[ROOM-DEPLOYMENT.md](../ROOM-DEPLOYMENT.md).

```sh
git fetch origin main && git checkout main && git pull --ff-only
cd cloudflare && pnpm install --frozen-lockfile --ignore-scripts
pnpm test && pnpm run test:browser
pnpm exec wrangler deploy --dry-run --outdir dist
```

Source: `cloudflare/README.md` "Reproduce"; `.github/workflows/test.yml`
(the `cloudflare` job runs exactly this without credentials).

### 2. Merge the two Worker proposals Telegram and email depend on (Grok Bot)

- PR #140 (`claude/build-01-webhook-journal-worker-mount`): **merged 14
  September.** `cloudflare/room.mjs` on `main` now passes a
  `ChannelWebhookInbox` to `createRoomServer`; the mount takes effect on the
  next deploy (step 3). Until that deploy the live Worker still answers 409
  `channel_webhook_unavailable` on `POST /api/inbox/webhooks/{connectionId}`
  and no Telegram update is journaled. `docs/UNIFIED-INBOX.md` "Worker mount".
- The `email()` handler proposal in `docs/EMAIL-ROUTING.md` "Worker email()
  handler (proposal for Grok)". PR #144 merged the parser and routing modules
  and their tests; the handler itself is not in `cloudflare/room.mjs` on
  `main`, so routed mail has nowhere to land until it is.
- PR #141 (`claude/build-01-worker-cold-start-proposal`): **merged 14
  September** as code: non-fatal bootstrap window and Workers Logs on.
  Current budgets are in [ROOM-DEPLOYMENT.md](../ROOM-DEPLOYMENT.md): the
  canonical Worker uses `env.production.limits.cpu_ms` 30000; the entry
  Worker keeps the top-level one-second budget. See step 8.

Post a receipt in the Project Room coordination room (`muse-room`) after each
merge. GitHub stays code-only.

### 3. Deploy the Worker (Grok Bot)

From the reconciled `main` checkout, `cloudflare/` directory, on the machine
that holds the Wrangler OAuth credential (`docs/DATA-BOUNDARIES.md` section 3:
"Wrangler operator OAuth credential … the deploying operator's own keychain").

```sh
cd cloudflare
pnpm exec wrangler whoami
pnpm exec wrangler deploy --env production --keep-vars   # canonical project-room first
pnpm exec wrangler deploy --keep-vars                    # entry project-room-staging second
```

`cloudflare/wrangler.jsonc` names the entry Worker `project-room-staging`
(routes `getdasha.com/room*` and `www.getdasha.com/room*`, `workers_dev`
false, Durable Object binding `ROOM` with `script_name` `project-room`,
one-second `limits.cpu_ms`). `env.production` names the canonical Worker
`project-room` (route `room.trydemigod.com`, its own Durable Object
namespace, `limits.cpu_ms` 30000, the only cron). Preserve existing secrets
with `--keep-vars`. Only the canonical Worker runs scheduled jobs. Never
regenerate the owner key or reset the live room; the one-time bootstrap
settings were removed after the first owner login and must stay removed
(`cloudflare/README.md` "Deployment gate and next steps"). Record both
version ids, the source revision, and the rollback targets in
`docs/CURRENT-ROOM.md` and `cloudflare/README.md`. Post that receipt in the
Project Room coordination room. GitHub stays code-only.

### 4. Create the Telegram bot and set the two Worker secrets (John, or Grok Bot with John's values)

1. In Telegram, @BotFather → `/newbot` → copy the token
   (`<bot id>:<35 chars>`). `docs/UNIFIED-INBOX.md` "Bindings".
2. Choose a webhook secret: 16–256 characters from `A-Z a-z 0-9 _ -`
   (`docs/UNIFIED-INBOX.md` "Bindings"; `server/channel-import.mjs` enforces
   the length).
3. From `cloudflare/` on the credentialed machine, paste each value when
   prompted; nothing goes in a file or the shell history:

   ```sh
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
   pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

   `docs/UNIFIED-INBOX.md` "Setup steps" step 1. The optional
   `TELEGRAM_API_BASE` var is only for a self-hosted Bot API server; leave it
   unset.
4. Redeploy is not needed for secrets, but the Worker must already carry the
   #140 mount (step 2) for inbound updates to be held.

Never paste either value into chat, GitHub, the coordination room, or an agent prompt
(`docs/UNIFIED-INBOX.md` "Secrets handling"; `docs/HOW-TO-TEST.md` "Do not
paste keys").

### 5. Configure the Telegram connection and register the webhook (John)

1. Sign in with the **Account key** at
   `https://room.trydemigod.com/?account=1`, open
   **Inbox**, add a connection of kind "Telegram bot" and choose a connection
   id (it becomes part of the webhook URL). The same request is
   `connection.configure` on `POST /api/inbox/connections/commands`.
   `docs/UNIFIED-INBOX.md` "Setup steps" steps 2–3.
2. Press **Reconnect** on the Telegram card. With the bindings set this
   stores the SHA-256 of `TELEGRAM_WEBHOOK_SECRET` on the connection and the
   card changes from "Webhook: not registered" to "Webhook: registered".
   `docs/UNIFIED-INBOX.md` "Setup steps" step 4 and
   `POST /api/inbox/connections/{id}/reconnect`.
3. Register the webhook with Telegram from any machine that has the two
   values in its environment; dry-run first:

   ```sh
   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
     node scripts/telegram-set-webhook.mjs https://room.trydemigod.com --connection <connection id> --dry-run
   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
     node scripts/telegram-set-webhook.mjs https://room.trydemigod.com --connection <connection id>
   ```

   The dry run prints the request with the secret redacted and sends
   nothing. The live run calls `setWebhook` with `secret_token`,
   `allowed_updates: [message, edited_message, channel_post]` and
   `max_connections: 10`, prints Telegram's answer and exits 1 if it was not
   `ok`. `--delete` calls `deleteWebhook`; `--drop-pending` discards updates
   Telegram still holds. Source: `scripts/telegram-set-webhook.mjs` header and
   `usage`; `docs/UNIFIED-INBOX.md` "Setup steps" step 5.

The Telegram Bot API is free; no plan change is involved
(`docs/UNIFIED-INBOX.md` "Live Telegram (zero spend)").

### 6. Enable Cloudflare Email Routing and point a route at the Worker (John)

Console path, from `docs/EMAIL-ROUTING.md` "What John must do (nothing else
unblocks this)":

1. Cloudflare dashboard → the domain → **Email → Email Routing → Get
   started**. Accept the MX and SPF records Cloudflare adds. If the domain
   already has another MX, use a subdomain (for example `mail.getdasha.com`)
   so nothing existing changes.
2. A destination address is only needed for plain forwarding; the Worker
   path does not need one.
3. **Email Routing → Email Workers**: bind `project-room-staging` as the
   action of a routing rule, either one rule per connection address or the
   domain **catch-all** with action "Send to a Worker". Unknown recipients are
   then rejected by the handler with "Unknown recipient", never accepted
   silently.
4. Confirm the address scheme with potter. Suggested: one inbox connection
   per room mailbox (`room@mail.getdasha.com`), plus-addressing for tags
   (`room+ticket-42@…` routes to the same connection), optional catch-all
   alias `*@mail.getdasha.com` declared on the connection.
5. Nothing else: no secret, no API token, no paid plan.

Then, in the Inbox, add or update the email connection so its `identity` and
`aliases` match the routed addresses (`docs/UNIFIED-INBOX.md` "Email setup").
Requires the `email()` handler from step 2 to be deployed first.

### 7. Domain: the public door and the Room origin (John and Instinct)

The canonical app is https://room.trydemigod.com (`project-room`,
`env.production`, custom domain). The public entry is
https://www.getdasha.com/room (and `getdasha.com/room*`), served by
`project-room-staging`, which forwards to the canonical Durable Object
namespace. `/room/src/*` is not an application asset path. workers.dev is
disabled on both Workers. See [ROOM-DEPLOYMENT.md](../ROOM-DEPLOYMENT.md) and
`cloudflare/wrangler.jsonc`.

"Live" means those two entry points, which this checklist verifies. Do not
treat a `workers.dev` hostname as the origin.

### 8. Worker limits (keep the production budget)

`env.production.limits.cpu_ms` stays `30000`. The production Durable Object
shares that per-invocation budget. A one-second budget caused repeated
CPU-limit resets and whole-room HTTP 500 failures on 25 September 2026. The
public entry Worker keeps its separate one-second forwarding budget. Verify
the effective production setting after every release; do not overwrite it
with the top-level limit. See [ROOM-DEPLOYMENT.md](../ROOM-DEPLOYMENT.md)
"Production CPU budget".

Observability stays enabled (`head_sampling_rate` 1) as recorded in
`cloudflare/README.md` "Runtime limits and logs". The top-level
`limits.cpu_ms` of 1000 applies to the entry Worker only.

### 9. Owner-to-confirm items before inviting anyone outside the team (John)

From `docs/DATA-BOUNDARIES.md` "Owner to confirm":

1. Cloudflare account facts: plan, which account owns `project-room` and
   `project-room-staging` and the `getdasha.com` / `trydemigod.com` zones,
   and whether the bootstrap settings and `ROOM_MAINTENANCE` were set in
   the dashboard or with `wrangler`.
2. Durable Object location and jurisdiction in effect for `invite-only-pilot`;
   provider encryption at rest and Worker-to-object transport.
3. Provider log retention at the edge for the routed hosts.
4. A hosted owner-key rotation path (the repo has none beyond the one-time
   bootstrap).
5. DNS and domain ownership for `getdasha.com`, `www.getdasha.com`,
   `lobby.getdasha.com`, `trydemigod.com`.
6. Dasha Compute data handling and whether `scripts/dasha-bridge.mjs` runs
   against the live room.
7. That the subprocessor list is complete (no monitoring, analytics or backup
   vendor outside the repo).
8. Which operator devices hold `.operator/` files and the wrangler credential,
   and whether their disks are encrypted.

From `docs/TRUST-PACKET.md` "Owner to confirm":

1. Support owner, backup, channel and response expectation.
2. Where incident status is communicated to participants.
3. Retention periods for the live database and backups.
4. Whether any data processing agreement or privacy notice exists.

Fill these into the two documents; do not assert them elsewhere first.

### 10. Verification and receipt (Instinct, then Grok Bot)

Run section 3 below, then `node cloudflare/hosted-check.mjs` (operator
acceptance journey, credentials in `.operator/`, never in CI) and
`node cloudflare/hosted-check.mjs --return`. Post both deployed version
ids, the source revision, results and rollback targets in the Project Room
coordination room (`muse-room`). GitHub stays code-only. Record the same
facts in `docs/CURRENT-ROOM.md` and `cloudflare/README.md`
(`docs/INVITE-ONLY-DEPLOYMENT.md` "Launch proof": report exact deployed
revision, results, limitations, rollback target and operator).

## 2. What Claude did / verified

Session `https://claude.ai/code/session_01KZMBNK6RHbs3HjAdbjwWUm`, working
from `origin/main` as it stood on 14 September 2026. `main` moves as PRs
merge. At deploy time the deployer records `git rev-parse origin/main` and
the UTC date (`date -u +%Y-%m-%dT%H:%M:%SZ`) in `docs/CURRENT-ROOM.md` and
`cloudflare/README.md`, posts that receipt in the Project Room coordination
room, and verifies that `sourceRevision` from `curl -sS $ORIGIN/api/version`
equals that sha. GitHub stays code-only. Nothing was deployed by this
session and no secret was read or written.

- **Credentials:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `CF_API_TOKEN` and every `WRANGLER_*` variable are **unset** in the
  session. `pnpm exec wrangler whoami` (wrangler 4.116.0) answers "You are not
  authenticated. Please run `wrangler login`." A Claude session therefore
  cannot deploy, set secrets or read Worker configuration.
- **Bundle:** `pnpm install --frozen-lockfile --ignore-scripts` then
  `wrangler deploy --dry-run --outdir dist` from `cloudflare/` on that
  revision **succeeds**: the custom build stamps `server/version.mjs`,
  prepares 28 allowlisted assets, reads 29 files from `public/`, and reports
  bindings `ROOM` (Durable Object), `ASSETS` and `ROOM_ORIGIN`. This is the
  same command the CI `cloudflare` job runs.
- **Configuration read (14 September 2026, since superseded):** this
  section was written when `cloudflare/wrangler.jsonc` named one Worker.
  Current topology is [ROOM-DEPLOYMENT.md](../ROOM-DEPLOYMENT.md): `env.production`
  is `project-room` at `room.trydemigod.com` with `cpu_ms` 30000; the
  top-level script is the entry Worker `project-room-staging` with
  `cpu_ms` 1000, forwarding to `project-room`. workers.dev is disabled.
- **Mounted on `main`, not yet deployed:** `cloudflare/room.mjs` passes a
  `ChannelWebhookInbox` to `createRoomServer` (PR #140, merged 14 September).
  **Not mounted:** the `email()` handler is still the proposal in
  `docs/EMAIL-ROUTING.md` "Worker email() handler"; PR #144 (email parser and
  routing modules) is merged, so routed mail has nowhere to land until the
  handler exists (step 6 stays gated on it).
- **Docs read:** `docs/AGENT-LANES.md`, `docs/UNIFIED-INBOX.md`,
  `docs/EMAIL-ROUTING.md`, `docs/SERVICE.md`, `docs/DATA-BOUNDARIES.md`,
  `docs/TRUST-PACKET.md`, `docs/INVITE-ONLY-DEPLOYMENT.md`,
  `docs/RE-AUDIT-2026-09-14.md`, `docs/CURRENT-ROOM.md`,
  `docs/HOW-TO-TEST.md`, `cloudflare/README.md`,
  `scripts/telegram-set-webhook.mjs`, `server/channel-adapters/telegram-config.mjs`,
  `.github/workflows/test.yml`. `docs/WORKER-LIMITS.md` (from PR #160)
  records the cold-start table behind the cap; `cloudflare/README.md`
  "Runtime limits and logs" (PR #141) and `docs/RE-AUDIT-2026-09-14.md` M5
  carry the decision rationale.
- **Checks:** `npm run check` on this branch: 1333 tests pass, 0 fail (node:test, 131 s).

## 3. Verify it is live

Only documented routes are used. `ORIGIN` is the canonical app
`https://room.trydemigod.com`. The public entry is
`https://www.getdasha.com/room`. None of these prove durability, backup
freshness or capacity (`docs/INVITE-ONLY-DEPLOYMENT.md` "Launch proof").

### Worker

```sh
ORIGIN=https://room.trydemigod.com
curl -sS -i "$ORIGIN/api/health"    # 200 {"status":"ok","mode":...}; process liveness only
curl -sS -i "$ORIGIN/api/ready"     # 200 {"status":"ready"}; 503 {"status":"unavailable"} if no room can be read
curl -sS    "$ORIGIN/api/version"   # {"sourceRevision": "<main sha>", "buildId": "<UTC>"}; must match the deployed commit, never "unstamped"
curl -sS -o /dev/null -w '%{http_code}\n' "$ORIGIN/api/rooms/commons"   # 401: signed-out room read is denied
curl -sS -o /dev/null -w '%{http_code}\n' https://www.getdasha.com/room  # 200: the public entry
```

Sources: `docs/SERVICE.md` "HTTP interface" (`/api/health`),
`docs/INVITE-ONLY-DEPLOYMENT.md` "Launch proof" (`/api/ready`),
`cloudflare/README.md` "Design" (`/api/version` release receipt, `unstamped`
rejected), `cloudflare/README.md` "Deployment gate" (signed-out room read
returned 401), `docs/HOW-TO-TEST.md` (door). Every `/api/*` response carries
an `X-Operation-Id`; quote it, not a body, when reporting a failure
(`docs/SAFE-DIAGNOSTICS.md`). After `ROOM_MAINTENANCE=1` expect an uncached
503 with `Retry-After` from every route (`docs/V8-RECOVERY-RUNBOOK.md`).

### Telegram

1. Probe the webhook route without a secret. Until the deploy in step 3 of
   section 1 carries the #140 mount the live Worker answers 409
   `channel_webhook_unavailable`; after that deploy and `connection.webhook`,
   a missing or wrong header answers 401 `channel_webhook_denied` and
   journals nothing. Either way no update is
   stored by this probe. `docs/UNIFIED-INBOX.md` "Webhook contract".

   ```sh
   curl -sS -i -X POST "$ORIGIN/api/inbox/webhooks/<connection id>" \
     -H 'Content-Type: application/json' -d '{"update_id":1}'
   ```

2. Open the Inbox (Account key → Inbox) and check the Telegram card reads
   "Live: configured" and "Webhook: registered"; `live.webhook` on
   `GET /api/inbox/connections/{id}` reports `matches`. `docs/UNIFIED-INBOX.md`
   "Routes" and "Connection cards".
3. From a phone, send a message to the bot's chat. The card shows "Last update
   received". Press **Reconnect**; the message appears in the list with the
   Telegram badge. `docs/UNIFIED-INBOX.md` "Setup steps" step 6.
4. Open that message and reply from the Inbox. The status line must say
   "Reply on Telegram", and after sending the result is "Accepted by Telegram ·
   delivery unconfirmed" with a `providerId` of the form
   `telegram:<chat>:<message>`; a "Sample" label means the deployment is still
   in fixture mode. `docs/UNIFIED-INBOX.md` "Send".

### Email

1. Send a plain-text message from any mailbox to the routed address
   (for example `room@mail.getdasha.com`) and a second one to
   `room+golive@…` to exercise plus-addressing. `docs/EMAIL-ROUTING.md`
   "Address scheme and routing order".
2. In the Inbox the email connection's folder shows both messages; the plus
   one carries the tag. Bodies above the documented caps are truncated, not
   dropped (`docs/EMAIL-ROUTING.md` "Caps").
3. Send one to an unrouted address on the same domain (catch-all rule only):
   it must bounce with "Unknown recipient", never appear in the Inbox
   (`docs/EMAIL-ROUTING.md` "What John must do" step 3).
4. Resend the first message unchanged (same `Message-ID`): nothing new appears
   (`docs/EMAIL-ROUTING.md` "Idempotency").

Email is inbound only; the Inbox does not send mail (`docs/UNIFIED-INBOX.md`
"Fixture versus live").

### After verification

Record both deployed version ids, `sourceRevision` from `/api/version`, the
date and who verified, in `docs/CURRENT-ROOM.md` and `cloudflare/README.md`.
Post the same receipt in the Project Room coordination room (`muse-room`).
GitHub stays code-only.
