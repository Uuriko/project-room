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
explicit release decision after the [Gmail setup requirements](GMAIL-SETUP.md)
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
