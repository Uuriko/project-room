# Deploy runbook

Three Workers run the same code. Only one of them owns production data.

| Script | Role | How it is reached |
| --- | --- | --- |
| `project-room-stage` | Isolated staging. Its own Durable Object. No `script_name` on `ROOM`. | `https://project-room-stage.getdasha.workers.dev` only. No custom domain. |
| `project-room` | Canonical production. Owns the live Durable Object, the minute cron, and `room.trydemigod.com`. | `wrangler deploy --env production` |
| `project-room-staging` | Public entry for `getdasha.com/room`. Forwards to the production Durable Object with `script_name: project-room`. | `wrangler deploy` with no `--env` |

The entry script is still named `project-room-staging`. That name is historical. Do not rename the deployed script: the getdasha route and email routing are bound to it. `wrangler.jsonc` cannot carry comments (`JSON.parse` reads it), so this page and `cloudflare/README.md` are where the role is named. The entry's role is entry, not a second room.

Isolated staging is the place a schema or constructor change runs before production. It does not see production rows. The Worker, the workflow, and the secret names are in [STAGING.md](STAGING.md). Gmail stays off on every deploy (`ROOM_GMAIL_ENABLED=0`, and keep `ROOM_GMAIL_PILOT_ONLY=1`). Turning Gmail on is a separate release after the [Gmail setup requirements](history/GMAIL-SETUP.md).

Run the commands below from `cloudflare/` unless a command says otherwise. `--keep-vars` leaves secrets and dashboard text bindings in place. Do not put secret values in the repo.

## 1. Stage the same commit

Check out the commit you intend to ship. Do not deploy a dirty tree.

```sh
cd cloudflare
pnpm exec wrangler deploy --env staging --keep-vars
```

The first staging deploy creates the `room-sqlite-v1` class on `project-room-stage` only. Staging has no cron and no custom domain. Its CPU budget is 30000 ms, because the Durable Object runs inside the script that owns it. The entry's 1000 ms budget does not apply here.

`env.staging.vars.ROOM_ORIGIN` is `https://project-room-stage.getdasha.workers.dev` (the account subdomain is `getdasha`). If the deploy prints a different `workers.dev` host, set `ROOM_ORIGIN` to that host before trusting smoke. The host check rejects every other origin.

GitHub Actions deploys `main` to this Worker on every push, and from the Actions tab (`.github/workflows/staging.yml`). The workflow needs the Actions secret `CLOUDFLARE_API_TOKEN` (Workers script edit on this account). If that token can see more than one account, also set `CLOUDFLARE_ACCOUNT_ID`. When `CLOUDFLARE_API_TOKEN` is missing the workflow prints a notice and succeeds. It does not deploy production, and it does not fail `main`.

Worker secrets on `project-room-stage` are optional for the public smoke. Set a name only when the rehearsal needs it, with `pnpm exec wrangler secret put NAME --env staging`. Names only, never values in git: `ROOM_IDENTITY_HASH_KEY`, `ROOM_MAINTENANCE`, `ROOM_BOOTSTRAP_OWNER_HASH`, `ROOM_BOOTSTRAP_EXPIRES_AT`, `ROOM_VAPID_PUBLIC_KEY`, `ROOM_VAPID_PRIVATE_KEY`, `ROOM_VAPID_SUBJECT`, `ROOM_GOOGLE_CLIENT_ID`, `ROOM_GOOGLE_CLIENT_SECRET`, `ROOM_GMAIL_TOKEN_KEY`, `ROOM_GMAIL_PILOT_ACCOUNT_ID`, `RESEND_API_KEY`, `ROOM_MAGIC_FROM`, `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `ROOM_BOARD_V2_ENABLED`, `ROOM_RETENTION_ALLOW_DELETION`, `STITCHING_ENABLED`, `ROOM_PASSKEY_RP_ID`, `ROOM_OPERATOR_ACCOUNT_ID`, `ROOM_AGENT_CARD_SIGNING_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ROOM_BACKUP_TOKEN`. `CHANNEL_SEND_BUDGET`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, and `TELEMETRY` are read when present.

## 2. Verify staging

From the repo root, against the staging origin, before any other traffic so the first request is still a cold start:

```sh
node scripts/cold-start-probe.mjs --base https://project-room-stage.getdasha.workers.dev --max-ms 2000
ROOM_SMOKE_ORIGIN=https://project-room-stage.getdasha.workers.dev node scripts/live-smoke.mjs --browser
```

The cold-start probe fails when the first `/api/version` takes 2 seconds or more. The smoke checks public pages only. It does not sign in.

Also run the cross-worker identity check in `cloudflare/http.check.mjs` in CI (the `cloudflare` job). That check proves the entry and the canonical Worker still share one production namespace, and that staging's binding has no `script_name`.

## 3. Promote that same checkout

Do not pull, commit, or rebuild from a different tree between staging and production. Deploy the canonical Worker first, then the entry. Only the canonical Worker has the cron. The entry must not run a second cron against the shared store.

```sh
cd cloudflare
pnpm exec wrangler deploy --env production --keep-vars
pnpm exec wrangler deploy --keep-vars
```

Keep `env.production.limits.cpu_ms` at `30000`. A 1000 ms budget on the owning script caused repeated CPU resets and HTTP 500 / 1101 on 25 September 2026. The entry can keep its own 1000 ms forwarding budget. Do not let the top-level limit overwrite production. See [INCIDENT-1101-RUNBOOK.md](INCIDENT-1101-RUNBOOK.md).

## 4. Probe production

`/api/version/worker` is answered by the Worker and does not touch the Durable Object. `/api/version` does. Both doors should report the same `sourceRevision` as `git rev-parse HEAD` of the checkout you just deployed.

```sh
curl -fsS https://room.trydemigod.com/api/version/worker
curl -fsS https://room.trydemigod.com/api/version
curl -fsS https://www.getdasha.com/room/api/version/worker
curl -fsS https://www.getdasha.com/room/api/version
```

A 503 from `/api/health/jobs` with empty `jobs` means the Durable Object RPC failed. Read a short Worker tail before changing anything else.

`node scripts/watch-deploy-drift.mjs` compares that public revision with `origin/main`. A lag inside 5 commits and 24 hours is not drift. The hourly `.github/workflows/deploy-drift.yml` run is the report. It uses public endpoints and no secrets, and it does not block `main`.

## 5. Roll back

List versions, then roll each script back to the version id you recorded before the deploy. Roll the entry back as well as the canonical Worker when both were promoted.

```sh
cd cloudflare
pnpm exec wrangler versions list --env production
pnpm exec wrangler versions list
pnpm exec wrangler rollback <project-room-version-id> --env production --message "restore previous canonical"
pnpm exec wrangler rollback <entry-version-id> --message "restore previous entry"
```

`wrangler versions list` with no `--env` is the entry script `project-room-staging`. `--env staging` is isolated staging, if that deploy also has to come back:

```sh
pnpm exec wrangler versions list --env staging
pnpm exec wrangler rollback <staging-version-id> --env staging --message "restore previous staging"
```

Schema migrations are forward-only. A code rollback does not undo a migration and must not be followed by resetting or deleting the Durable Object. If the new code already wrote rows the old code cannot read, roll forward with a fix instead of rolling the schema back. Preserve secrets. `--keep-vars` on the next deploy, and rollback itself, leave them in place.

Record the version ids you rolled back to in `docs/CURRENT-ROOM.md`.

## Backups

The Durable Object cannot hand out its sqlite file. `GET /api/operator/export` streams the event log and the other tables as NDJSON. Secret and token columns are sha256 hex. Already-hashed columns stay. `auth_epoch` stays a number. The route answers 404 until `ROOM_BACKUP_TOKEN` (at least 16 characters) is set on the script that owns the object:

```sh
cd cloudflare
pnpm exec wrangler secret put ROOM_BACKUP_TOKEN --env production
```

Set it on `--env staging` as well if operators will pull a staging export. The check runs inside the Durable Object, so a secret only on the entry Worker does not unlock the route.

Replay a saved export into a new file:

```sh
node scripts/replay-room-export.mjs --from room-export.ndjson --to /var/lib/project-room/restore/room.sqlite
```

The production cron writes `room-backups/YYYY-MM-DD.ndjson` to R2 when the owning script has a binding named `ROOM_BACKUPS`. Without that binding the tick skips and the cron still succeeds. The binding is not in the checked-in config. Add it only after the bucket exists, under `env.production` in `cloudflare/wrangler.jsonc`:

```json
"r2_buckets": [{ "binding": "ROOM_BACKUPS", "bucket_name": "project-room-backups" }]
```

Then deploy the canonical Worker with `--keep-vars`. A binding that exists only in the dashboard is dropped on the next deploy. Create the bucket `project-room-backups` first.

The on-disk Node server still uses `scripts/backup-room.mjs`, which copies a sqlite file. That path is not the hosted Durable Object.

## Emergency API deploy

`scripts/deploy-live.py` deploys one named script through the Cloudflare API. It mirrors `cloudflare/wrangler.jsonc` and uses the `custom.cloudflare` surrogate credential. It does not print secrets. Upload metadata includes `keep_bindings: ["secret_text", "plain_text"]`. It does not add migrations, change schedules, or move public routes.

Use the Wrangler steps above for a normal release. The helper is for the case where Wrangler itself cannot upload. It requires the same release authorization as a normal deploy and is covered by local metadata tests. Usage: `deploy-live.py <script_name> <account_id> <public_dir> <bundle_path>`. `project-room` is canonical. `project-room-staging` is the entry. `project-room-stage` is isolated staging.

## External probes

`project-room-external-probe` is a separate Worker. It is not part of
`cloudflare/room.mjs` and it does not share that Worker's cron. Every 5
minutes it checks the public room. Cloudflare Health Checks belong to Load
Balancing, which this deployment does not use. This Worker uses the Cloudflare
account that already runs Room.

`PROBE_ORIGIN` defaults to `https://room.trydemigod.com`. Each run calls:

- `GET /api/ready`. The check passes when the JSON body has `"status": "ready"`.
- `POST /mcp` with an anonymous JSON-RPC `tools/list`. The request sends no
  `Authorization` header. The check passes when the result lists at least one
  named tool.
- `GET /llms.txt`. The check passes when the response is `text/plain` and
  contains the packet heading `# Uuriko Project Room`.

A run fails when any check fails or times out (10 seconds). The streak lives
in the `PROBE_STATE` KV binding. One failed run does not notify anyone. The
second failed run in a row notifies once. Later failures in that same incident
do not notify again. When a later run passes, the Worker sends one recovery
notice and clears the incident.

The 6-hour GitHub schedules stay the deep checks: `live-smoke.yml` and
`qa2-synthetic.yml`. This Worker is the 5-minute outage signal.

Notices go to two destinations. Each one stays quiet until its secret is set.
The Worker never writes the token or the webhook URL into the notice or the
KV value.

`PROBE_ALERT_WEBHOOK_URL` is an HTTPS POST URL. A Cloudflare generic webhook
notification URL fits here. `http://` is accepted only for `127.0.0.1` and
`localhost`. When the secret is unset or not a valid URL, the Worker sends no
webhook request.

The room post uses an existing agent connection: `ROOM_AGENT_ORIGIN`,
`ROOM_AGENT_ROOM`, and `ROOM_AGENT_TOKEN`. `PROBE_ROOM_ORIGIN`,
`PROBE_ROOM_ID`, and `PROBE_ROOM_TOKEN` each override the matching
connection name when the notice should go to a different room. The token is
an identity that can post `message.posted`. The Worker posts only when the
origin, room id, and token are all present and valid after that override.
Otherwise it does not post.

Deploy this Worker on its own, after the room Worker. The checked-in KV id is
the all-zero placeholder, not a live namespace. Replace it before the first
deploy. Until `PROBE_STATE` is a real namespace, the Worker cannot remember a
streak, so it does not notify. The config is
[external-probe.wrangler.jsonc](../cloudflare/external-probe.wrangler.jsonc).

```sh
cd cloudflare
npx wrangler kv namespace create PROBE_STATE --config external-probe.wrangler.jsonc
npx wrangler secret put PROBE_ALERT_WEBHOOK_URL --config external-probe.wrangler.jsonc
npx wrangler secret put ROOM_AGENT_ORIGIN --config external-probe.wrangler.jsonc
npx wrangler secret put ROOM_AGENT_ROOM --config external-probe.wrangler.jsonc
npx wrangler secret put ROOM_AGENT_TOKEN --config external-probe.wrangler.jsonc
npx wrangler deploy --config external-probe.wrangler.jsonc
```
