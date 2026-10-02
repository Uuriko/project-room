# One Room service, two entry points

The browser application at `https://room.trydemigod.com` owns the canonical
`ProjectRoom` Durable Object namespace. The getdasha.com `/room` entry serves
discovery and forwards its prefixed APIs through a cross-script binding to that
same namespace. Identities, invite codes, rooms and memberships therefore work
across the entry and browser app. `/room/src/*` is not an application asset path;
the browser entry links to the canonical application.

Use the checked-in `cloudflare/wrangler.jsonc` for both deployments:

```sh
cd cloudflare
wrangler deploy --env production --keep-vars
wrangler deploy --keep-vars
```

Gmail and unified messaging remain shelved. Production defaults to
`ROOM_GMAIL_ENABLED=0`; retain `ROOM_GMAIL_PILOT_ONLY=1` for any later pilot.
Normal Room releases must keep Gmail disabled. Re-enablement is a separate,
explicit release decision after the [Gmail setup requirements](history/GMAIL-SETUP.md)
are satisfied; existing Google sign-in remains available.

Deploy the canonical service first, then the entry Worker. Preserve existing
secrets. Only the canonical Worker has scheduled jobs; the entry must not run
another cron against the shared store. Both configurations disable workers.dev
access and retain the existing public routes. The legacy name
`project-room-staging` now identifies the public entry Worker, not a separate
user workspace.

The older entry namespace is retained, not erased or merged into the canonical
store. Old test identities from that isolated namespace are not production
identities. Returning setup journals retain their selected connection origin;
new connections to known getdasha entry URLs select the canonical service.
An unrelated hostname never aliases to it.

Before a release, run the cross-worker identity/invite test in
`cloudflare/http.check.mjs`, the core checks, and the required browser checks.
After deployment, prove an identity created through one entry can create/read a
room through the other, and an invite issued by the app can be redeemed through
the entry. Confirm live bindings, version and authentication configuration.

## Production CPU budget

Keep `env.production.limits.cpu_ms` at `30000`. The production Durable Object
shares this per-invocation budget. A one-second (`1000`) budget caused repeated
CPU-limit resets and whole-room HTTP500/1101 failures on September25,2026.
A settings-only change to30seconds restored both entry points without changing
the bundle, bindings, or stored room data. The public entry Worker can retain
its separate one-second forwarding budget. Verify the effective production
setting after every release; do not overwrite it with the top-level limit.

A503 from `/api/health/jobs` with empty `jobs` means its Durable Object RPC
failed, not necessarily that storage failed. Inspect a bounded Worker tail
for the actual exception before selecting a recovery action.

## Emergency deploy helper

`scripts/deploy-live.py` is the checked-in copy of the live deploy helper
(committed 2026-09-26 after the 2026-09-25 outage repair). It deploys the
Worker directly through the Cloudflare API, mirroring
`cloudflare/wrangler.jsonc` at the deployed commit, and authenticates via the
`custom.cloudflare` surrogate credential — it never carries raw API keys.

The selected script name reads its existing topology from
`cloudflare/wrangler.jsonc`: `project-room` owns the Durable Object namespace,
uses production variables and a 30-second CPU budget; `project-room-staging`
forwards through `ROOM.script_name=project-room`, uses entry variables and its
one-second forwarding budget. The helper does not add migrations, change
schedules, or alter public routes. Invalid arguments or configuration fail
before any upload; the surrogate import is delayed until an API request.

Upload metadata explicitly includes `keep_bindings: ["secret_text", "plain_text"]`
to retain live secrets and text bindings not replaced by checked-in variables.
It retains `assets.config.run_worker_first`. The helper does not fetch or log
secret values. This wire preservation contract follows the
[Cloudflare Worker upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/).

Usage: `deploy-live.py <script_name> <account_id> <public_dir> <bundle_path>`.
Use the normal Wrangler release procedure above; this emergency helper requires
the same release authorization and is covered by local metadata tests.

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
