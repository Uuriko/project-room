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

## Status

`GET /api/operator/status` returns the deployed version, whether storage is ready, the largest table counts, and the last 10 operator actions. Job heartbeats are on the Worker, so `jobs` is `see /api/health/jobs`.

`GET /api/operator/drift?main=<sha>` compares that SHA with the revision this process was built from. The server does not call GitHub. A SHA is 7 to 64 hex characters, or `unstamped`. A short SHA matches when it is a prefix of the deployed commit.

`GET /api/operator/status-surface` composes those records into one read (schema `room.operator-status/1`): the deployed revision at both doors (the Durable Object door is this process; the Worker door is read back from this deployment's own `/api/version/worker`, the same read the deploy tooling makes) with their drift state; one row per registered job with its last success, last failure, and consecutive-failure count, from the Worker heartbeat in production or the Node scheduler's records locally; the claim-prs skipped-row count from its last summary; the integrity tile (the deferred batch cursor's next step, the snapshot verification time, the latest isolated failure, and the failing room when that failure's record is room-scoped — the stored failure message is never republished, only its stable code, step, and record id); the daily backup tile (latest complete backup's size, and the margin in days to the 100 MB single-body cap at the growth rate measured between the two most recent backups — with fewer than two, the margin is `not-recorded`, never estimated); the public board's claimable count; and a behaviour tile for the behavioural SLIs (task success, tool accuracy, cost per task, policy compliance). No SLO budget is defined anywhere in code or config today, so every burn rate renders `not-recorded` with the named data gap; cost per task alone carries an observed measure (lots approved in the escrow journal over the last 30 days). A fact the records do not hold is returned as an explicit `not-recorded` state with the reason — never as a zero or a guess.

The table counts leave out Cloudflare's internal `_cf_*` tables. A table that refuses a count is listed in `skippedTables` instead of failing the status read.

## Console

`/operator.html` is a small page over these endpoints. Room Settings → Room health (owner only) links to it. It asks for the operator token once and keeps it in `sessionStorage` for that tab only, never in `localStorage` or a cookie. **Forget token** clears it, and a refused token is cleared too. The page shows status and drift, runs find, builds a plan from find results or ids, and shows the per-table counts. **Execute purge** stays disabled until you type the room title (for a one-room plan) or `purge N targets`. It also lists the latest operator actions. Each page load makes two operator calls (status and actions), so stay inside the 10-per-minute limit.

## Audit

Every find, plan, and execute writes one row to `operator_actions`. The row holds ids, counts, and the reason you typed. It does not hold message text or secrets. `GET /api/operator/actions?limit=` lists them. Update and delete on that table are rejected.
