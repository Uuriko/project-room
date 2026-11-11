# Operator

The operator surface is how a person who runs Room removes test data and reads whether this process is up. It is off until a secret is set. With the secret unset, every operator path answers 404, the same way an unknown path does.

## Set the secret

Generate a random token of at least 32 bytes. Keep the token somewhere only the operator can read it. Store the hex SHA-256 of that token, never the token itself:

```
node -e "const {randomBytes,createHash}=require('node:crypto'); const token=randomBytes(32).toString('base64url'); console.log('token', token); console.log('sha256', createHash('sha256').update(token).digest('hex'))"
```

Put the hash on the Worker:

```
wrangler secret put ROOM_OPERATOR_TOKEN_SHA256 --env production
```

Send it on each call as `Authorization: Operator <token>`. A room or account cookie is not a substitute. A missing or wrong token is a 404. Calls are limited to 10 a minute per address.

`ROOM_OPERATOR_PROTECTED_ROOMS` is an optional comma-separated list of room ids that purge refuses, in addition to `invite-only-pilot`.

## Normalize room storage

`POST /api/operator/normalization/plan` accepts `roomId` and an explicit boolean
`discardLegacyAssignments`. It reads the exact current head, metadata proof and
legacy assignment counts and returns a `planHash`. Planning changes no room data.

`POST /api/operator/normalization/execute` accepts the same fields plus `planHash`,
`requestId` (1–64 letters, digits, underscores or hyphens) and a nonblank `reason`
of at most 280 UTF-8 bytes. Use the existing `Authorization: Operator` credential.
The operation materializes the current state once into entity records and replaces
the whole-room projection with a small carrier. This one-time operation scales with
current state; it is not a bounded historical replay or a history certificate.

Accounts, member IDs and revisions, permissions, credentials, revocations, OAuth
grants, connections, original events, canonical messages and tasks remain intact.
When explicitly selected, `discardLegacyAssignments: true` removes only this room's
legacy `work_claims`, `work_claim_history` and `collab_assignments`. Review their
counts in the plan. It does not complete or delete canonical tasks.

Legacy inline rooms may explicitly select `adoptAbsentInlineProofs: true` in both
plan and execute. The plan binds this intent and reports canonical message and
missing-proof counts. This mode can adopt only a SQL NULL proof where independently
protected inline state, verified body references, every persisted message field
and the original indexed posting event agree. It refuses conflicting proofs,
shadowed JSON keys and missing proofs justified only by an entity reference or
archive membership. It does not certify historical replay. Omit the option to
retain the ordinary strict refusal; a missing proof is not silently repaired.

Publication and its receipt commit in one transaction. A save failure rolls back.
After a lost response, resend the exact original execute body and request ID;
the saved receipt returns with `duplicate: true`. A changed head or assignment
census requires a fresh plan. Do not roll back to code that cannot read the new
representation. After activation, check existing-agent access, a saved message and
task update, exact retry, and cold restart before declaring the room qualified.

## Purge

Purge is confirm-then-delete. Find and plan do not delete rows. Execute deletes only the ids in a plan that still matches.

1. **Find** lists ids. It never deletes.

   `POST /api/operator/purge/find` with any of `roomTitlePrefix`, `roomIdPrefix`, `identityNamePrefix`, `accountEmail`, and `createdBefore`. The answer is ids and display names. `accountEmail` is an exact address match (case and surrounding spaces ignored) and returns `accounts` with ids and names only; the address is not echoed or written to the audit log.

2. **Plan** counts rows for explicit ids.

   `POST /api/operator/purge/plan` with `targets` (`kind` is `room`, `identity`, or `account`, plus `id`), a `reason`, and optionally `allowActiveMembers: true`. The answer includes per-table counts, warnings, `planId`, `planHash`, and a `confirmToken` that lasts 10 minutes and works once.

3. **Execute** recounts, then deletes inside one transaction.

   `POST /api/operator/purge/execute` with `planId` and `confirmToken`. If a count changed, the answer is 409 `plan_changed` and nothing is deleted. A room purge removes that room's rows. An identity purge revokes the identity (its bearer then gets 401) and removes its links, webhook subscriptions, and deliveries. An account purge runs the existing account-deletion flow.

One plan accepts at most 20 targets and 200,000 rows to delete. Split anything larger.

A room with more than one active human member is refused unless the plan set `allowActiveMembers: true`. The warning names the count. `invite-only-pilot` and any id in `ROOM_OPERATOR_PROTECTED_ROOMS` are refused.

**Money/proof clearance (G-1).** A room with any rows in the money/proof tables — the `bounty_*` family, the `public_work_*` proof family, `public_receipts`, the `spend_*` tables, `work_claims` / `work_claim_history` / `work_claim_config`, `stitch_receipts`, `room_vetting_receipts`, `external_receipts`, `demigod_contracts` / `demigod_contract_requests` — is refused at plan and re-checked at execute, for every caller of the purge machinery (console, panel, or direct API call), with 422 `money_bearing_room`. Purge would delete the ledger and receipts those rows are proof of. There is no override. What happens to a money-bearing room's history before it may die is decision DB-1, not an operator act.

## Panel delete — archived rooms only (Path A)

The console's **Delete an archived room** section is the panel wrapper over the same purge machinery, restricted to one room at a time:

- `POST /api/operator/rooms/{roomId}/purge/plan` with a `reason`. The server verifies the room is lifecycle-archived (`rooms.archived_at` set — its owner closed its writes) before it plans; a room that is not lifecycle-archived answers 422 `room_not_archived`. There is no panel path that deletes a live room.
- `POST /api/operator/rooms/{roomId}/purge/execute` with `planId`, `confirmToken`, `confirmTitle`, and `confirmId`. The server verifies the typed title and id against the room row before forwarding (422 `confirmation_mismatch` when they differ; the title falls back to the id for a room with no title). Execute also requires a per-room export on record (`room_export` audit row, result `ok`) no older than 24 hours, or it answers 409 `export_required`.

After a purge the room id becomes available again. Old links to the room and its receipts stop working, and a future room could reuse the id. Copies in backups taken before the purge survive until those backups expire.

**Use-gate (MF-12 / DB-2): no production purge of a non-test room — through the panel or the generic flow — until John has decided the deleted-id reuse question (DB-2) or accepted id reuse on the record.** Test and fixture purges are unaffected.

## Rooms by size

`GET /api/operator/rooms` lists rooms by stored projection size, largest first. Its `limit` query value is 1 to 500 (default 100); the answer says `truncated: true` when capped. Each room carries `id`, `title`, `projectionBytes`, `capBytes` (the 4 MiB projection cap), `percentOfCap`, `headSeq`, `archived` and `archivedAt`, `protected` (the purge protection list: `invite-only-pilot` plus `ROOM_OPERATOR_PROTECTED_ROOMS`), active member counts by kind, and a `messagesArchived` indicator. Sizes are live reads at request time; the answer's `readAt` says when. This read writes no audit row.

## Export one room

`GET /api/operator/rooms/{roomId}/export` downloads that room's event log only: one `{sequence, event}` per line for JSONL, or the HTML rendering of the same walk when the `format` query value is `html`. No other room, no credentials table, no attachment bytes. The body is materialised in full before the response starts and framed by `Content-Length`; a short read is an incomplete download. The filename is `room-<id>-<yyyymmdd>-seq<headSeq>.jsonl` (or `.html`).

Exporting a room that is **not** lifecycle-archived requires the `confirmRoomId` query value set to the exact room id and a `reason` query value of 1 to 200 characters (for example, reason "cap diagnosis"). A lifecycle-archived room exports with neither. Every export writes an `operator_actions` row (`room_export`, with the reason, format, event count, byte count, and `scrubbed: true`) before the body is sent.

Event bodies are scrubbed on the way out for this product's own token shapes only (`pri_…`, `rak_…`, `ga1.…` become sha256 hashes, at any nesting depth). The response header `X-Room-Export-Scrub: token-shapes` and the audit row carry that marker; nothing is added to the JSONL body itself. Any other secret pasted into a room passes through verbatim: **an export is as sensitive as the room itself**. Keep it with the same care as a backup, never in a shared drive or chat, and delete it when its purpose is done.

Room-event exports are archival history, not full restore artifacts. They omit serving proofs, derived replay units and historical repair receipts. Ordinary import retains current strict replay rules; a historical event can therefore require a whole-store backup rather than event import. Use the existing physical SQLite backup or whole-store NDJSON backup/restore path for recovery, preserving its audit and grant-reconciliation requirements.

This door needs only the operator token. It does not use or arm the whole-store export door; that door and its token are unchanged.

## QA2 leftovers

Find first. Do not type ids from memory into this doc. Prefixes are enough to locate the leftovers:

```
POST /api/operator/purge/find
{"roomIdPrefix":"qa2-authz-"}

POST /api/operator/purge/find
{"identityNamePrefix":"qa2-"}

POST /api/operator/purge/find
{"roomIdPrefix":"personal-","roomTitlePrefix":"My first room"}
```

Read the ids in the answers. Plan those ids with a reason such as "Remove QA leftover". If the personal room still has more than one active human, send `allowActiveMembers: true`. Read the counts. Then execute with the `planId` and `confirmToken` from that plan.

Find plus plan is the dry run: it lists what would be deleted and writes an audit row, and it does not delete. Execute performs the delete and writes its own audit row.

## Archive old messages (room size cap)

A room's stored state is capped at `PILOT_LIMITS.projectionBytes` (4 MiB). At the cap every write to the room is refused with 409 `pilot_limit`. `POST /api/operator/archive` moves older messages out of the room's stored state into the messages table, where search, threads and exports still read them. Pinned messages, work sources and evidence, reply requests and open threads stay.

1. Dry run (the default): `{"roomId":"muse-room","keepNewest":2000,"reason":"projection cap relief"}`. It replays the room's messages table to the room's head and certifies it, then answers `archived`, `retained`, `freedBytes`, `throughSeq`, `projectionBytes` and an `expect` object. Room data does not change.
2. Real run: the same body plus `"dryRun":false` and the dry run's `expect`. If the plan moved since the dry run, it answers 409 `plan_changed` and nothing moves.

`keepNewest` is 100 to 100,000 (default 2,000). A room whose messages table cannot be certified at its head answers 409 `archive_not_ready` naming the step (`backfill_blocked`, `backfill_not_caught_up` or `parity_failed`), and nothing moves. Every call that passes input checks writes an audit row (`messages_archive_plan` or `messages_archive`). Take a backup first. The store-growth job runs this same door on its own for rooms past the 3.5 MB line, up to 3 a tick with `keepNewest` 2,000, and only while a verified daily backup from today or yesterday (UTC) exists; with none it archives nothing and its summary shows `backupMissing: 1`. To undo an archive for one room, `restoreArchivedMessages(store, roomId)` (server/messages-store.mjs) puts every moved message back from the event log. Do not run `store.rehydrateAllProjections()` on an archived room: it inlines every body and the result is over the cap.

## Status

`GET /api/operator/status` returns the deployed version, whether storage is ready, the largest table counts, and the last 10 operator actions. Job heartbeats are on the Worker, so `jobs` is `see /api/health/jobs`.

For a fresh comparison of one explicitly selected small room, use `GET /api/operator/status?parityRoom=<room-id>&expectedHead=<sequence>`. This mode bypasses the global failure sample and returns only `version` and `messageParityDiagnostics`. Supply exactly one nonblank room id and one decimal head from 1 through 64; duplicate, unpaired, malformed or additional query parameters return 422 `invalid_request`. Operator credentials and the GET method are checked before selector parsing or target reads.

Selected diagnosis runs in one read transaction. Before transferring payloads, SQL checks stored scalar types and UTF-8 octet lengths over indexed target-room ranges, with a 65-row refusal sentinel. Admission allows at most 64 events, 64 rows in each message/body/work domain, and 256 KiB of aggregate consumed input including conservative serialization overhead. The response is at most 4 KiB. These bounds do not measure physical I/O or promise a CPU duration. Canonical message authority, message entity references and message archive shapes are unsupported in this initial inline-room mode.

A complete `clean` result requires the requested head to remain current, the backfill cursor to match its event anchor, a present valid current metadata write proof, valid message proofs, verified referenced body hashes, existing serving-content proof checks and the existing message parity comparison of exact snapshot/row membership and fields. `proofsVerified: true` reports those current checks; `recordedCertifiedSequence` is the stored historical certification and is not refreshed by this read. A complete comparison can instead return `mismatch`. Missing/corrupt proofs, storage failures, unsupported shapes, changed heads or admission/budget limits return HTTP 200 with `status: "unknown"`, `complete: false`, `proofsVerified: false` and a fixed reason. An absent target in the global sample proves nothing.

This read does not replay events, establish a new proof baseline, certify history, repair rows, update cursors, clear failures or write an audit receipt. It cannot protect against an administrator replacing both content and its proofs. Clients should pin `version.sourceRevision`, the selected room/head and the complete clean result; operator execute receipts must be reconciled independently.

`GET /api/operator/drift?main=<sha>` compares that SHA with the revision this process was built from. The server does not call GitHub. A SHA is 7 to 64 hex characters, or `unstamped`. A short SHA matches when it is a prefix of the deployed commit.

The table counts leave out Cloudflare's internal `_cf_*` tables. A table that refuses a count is listed in `skippedTables` instead of failing the status read.

## Console

`/operator.html` is a small page over these endpoints. Room Settings → Room health (owner only) links to it. It asks for the operator token once and keeps it in `sessionStorage` for that tab only, never in `localStorage` or a cookie. **Forget token** clears it, and a refused token is cleared too. The page shows status and drift, lists rooms by size with a per-row Export button, runs find, builds a plan from find results or ids, and shows the per-table counts. **Execute purge** stays disabled until you type the room title (for a one-room plan) or `purge N targets`. It also has an **Archive old messages** section (dry run first, then run on the dry run's numbers — the room stays open; this is not lifecycle archive) and a **Delete an archived room** section (panel Path A above). It also lists the latest operator actions. Each page load makes three operator calls (status, rooms, and actions), so stay inside the 10-per-minute limit. There is no auto-refresh.

## Audit

Every find, plan, execute, and per-room export writes one row to `operator_actions`. The row holds ids, counts, and the reason you typed. It does not hold message text or secrets. `GET /api/operator/actions` lists them (its `limit` query value is 1 to 200). Update and delete on that table are rejected.


## Interpreting hosted timing

Cloudflare [runtime clocks](https://developers.cloudflare.com/workers/runtime-apis/performance/)
advance on I/O rather than during synchronous execution. A zero startup,
`appMs`, or `Server-Timing: app` value does **not** mean that the constructor or
handler used no CPU. These values retain their existing numeric meaning and
are annotated `clockSemantics: "io-bound"` on hosted startup/request records.
`cpuMeasured: false` describes these duration fields; use platform invocation
CPU/wall telemetry or profiling to investigate CPU, not their difference.

`room.request.residualMs` is the nonnegative difference between the outer
Worker and inner handler clock deltas. `queueMs` remains an identical legacy
alias for compatibility. Neither is measured queue time: constructor work,
transport, scheduling and the clocks' limited visibility can contribute.
`residualAttribution: "unattributed"` makes that limitation explicit. Request
measurements end at response headers and exclude subsequent streaming work.
Store totals cover the code through successful initialization, but cannot
measure synchronous CPU on the hosted clock. Local Node timings must not be
interpreted as hosted timing measurements.

## Optional attachment live index

`POST /api/operator/attachments/live-index/plan` accepts `{reason, reverse?}`.
This is a database-wide operation under the existing Operator credential, not a
room grant. It admits every attachment row, including tombstones in every room,
using SQL scalar types and lengths before reading bounded key text or changing
an index. Initial limits are 32,768 rows, four MiB of room/id/state key bytes and
64 MiB of all variable-column bytes, including blob lengths. These are optional
maintenance bounds, not new upload or lifetime quotas. An over-budget store
keeps the existing attachment path. Scalar bounds do not fully describe physical
I/O, and local measurements are not a production CPU SLA.

Execute at `/api/operator/attachments/live-index/execute` with the same reason,
direction, exact `planHash` and stable `requestId`. Admission and the dependency
hash are checked again in the writer transaction. The optional partial live-state
index and immutable operator receipt commit together. Resolve an unknown response
by retrying the exact input; a changed request under that ID conflicts. An old
receipt describes its original effect, not current installation state: use a new
plan to inspect actual state. The hash binds keys, states, scalar lengths and
schema/index identities; it does not certify payload contents.

`reverse: true` explicitly removes only the exact optional index under the same
bounded plan/execute contract. If later growth exceeds admission, reversal
refuses and leaves the index working. No tombstones, file bytes, primary keys,
owner indexes, visibility rules or quotas change. Runtime live predicates remain
valid without the index. No constructor or schema-stamp update automatically
builds it; a matching startup stamp alone is never proof of installation.
