# ROOM_* flags

Census of every `ROOM_*` name read from the environment in `server/` and `cloudflare/`. The list is the audit command:

```sh
grep -rhoE "env\.ROOM_[A-Z0-9_]+|process\.env\.ROOM_[A-Z0-9_]+" server cloudflare
```

That command returns 36 names. This file records each name, the value it takes when unset, the hosted value in `cloudflare/wrangler.jsonc`, and the code that reads it. Nothing here is removed. Removals wait for approval (#4835).

Hosted values are the committed Wrangler config only. A name that is not in `vars` or a binding is listed as "not in wrangler vars". Secret values are not printed.

`docs/` has 187 top-level entries and 189 markdown files. A deletion list of markdown files that a link walk from [INDEX.md](INDEX.md) does not reach is at the bottom. That list is not a delete.

## How to read the hosted column

Production vars (`env.production.vars`) are `ROOM_ORIGIN=https://room.trydemigod.com`, `ROOM_DEPLOYMENT=production`, `ROOM_GMAIL_ENABLED=0`, `ROOM_GMAIL_PILOT_ONLY=1`, `ROOM_PUBLIC_AGENT_PAGES=0`, `ROOM_SERVICE_MODE=cloudflare-production`, `ROOM_SECURITY_CONTACT=potter@trydemigod.com`. Staging sets the same Gmail pair, `ROOM_DEPLOYMENT=staging`, `ROOM_SERVICE_MODE=cloudflare-staging`, `ROOM_ORIGIN=https://project-room-stage.getdasha.workers.dev`, and the same security contact. Staging does not set `ROOM_PUBLIC_AGENT_PAGES`. Production also binds KV `ROOM_BACKUPS_KV` to namespace `ee73a90c4e6749bb92ebe16fc57c117d`.

## Flags

| Name | Unset behavior | Hosted value | What it gates |
| --- | --- | --- | --- |
| `ROOM_AGENT_ORIGIN` | Probe uses `PROBE_ROOM_ORIGIN` only | not in wrangler vars | `cloudflare/external-probe.mjs` fallback when `PROBE_ROOM_ORIGIN` is empty |
| `ROOM_AGENT_ROOM` | Probe uses `PROBE_ROOM_ID` only | not in wrangler vars | Same probe, room id fallback |
| `ROOM_AGENT_TOKEN` | Probe uses `PROBE_ROOM_TOKEN` only | not in wrangler vars | Same probe, credential fallback. Secret |
| `ROOM_BACKUPS_KV` | No binding means backup skip | production KV binding (id above) | `cloudflare/room-backup.mjs`, restore-from-backup in `cloudflare/room.mjs` |
| `ROOM_BODIES_AT_REST` | Off unless the value is `1` | not in wrangler vars | `server/store.mjs`, `cloudflare/room.mjs`, `cloudflare/room-shard.mjs`. Encrypts projection bodies at rest |
| `ROOM_BOOTSTRAP_EXPIRES_AT` | Bootstrap does not run | not in wrangler vars | `cloudflare/bootstrap.mjs` one-shot owner install, with the hash below |
| `ROOM_BOOTSTRAP_OWNER_HASH` | Bootstrap does not run | not in wrangler vars | Same one-shot install. `cloudflare/prepare-owner.mjs` writes it |
| `ROOM_DB` | Node default `.data/room.sqlite` | not set on the Worker | `server/deployment.mjs`. Production invite-only requires an absolute path |
| `ROOM_DEPLOYMENT` | Node: empty is the local mode. Worker: a label | production `production`, staging `staging` | Node `server/deployment.mjs` accepts only empty or `invite-only`. The Worker stores the string as the deployment label in `cloudflare/room.mjs` |
| `ROOM_EXPORT_TOKEN` | Export door stays closed | not in wrangler vars | `cloudflare/room.mjs` `splitBackupTokens`. Secret. Must differ from the restore token |
| `ROOM_GMAIL_ENABLED` | Off unless the value is `1` | production and staging `0` | `server/gmail-mailbox.mjs`, `server/jobs.mjs`. Gmail import does not start |
| `ROOM_GMAIL_PILOT_ACCOUNT_ID` | Falls back to `ROOM_OPERATOR_ACCOUNT_ID` | not in wrangler vars | `server/gmail-mailbox.mjs` pilot allow-list. Unused while Gmail is off |
| `ROOM_GMAIL_PILOT_ONLY` | Off unless the value is `1` | production and staging `1` | Same mailbox config. The check does not run while `ROOM_GMAIL_ENABLED` is not `1` |
| `ROOM_GMAIL_TOKEN_KEY` | Gmail refuses to start | not in wrangler vars | 64 hex chars required when Gmail is on. Secret |
| `ROOM_GOOGLE_CLIENT_ID` | Google sign-in off when either value is unset | not in wrangler vars | `server/google-oauth.mjs`. Secret pair |
| `ROOM_GOOGLE_CLIENT_SECRET` | Google sign-in off when either value is unset | not in wrangler vars | Same |
| `ROOM_IDENTITY_HASH_KEY` | `null` | not in wrangler vars | `cloudflare/room.mjs` identity hash key |
| `ROOM_MAGIC_FROM` | `Project Room <noreply@trydemigod.com>` | not in wrangler vars, so the default is used | `server/resend-mailer.mjs`, `server/notify-email.mjs` From address |
| `ROOM_MAINTENANCE` | `maintenanceEnabled` defaults to `0` | not in wrangler vars | `server/maintenance.mjs`. `1` returns 503. Operator switch |
| `ROOM_OPERATOR_ACCOUNT_ID` | `""` | not in wrangler vars | `server/http.mjs` operator account. May be supplied as a secret |
| `ROOM_OPERATOR_PROTECTED_ROOMS` | Only the built-in `invite-only-pilot` room is protected | not in wrangler vars | `server/operator-purge.mjs` extra comma-separated room ids |
| `ROOM_ORIGIN` | Node: loopback origin from host and port | production `https://room.trydemigod.com` | Required hosted origin. `server/deployment.mjs`, `cloudflare/room.mjs` |
| `ROOM_PASSKEY_RP_ID` | Origin hostname | not in wrangler vars | `server/account-passkeys.mjs` WebAuthn RP id |
| `ROOM_PAUSE_BLOCKS_POSTS` | Off unless the value is `1` | not in wrangler vars | `server/http.mjs`. Opt-in: an owner's pause blocks posts. Default off is intentional |
| `ROOM_PUBLIC_AGENT_PAGES` | Off unless the value is `1` | production `0`; staging unset (off) | `server/boot-options.mjs`, `cloudflare/room.mjs` public agent pages |
| `ROOM_RECOVERY_CANDIDATE_PACKAGE` | Unset. Harness only | not in wrangler vars | `cloudflare/recovery-switch.check.mjs` |
| `ROOM_RECOVERY_FALLBACK_PACKAGE` | Unset. Harness only | not in wrangler vars | Same check |
| `ROOM_RESTORE_TOKEN` | Restore door stays closed | not in wrangler vars | `cloudflare/room.mjs` `splitBackupTokens`. Secret |
| `ROOM_SECURITY_CONTACT` | `/.well-known/security.txt` is 404 | production and staging `potter@trydemigod.com` | `server/http.mjs` security.txt contact |
| `ROOM_SERVICE_MODE` | Worker default `cloudflare-staging` | production `cloudflare-production`, staging `cloudflare-staging` | `cloudflare/room.mjs` service mode label |
| `ROOM_SOURCE_ROOT` | Repo root next to the check | not in wrangler vars | `cloudflare/bind-limits.check.mjs` test default |
| `ROOM_SQL_BIND_LIMIT` | Node's own SQLite limit | not in wrangler vars | `server/store.mjs` `nodeSqlLimits`. `100` mimics the Worker |
| `ROOM_STREAM_INTERVAL_MS` | 250 (allowed 50–5000) | not in wrangler vars | `server/deployment.mjs` stream poll interval |
| `ROOM_VAPID_PUBLIC_KEY` | Push stays off unless all three are set | not in wrangler vars | `server/push-subscriptions.mjs`. Secret material |
| `ROOM_VAPID_PRIVATE_KEY` | Push stays off unless all three are set | not in wrangler vars | Same |
| `ROOM_VAPID_SUBJECT` | Push stays off unless all three are set | not in wrangler vars | Same |

## Removal candidates

These stay. The list is the proposal #4835 can approve or reject.

Always off in the hosted config, so the branch they gate does not run in production or staging:

- `ROOM_BODIES_AT_REST`. Absent from vars. The store turns it on only for `1`.
- `ROOM_GMAIL_ENABLED` together with `ROOM_GMAIL_PILOT_ONLY`. Hosted Gmail is explicit `0`. The pilot flag is `1` and never consulted.
- `ROOM_PUBLIC_AGENT_PAGES`. Production is explicit `0`. Staging leaves it unset, which is also off.

Not candidates:

- `ROOM_PAUSE_BLOCKS_POSTS`. Off in production, and the http handler comment says that default is intentional. It is an opt-in, not a stuck flag.
- `ROOM_MAINTENANCE`. Operator switch. Unset means off.
- `ROOM_BOOTSTRAP_EXPIRES_AT` and `ROOM_BOOTSTRAP_OWNER_HASH`. One-shot install, not a product flag.
- `ROOM_RECOVERY_CANDIDATE_PACKAGE`, `ROOM_RECOVERY_FALLBACK_PACKAGE`, `ROOM_SOURCE_ROOT`. Test harness names.
- `ROOM_AGENT_ORIGIN`, `ROOM_AGENT_ROOM`, `ROOM_AGENT_TOKEN`. Probe fallbacks for `PROBE_ROOM_*`, not product flags.
- `ROOM_ORIGIN`, `ROOM_DEPLOYMENT`, `ROOM_SERVICE_MODE`, `ROOM_SECURITY_CONTACT`, `ROOM_DB`, the VAPID trio, and the Google and backup-token secrets. Configuration, not booleans to retire.

`ROOM_DEPLOYMENT` is read by two different checkers. Node self-host (`server/deployment.mjs`) allows only an empty value or `invite-only`. The Worker config sets `production` and `staging`. That split is recorded here and is not changed by this census.

## Docs not linked from INDEX

Walk: start at `docs/INDEX.md` and follow markdown links to other `docs/**/*.md` files. Directory links are not opened. 30 markdown files are outside that walk. [INDEX.md](INDEX.md) links `procedures/` as a directory, so the four files under `procedures/` are not deletion candidates.

Waiting for approval. None of these files were removed.

- `docs/ADMIN-GUIDE.md`
- `docs/ARCHITECTURE.md`
- `docs/BUG-BOUNTY.md`
- `docs/CHAOS.md`
- `docs/CONTRIBUTING-IN-ROOM.md`
- `docs/FLAKY-QUARANTINE.md`
- `docs/GROK-BUILD-CONTINUOUS.md`
- `docs/INVITE-ONLY-CHECKLIST.md`
- `docs/JOURNEY-COVERAGE-MAP.md`
- `docs/MATCHMAKING.md`
- `docs/PERF-BUDGET.md`
- `docs/PRIVACY-POLICY-TEMPLATE.md`
- `docs/RECEIPTS-PAGE.md`
- `docs/RELEASE-MERGE-GATE.md`
- `docs/ROUTE-AUTH-TABLE.md`
- `docs/SIGNED-AGENT-CARDS.md`
- `docs/SPEND-PRIMITIVE.md`
- `docs/TERMS-OF-SERVICE-TEMPLATE.md`
- `docs/WEEKLY-LEARNINGS.md`
- `docs/a2a-receipt-extension.md`
- `docs/analytics/EVENTS.md`
- `docs/legal/acceptable-use.md`
- `docs/legal/privacy.md`
- `docs/legal/terms.md`
- `docs/procedures/README.md` (directory is linked; not a deletion candidate)
- `docs/procedures/claim-protocol.md` (same)
- `docs/procedures/incident-triage.md` (same)
- `docs/procedures/merge-checklist.md` (same)
- `docs/signed-evidence.md`
- `docs/video-walkthrough-script.md`

Legal pages, `ROUTE-AUTH-TABLE.md`, and the procedures may be reached from code, the served site, or a directory index. Confirm that before any delete.
