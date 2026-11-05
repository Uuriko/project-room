# Per-room storage sharding

Design for one Durable Object per room. Ledger item #2 (one object holds every room; the largest room is recorded at 91% of the 4 MiB row cap) and the write-burst profile for item #11. This page does not change the server. Implementation follows after #4843 and #4842 merge. `ROOM_PER_ROOM_OBJECTS` stays unset. Production copy, a served read from a room object, and a pilot-row delete stay behind Potter's go and [ROOM-SHARD-CUTOVER.md](ROOM-SHARD-CUTOVER.md). Codex deploys.

The dark path already in the tree is the operator runbook. This page is the layout, the choice among options, the dual-read cutover, the routes after the split, the failures, and the numbers that decide success.

## Current layout

### One object for every room

`ProjectRoom` is the SQLite class, migration tag `room-sqlite-v1`, binding `ROOM` (`cloudflare/wrangler.jsonc`). Worker fetch, readiness, job health, and the cron handler all call `env.ROOM.getByName('invite-only-pilot')` (`cloudflare/room.mjs`). The constructor builds one `RoomStore` on that object's storage. The class comment states the constraint this design keeps: account and session ownership spans rooms, so the split is not one object per member.

`RoomShard` (binding `ROOM_SHARD`, tag `room-shard-v1`) is in the same worker and stays dark. `perRoomObjectsEnabled` is true only when `ROOM_PER_ROOM_OBJECTS` is exactly `"1"`. With the flag off the shard constructor does not open storage, and `RoomShard.fetch` returns 404. `resolveRoomHome` (`server/room-shard-route.mjs`) would name `ROOM_SHARD` / `getByName(roomId)` only when the flag is on and that room's `storage_home` is `room`. Worker fetch does not call it. `ensureStorageHomeIfEnabled` adds `rooms.storage_home` (`NOT NULL DEFAULT 'pilot'`) only when the flag is on. Opening a store on a default deploy does not add the column. A missing column reads as `pilot`.

A Durable Object input gate runs one turn of synchronous work at a time. `RoomStore` transactions stay synchronous (`nodeStorage.transaction` rejects a promise). A command that rewrites a large `rooms.projection` holds `invite-only-pilot` for every room, every MCP call, and every webhook drain on that object. The cron path yields once (`yieldToQueuedRequests`) so a request queued behind a job can enter. It does not give each room its own gate.

### The capped row

`PILOT_LIMITS.projectionBytes` is `4 * 1024 * 1024` (`server/store.mjs`). A command whose stored projection would pass that length fails 409 `pilot_limit` and writes nothing. The same constant caps events per room (1,000,000), members (100), and work items (500). The store-growth job alerts earlier, at `maxProjectionBytes: 3_500_000`, and alerts on the database at `dbBytes: 8_000_000_000` against the 10 GB Durable Object SQLite file (`server/jobs.mjs`). That file is the sum of every room plus the directory.

The value the cap counts is `Buffer.byteLength` of `rooms.projection`. `compareRoomHomes` uses that same length. The platform can refuse a row before the app does: `server/storage-limits.mjs` records workerd raising `SQLITE_LIMIT_LENGTH` from 2,200,000 bytes to 4 MiB and then to 8 MiB + 34 bytes, and records that production has not shown which build it runs. The app guard stays 4 MiB either way.

The unfixed ledger records the largest room at 91% of the 4 MiB cap. #4738 records the public store-growth gauge at 3,759,082 bytes. Both figures are the same row: `rooms.projection` for one room inside the shared file. This design does not pick a new byte target. The gauge stays the success signal.

### What a write stores

`store.command` appends the event, updates the room, and replaces `rooms.projection` with `storedProjection` (`server/projection-at-rest.mjs`). With the defaults, that string is the room state, message text included. Work items already leave the row as references when `workEntities` is on. Message text stays inline. `ROOM_BODIES_AT_REST=1` moves slimmable bodies into `projection_bodies` and the write then deletes unreferenced shas (`releaseUnreferencedBodies`) before it returns. The parsed-projection cache (`ProjectionCache` in `server/store.mjs`) skips a repeat `JSON.parse` until the sequence changes. It does not skip the rewrite.

Messages are also stored in the `messages` table. Reads of the live room still use the projection (`server/messages-store.mjs`). A chat post spends the in-memory flood bucket: 30 burst, refill 0.5 tokens per second, per room and member (`server/room-flood-guard.mjs`). Pins, edits, and work commands do not spend it. The bucket resets when the isolate is evicted.

`messageProjectionWindow` defaults to `null`. When a caller sets it, a command whose message list is longer than twice the window archives down to the window with the existing reversible archive. No production constructor passes a window. `cloudflare/room.mjs` leaves it null, so the live row still holds every message.

### Journals

Node storage sets `journal_mode=WAL`, `synchronous=FULL`, and `busy_timeout=3000` before other work (`nodeStorage.configure` in `server/store.mjs`). The product journals are separate tables. `server/journal.mjs` is one append-journal implementation with a config block per kind. `server/room-shard-tables.mjs` already classifies them:

| Home | Tables |
|---|---|
| Room (move with the room) | `events`, `commands`, `rooms` (keyed by `id`), `messages`, `projection_bodies`, `projection_checkpoints`, `membership_delegation_journal`, `owner_delegate_journal`, `bounty_journal`, work-claim and work-entity tables, the other `room_id` tables in `ROOM_TABLE_KEYS` |
| Directory (stay on `invite-only-pilot`) | `accounts`, `credentials`, sessions, `agent_webhook_subs`, `agent_webhook_deliveries`, `membership_invitation_journal`, `public_rooms`, `public_receipts`, `public_directory_entries`, `public_read_model_backfill`, and the rest of `DIRECTORY_TABLES` |
| Skipped | `REPLAY_SKIPPED_TABLES` in `server/room-export.mjs` |

A table missing from all three sets throws. `assertShardClassification` fails a fresh store when a live table is unclassified or a classified table is absent. Copy uses `roomKeyColumn` and does not guess.

Durable Object keys outside SQLite (`HEARTBEAT_STORAGE_KEY`, `CHANNEL_DRAIN_INFLIGHT_KEY`, the retention cursor) live on the pilot object. A room object does not take those keys.

### Backups

`room-backup` writes one NDJSON of the pilot database. Replay throws `Export names a table this store does not have` for a table outside `REPLAY_SKIPPED_TABLES`. `exportRoomNdjson` / `restoreRoomNdjson` already write and replay one room. A directory table in that file fails the room restore on purpose. The cutover runbook is the backup rule. This design does not add a skip.

## Open changes that move the row

These four PRs are open against `main` at `bdc5a04`. None of them addresses `ROOM_SHARD`.

### #4843 — message text off the row on each write

`cursor/side-table-projection-6692` (`abbf0cba`). A hosted store that sets `sideTableMessages` stores each message as `{id, _m:1}` and the record in `projection_message_records`. A later post stringifies the message the reducer changed. `RoomStore` leaves the flag off unless the caller asks. The branch's `ProjectRoom` constructor passes `sideTableMessages: true`. Hydration stays on, so a row written with the flag still reads. `rehydrateAllProjections` puts the text back and deletes the side records. The PR does not set `messageProjectionWindow`. Its own body says the design it measured is superseded by #4847 (a per-room `storage_mode`, flip only after the messages verify). The measurements still describe this branch: on a local store with 2,000 messages of about 800 characters, the row went from 1,973,478 bytes to 44,558 with the flag on, and a following post's command write p50 went from 11.68 ms to 2.31 ms. `npm run bench:room -- --sizes 1000` on the default path (text still inline) was inconclusive on every metric.

`projection_message_records` is not in `ROOM_TABLE_KEYS` on this main. The merge that creates the table classifies it in the same change, or `assertShardClassification` fails. The home is `room`, keyed by `room_id`. A copy taken before that classification does not know the table.

### #4842 — body sweep off the write path

`cursor/defer-body-sweep-6692` (`dfb47d63`). `RoomStore` leaves `deferBodyRelease` off unless the caller asks. The branch's `ProjectRoom` constructor passes `deferBodyRelease: true`. When the flag is on, the write marks the room and leaves `projection_bodies` rows for a `projection-body-sweep` job. The job stays disabled while that table is empty. A store that does not set the flag still releases bodies inside the write. On one write against 2,000 preinserted orphan shas, with bodies-at-rest on, write p50 went from 5.21 ms (release during the write) to 3.01 ms (deferred). The default-path room bench was inconclusive. Deleted text can sit in the side table until the sweep runs.

The sweep job reads room rows. After a flip it runs on the object that holds `projection_bodies`, which is the room object. Until the flip it stays on the pilot, which is where those rows are today.

### #4543 — Jill 2, BUY-TIME, cap 4 MiB to 5 MiB

`jill/build-cap-raise` (`e5dfee2d`). One constant: `PILOT_LIMITS.projectionBytes` from 4 MiB to 5 MiB, plus the single-source test that pins it. The PR's landing rule is a byte trigger: land only when a room reaches at least 3.8 MB, and only as a bridge. It does not change the event, member, or work-item caps, and it does not change the 3.5 MB store-growth gauge. It does not add an object. A room at 5 MiB is still one row in the shared file, and it still holds the input gate while that row is rewritten. On a workerd build whose value limit is 4 MiB, a 5 MiB guard can fail `SQLITE_TOOBIG` before the app guard. `storage-limits.mjs` is the probe for that limit. This design leaves the constant at 4 MiB.

### #4738 — bounded hot projection, stale

`cursor/projection-hot-window-aa42` (`000b73ab`). GitHub reports the PR dirty against `main`. It would turn production entry points onto `messageProjectionWindow` 512 with entity projection, and have the store-growth job keep archiving while the hot list is over twice the window. The shrink mechanism is already in `store.command` on main and is inactive while the window is null. The PR's synthetic room dropped from 3,564,893 bytes and 19,500 messages to 101,453 bytes and 513 hot messages. That is a smaller row on the same object. It does not give another room its own input gate or its own 10 GB file. #4843's body says the hot window is #4738's, and #4843 does not set it. This design does not rebase #4738 and does not turn the window on. A follow-on that sets the window classifies no new table: the archive already lives in the message store.

## Options

| Option | What it changes | What it leaves shared |
|---|---|---|
| Stay on one object | Nothing | The input gate, the 10 GB file, and the 4 MiB row |
| #4543, raise the cap to 5 MiB | The app guard | The gate, the file, and a larger row to rewrite |
| #4843 and #4842, flags on | Bytes rewritten per command, and when body rows are deleted | The gate and the file. Flags are off in both PRs |
| #4738, hot window on | How many messages sit in the row | The gate and the file. The PR is dirty against main |
| Several rooms per object, hashed | Fewer objects than rooms | Unrelated rooms still share a gate and a file. A bad name still pins a stranger |
| One object per member | A gate per person | Breaks the account and session contract the `ProjectRoom` comment names. Directory rows are not per member in a way that matches the room log |
| One object per room | A gate and a SQLite file per room. Directory stays `invite-only-pilot` | The 4 MiB cap, on the object that holds the projection |

The option this design uses is one object per room. The cap is already per room. The shared costs are the gate and the file. Raising the cap, deferring the body sweep, and shortening the hot list can land on their own rules. They do not replace the split. Hash buckets still couple strangers. One object per member answers a different constraint than the one the code is hitting.

## Shape

`getByName('invite-only-pilot')` stays the directory: accounts, sessions, credentials, webhook subscriptions and deliveries, the public read model, and `rooms.storage_home`.

`env.ROOM_SHARD.getByName(roomId)` is that room's object, class `RoomShard`, for a room whose `storage_home` is `room`. The object stores the room tables and runs `RoomStore` for those tables. It does not arm the pilot alarm, does not run `room-backup`, and does not run directory `store-growth`. The pilot cron fans out room-scoped jobs (`land-queue`, `claim-prs`, `escrow-epochs`, the room slice of `retention`, `public-read-model` for flipped rooms) with one RPC per room object. Room objects do not receive the worker cron, so a deploy does not multiply that wake by the room count.

The 4 MiB cap is checked on the object that holds the projection. Relief (`server/store-relief.mjs`) runs there too. A room at the cap still fails 409 `pilot_limit`.

Credentials stay on the directory. The shard does not keep a second copy of bearer tokens. The worker authorizes on the directory, then forwards the room command with the member id the directory already accepted. A forwarded call that still carries only the raw bearer would 401 on the shard, because `credentials` is a directory table and `copyRoomRows` does not copy it.

## Migration with dual-read

What is already in the tree, and unwired from fetch and from `store.command`:

- `copyRoomRows` copies one room's room-tables by primary key.
- `compareRoomHomes` reports `events`, `eventsHash` (sha256 over `sequence`, `id`, and `body`, in sequence order), `messages`, and `projectionBytes`. `same` is true only when all four match.
- `mirrorRoomIfEnabled` recopies those tables when the flag is on. It does not apply one command twice. The comment in `server/room-shard-copy.mjs` says the worker does not call it from the command path.
- A full recopy races any command that lands between the copy and the compare. The cutover runbook already says the software does not freeze writes, and that a gap which will not close leaves the room on the pilot.

Dual-read needs the two copies to stay matched while members are still served the pilot. A recopy loop cannot promise that under the write burst this page measures. The implementation that follows therefore dual-writes each command, then shadow-reads.

Order, for one room id. Other rooms stay on the pilot the whole time.

1. **Classification holds.** `assertShardClassification` passes on a fresh store, including any table #4843 or #4842 added. The flag stays off in production config. No production code calls `getByName` on `ROOM_SHARD`.
2. **`storage_home` defaults to `pilot`.** `ensureStorageHomeIfEnabled` adds the column. Reads and writes of room bytes stay on the pilot.
3. **Copy.** `copyRoomRows` into `getByName(roomId)` for the one internal room Potter named. `compareRoomHomes` returns `same: true`. On a mismatch, stop. Leave `storage_home` at `pilot`.
4. **Dual-write.** Each command for that room commits on the pilot first, then applies on the shard under the same command id the store already uses for idempotency. A shard failure after the pilot commit does not roll the pilot back: the member's command landed. It records the mismatch and blocks every later step. A retry of the shard apply is safe because the command id is the same. Reads are still served from the pilot.
5. **Tail.** Run `compareRoomHomes` after the dual-write has applied every command the pilot accepted since the copy. `same: true` with no command left in between is the bar. A gap that stays open leaves the room on the pilot. There is no write freeze and no client-visible 409 for the tail.
6. **Dual-read.** For each room-scoped read in the sample below, the worker reads the pilot and shadow-reads the shard. The client receives the pilot response unchanged. A compared read matches when the HTTP status matches and `roomHomeDigest` matches on `events`, `eventsHash`, `messages`, and `projectionBytes`. A mismatch increments `shardMismatch`, is logged with the room id and the four fields, and is not served. Dual-read does not set `storage_home`.
7. **Read flip.** Set `storage_home` to `room` only when `compareRoomHomes.same` is true and `shardMismatch` is 0 across the whole sample. The sample contains at least one of each of these, all taken while dual-write is on:
   - `GET /api/rooms/{roomId}/events`
   - `GET /api/rooms/{roomId}/search`
   - one MCP tool call whose arguments name that room
   - one agent webhook delivery row whose idempotency key is the command id of a command that landed during the sample
   - one `public-read-model` fill of that room, compared to the directory page it writes
   The worker deploy that understands `storage_home` is already live, because `resolveRoomHome` is how the flip is served. Old code ignores the column and keeps serving the pilot, which dual-write has kept complete.
8. **Reversed dual-read.** After the flip, the client receives the shard response. The pilot is the shadow. The same digest and the same sample classes apply. `shardMismatch` still 0 is the bar for leaving dual-write on. Rollback of the flip is setting `storage_home` back to `pilot` while dual-write is still on.
9. **Prune is a separate change.** Stop writing room tables to the pilot, and delete that room's room-table rows from the pilot, only after the backup gates in the cutover runbook: two verified room backups and a green strict restore. Until prune, the pilot NDJSON is still a recovery point for that room. After prune, rollback is a restore from the room backup, not a flag.

A brand-new room may start with `storage_home = room` only after a rehearsal copy has matched, and only behind a default-off flag. Existing rooms are not moved by that flag.

`mirrorRoomIfEnabled` stays a whole-table recopy for the operator steps in the runbook. The command path uses the per-command dual-write in step 4, not a second full copy on every post.

## Routing after the split

The worker chooses the object before `fetch`. `edgePublicResponse` stays on the worker: static assets, discovery, OpenAPI, and `security.txt` never enter an object. `/api/health` stays worker liveness. `/api/ready` stays `SELECT 1` on `invite-only-pilot`.

### Agent API

Room routes under `/api/rooms/{roomId}/…` (the room-route expression in `server/http.mjs`, including `POST …/commands`) authorize on the directory, then run on the object `resolveRoomHome` names. Identity-wide routes (`/api/agent-rooms`, `/api/needs-me`, and the other account routes) stay on the directory. A cross-room read loads membership from the directory, then reads each flipped room from its object and each unflipped room from the pilot rows. One shard that fails drops that room's slice. It does not fail the directory.

### MCP

`/mcp` and `/room/mcp` are handled inside the HTTP server today, so they run on whichever object received the worker fetch. After the split, the directory still terminates the session: `tools/list`, public join tools, and identity mint stay there. A tool whose arguments include a room id is forwarded the same way as a command, after the directory has accepted the bearer. The tool result's event sequence is one of the dual-read sample classes.

### Webhooks

`agent_webhook_subs` and `agent_webhook_deliveries` are directory tables. The delivery journal is appended with an idempotency key (`server/agent-plugin-store.mjs`). `webhook-dispatch` drains on the pilot alarm. A room command that lands on the shard still asks the directory to append the delivery under that command's idempotency key. A retried forward does not double-enqueue. A landed command with no delivery row is a mismatch and blocks the flip. The shard does not drain the directory journal and does not run `webhook-dispatch`. Inbound routes that apply a room command follow the same room-id forward as `POST …/commands`.

### Search

`GET /api/rooms/{roomId}/search` calls `store.search` on that room's messages and projection (`server/http.mjs`). It runs on the object `resolveRoomHome` names. It does not read another room. Public marketing search assets stay on the edge path and do not read `rooms.projection`.

### Public pages

`/r/{slug}`, the agent directory, and the template pages read `public_rooms`, `public_receipts`, and `public_directory_entries` through `loadPublicRoom` (`server/public-rooms.mjs`). Those tables are directory. The pages stay on the pilot. They do not read `rooms.projection`. The `public-read-model` job is what fills them. For a flipped room the job reads the shard, then writes the directory. Until that fill, the page shows the last directory copy. The fill's digest is a dual-read sample class. A mismatch there blocks prune. The member's room read has its own sample.

### Jobs

`room-backup` and directory `store-growth` stay on the pilot. `store-growth` is the job that reads `maxProjectionBytes`. Per-room relief runs on the object that holds the projection. For a flipped room the pilot heartbeat reports that object's gauge. The Worker cron stays the pilot `scheduled` handler, which fans out the room-scoped jobs listed above. A room object may arm its own alarm for a room-local job such as the body sweep. It does not receive the Worker cron.

## Failure modes

| Failure | What the member sees | What the operator does |
|---|---|---|
| Shard constructor throws | Existing 503 `room_unavailable` from the worker boundary. A write whose outcome is unknown is not retried by the worker | Leave `storage_home` at `pilot`. The pilot still has the room |
| `compareRoomHomes.same` is false after copy | Nothing. Reads never left the pilot | Do not set `storage_home` to `room`. Fix the copy or abandon the shard name |
| Dual-write: pilot commits, shard apply fails | The command succeeded on the pilot | `shardMismatch` blocks the flip. Reapply that command id on the shard. A second full copy is allowed only while dual-write is paused for that room |
| Dual-write: shard is applied and the pilot commit fails | The command failed. The member can retry the same command id | The shard apply is idempotent on that command id. The pilot stays authoritative until the flip |
| Dual-read mismatch | The client still receives the authoritative copy (pilot before the flip, shard after) | Flip stays blocked, or reversed dual-read stays open. Do not prune |
| Forward still uses the raw bearer | 401 on the shard | Authorize on the directory. The shard accepts the forwarded member id |
| Webhook enqueue to the directory fails after the room command lands | The room has the event. The subscriber has no delivery | The missing delivery row blocks the flip. Re-enqueue under the same idempotency key |
| Public read model filled from the pilot after the flip | The public page is the old directory copy | The fill's mismatch blocks prune. Refill from the shard |
| Room object runs the pilot alarm | Duplicate backup, duplicate webhook drain, directory jobs against empty directory tables | Room objects do not arm that alarm. The classification test plus the workerd fixture from the simplify design cover it |
| Prune, then a bad shard | The pilot no longer has the room rows | Restore `restoreRoomNdjson` into a new object. That is why prune is last |
| Projection over the cap on the shard | 409 `pilot_limit`, nothing written | Same as today. Relief runs on that object. The split is not a larger cap |
| #4543 landed on a 4 MiB workerd value limit | `SQLITE_TOOBIG` from the platform | Probe with `sqliteValueLimit`. This design does not change the constant |

A flip whose directory update fails leaves reads on the pilot, because `readStorageHome` treats every value other than `room` as `pilot`.

## Metrics that decide success

Measured the same way before the split and after it. A move counts when it clears the noise floor in [BENCH.md](../BENCH.md): median change of at least 10%. One machine, one invocation, same arguments.

| Metric | Pass |
|---|---|
| `compareRoomHomes.same` | True at the flip, and true on the reversed dual-read sample |
| `shardMismatch` | 0 across every sample class in the migration section |
| Cap | A projection of `PILOT_LIMITS.projectionBytes + 1` bytes is refused 409 `pilot_limit` and leaves the stored length unchanged. The constant is unchanged by the split |
| Write burst, one room | `node perf/write-burst-bench.mjs` against a throwaway server. The line is `writes/s`, `p50Ms`, `p95Ms`, `p99Ms`, `rowBytes`. `rowBytes` is `length(CAST(projection AS BLOB))` after the burst. After the split, the same command against a server whose room store is that room's object is not worse than the shared-server baseline by the 10% floor |
| Isolation | A burst on room A, and a single-writer burst on room B, while A and B are on different objects. B's `p95Ms` stays within the 10% floor of B's quiet run. On today's one object, B waits on A's rewrite. That contrast is the metric |
| Directory file after prune | Pilot `dbBytes` no longer includes that room's `events`, `messages`, and `projection`. Before prune it still does, because dual-write kept the copy |
| Webhook | The directory delivery row for the sample command id exists once |
| Search and public page | The search response status and the public-read-model digest match the shadow |
| Largest room row | Store-growth `maxProjectionBytes`, which is `MAX(LENGTH(projection))` across `rooms`. The split passes when that gauge is taken on the object that holds the row and the app cap still refuses past `PILOT_LIMITS.projectionBytes` |

`perf/write-burst-bench.mjs` is the single-server baseline. It listens on `127.0.0.1`, uses a throwaway sqlite file, and prints one JSON line. `--writers` is the number of members posting at once, `--each` is how many posts each of them sends (1 through 30, the chat flood burst), `--seed` is how many messages are posted through `store.command` before the timer. `--side-table` and `--defer-release` ask the store for the #4843 and #4842 switches. The JSON reports `sideTableMessages` and `deferBodyRelease` from the store that actually opened. On this main those properties are absent, so the line says false. Seed authors are not the burst writers, and each of them posts at most 20, so the flood bucket does not refuse the run. The smoke is `node --test perf/write-burst-bench.test.mjs`. This bench does not open a second Durable Object. The isolation row in the table is the metric the implementation adds by pointing two rooms at two stores and running this bench twice.

The room-scale fixture (`scripts/bench/fixture.mjs`) builds one deterministic room, `commons`, shaped like the busiest room. Its largest row is that room's projection:

```sh
node scripts/bench/fixture.mjs --size 1000 --out <dir>
```

Read `length(CAST(projection AS BLOB))` from `rooms` in `<dir>/room.sqlite`. That number is the fixture row on this tree. It is not the production gauge.

## What this page does not do

It does not set `ROOM_PER_ROOM_OBJECTS`. It does not route fetch at `ROOM_SHARD`. It does not call `mirrorRoomIfEnabled` from `store.command`. It does not add `storage_home` on boot. It does not prune pilot rows. It does not change `PILOT_LIMITS`. It does not turn on `sideTableMessages`, `deferBodyRelease`, or `messageProjectionWindow`. Those flags stay at the defaults their PRs and `RoomStore` already ship.
