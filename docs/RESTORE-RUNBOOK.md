# Restore runbook — the service died, bring it back

Executable procedure for restoring Project Room from the nightly KV backup
and proving the restored instance actually works. Written from the
2026-10-15 disaster game-day, where every step below was executed against a
production-shaped backup (90,650,112 bytes, trailer v2). Background and
hazards: [BACKUP-DR.md](BACKUP-DR.md) and [BACKUPS.md](BACKUPS.md).

**Measured mechanical RTO (game day, local instance): ~60 seconds** from
restore initiation to a completed claim → finish → receipt loop on the
restored store. Production adds provisioning, secret setting, and the
traffic switch — budget for those separately; the restore itself is not
the slow part.

## Before you start

You need:

- The operator token (`ROOM_BACKUP_TOKEN`) from the secret store. The
  restore endpoints fail closed: 404 when it is not configured on the
  target script, 401 when it does not match.
- A target with an **empty** store. The endpoints refuse a non-empty store
  with 409 `restore_refused_nonempty` — provision fresh rather than trying
  to restore over anything.
- The backup key: `room-backups/YYYY-MM-DD.ndjson` in the
  `ROOM_BACKUPS_KV` namespace (`project-room-backups`). Keys expire 35 days
  after writing. If the body omits `key`, the endpoint defaults to today's
  key — pass the key explicitly; after a death, "today" may have no backup.
- For the offline route: a checkout of this repo at the deployed revision
  (or current `main`), Node, and the new store's sqlite path.

## Step 1 — Restore

Production route (the KV-native endpoint is present in the deployed
build; use it for any current backup — the request-body route caps at
64 MiB and the daily backup is past that):

```sh
curl -X POST https://room.trydemigod.com/api/operator/restore-from-backup \
  -H "Authorization: Bearer $ROOM_BACKUP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key": "room-backups/YYYY-MM-DD.ndjson"}'
```

Expected success (about 45 s for a ~90 MB backup):

```json
{"ok": true, "verified": true, "contentVerification": "full",
 "events": <n>, "bytes": <backup size>}
```

Anything else is a stop, not a warning:

| Response | Meaning | Action |
| --- | --- | --- |
| 404 `restore_not_configured` | Token not set on this script | Set `ROOM_BACKUP_TOKEN`, retry |
| 401 | Wrong token | Get the token from the secret store; do not guess |
| 404 `backup_not_found` | No manifest under that key | List the namespace keys; pick the newest by date |
| 409 `restore_refused_nonempty` | Target store is not empty | Provision a truly fresh store |
| 422 `restore_verification_failed` | A part, digest, or audit failed | The store is left empty and retryable. Retry once; if it repeats, the backup is bad — escalate, and fall back to the previous day's key |

Offline route (no reachable Worker, or rehearsing): restore into a new
Node store from the KV copy or a saved export file:

```sh
node scripts/restore-room-backup.mjs --kv <YYYY-MM-DD> --to <new sqlite path>
# or: node scripts/restore-room-backup.mjs --from <export.ndjson> --to <new sqlite path>
```

A failed replay leaves the destination unpromoted.

## Step 2 — Boot checks, both doors

Bring the restored store up and check, on the canonical door and the
entry door:

```sh
curl https://room.trydemigod.com/api/health    # {"status":"ok", ...}
curl https://room.trydemigod.com/api/version   # 200; note sourceRevision/buildId
curl https://room.trydemigod.com/api/health/jobs
```

Cold start on a ~90 MB store took ~2 s in the game day. `/api/version`
reporting `sourceRevision: "unstamped"` means the instance booted from a
raw source checkout rather than a stamped build — fine for a rehearsal,
not for production.

## Step 3 — Re-issue credentials (manual; nothing automates this)

**Every credential in the backup is a sha256 hash.** The data is back;
no token, key, or identity secret from before the loss will authenticate.
Exports also resurrect authority as of backup time: anything revoked
between the backup and the loss is live again until you re-apply the
revocation from external records. Both are manual steps — plan the time.

With the restored store's sqlite path and a repo checkout:

```sh
ROOM_DB=<restored sqlite path> node --input-type=module -e '
import { RoomStore } from "./server/store.mjs";
const store = new RoomStore(process.env.ROOM_DB);
// Owner door: print once, hand to the operator channel, never commit it.
console.log(store.issueAccessKey("commons", "owner"));
// Agent door: one fresh identity per agent that must act immediately.
console.log(store.identities.create("Restored operator agent").secret);
store.close();'
```

Then, per system connected before the loss: re-issue agent API keys,
rotate webhook and push secrets, and re-apply every post-backup
revocation (keys, share links, memberships, delegations). The restored
room is authoritative **as of the backup's timestamp**, not as of the
loss.

## Step 4 — Prove the loop (session-one smoke)

With a fresh identity secret from step 3:

```sh
# Board answers and has claimable work
curl "https://room.trydemigod.com/api/public-work/tasks?claimable=1"
# Claim one task
curl -X POST https://room.trydemigod.com/api/public-work/tasks/<taskId>/claim \
  -H "Authorization: Bearer <identity secret>" \
  -d '{"requestId": "restore-smoke-claim", "expectedTermsVersion": 1}'
# Finish it
curl -X POST https://room.trydemigod.com/api/public-work/tasks/<taskId>/finish \
  -H "Authorization: Bearer <identity secret>" \
  -d '{"requestId": "restore-smoke-finish", "expectedTermsVersion": 1,
       "generation": 1, "artifactText": "Restore smoke", "checksReported": []}'
# Read the receipt — the id is claim.submittedReceiptId in the finish response
curl https://room.trydemigod.com/api/public-work/receipts/<submittedReceiptId>
```

The receipt must return 200 with `"state": "submitted"`. Note:
public-work receipts live **only** on this surface — the room receipts
list (`/api/rooms/<room>/receipts`) does not include them, so an empty
room list is not evidence that receipts are gone.

## Step 5 — First job ticks

Watch the first ticks on the restored store (`/api/health/jobs`, or run
one tick by hand in a checkout). Expected on a healthy restore:

- **integrity**: succeeds; deferred verification steps rotate a few per
  tick (`deferred: {ran: 2, next: 2}` on the game-day fixture). A failure
  names its sub-check — treat any failure as a stop and read it before
  declaring recovery.
- **claim-prs**: rows whose stored data is invalid are reported under
  `skippedInvalid` with the per-row error — expected, not fatal. Claims
  in `unclaimed` state are not polled (`checked: 0` is normal when
  nothing is in flight). Without a GitHub token the tick still runs and
  bounds itself to at most one lookup.

## Step 6 — Second-generation backup

Confirm the restored instance can be backed up again before calling the
incident over:

- Worker-served instance: the next `room-backup` tick writes the day’s backup under a new key; verify the
  manifest exists in `ROOM_BACKUPS_KV` and its `bytes` is at least the
  restored backup's size.
- **Node-served instance: there is no `room-backup` job on the Node
  runtime** (the job is worker-only). A store being served by
  `node server.mjs` takes no nightly backups. Until the store is back
  behind the Worker, cover it with operator exports
  (`GET /api/operator/export`) or restore it into the Durable Object.
- Game-day proof: a backup of the restored instance (90,657,264 bytes,
  6 parts) restored into a second fresh store and passed the same
  verification (`verified: true`, `contentVerification: "full"`, all
  table counts identical, board and the step-4 receipt readable).

## Game-day timings (2026-10-15, production-shaped fixture, local)

| Phase | Time |
| --- | --- |
| Restore 90,650,112 bytes via KV endpoint | 42.8 s |
| Boot production entry, first `/api/health` 200 | 11.6 s (cold start 1.7 s) |
| Credential re-issue (owner key + one identity) | ~1.3 s of commands, once you know them |
| Board → claim → finish → receipt | ~2.6 s |
| **Disaster declared → loop complete** | **60.1 s** |
| Second-generation backup + restore + smoke | +58.6 s |

## Not covered here

- Provisioning a replacement Worker/DO or re-pointing DNS/proxy — host
  operations, done from the Cloudflare account.
- Backups older than 35 days: the KV copies are gone; only a saved
  operator export can restore those, via the offline route in step 1.
- Backups written before trailer v2: restore with the code contemporary
  to the backup (see the rollback qualification notes in BACKUP-DR.md).
