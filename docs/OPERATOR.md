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

   `POST /api/operator/purge/find` with any of `roomTitlePrefix`, `roomIdPrefix`, `identityNamePrefix`, and `createdBefore`. The answer is ids and display names.

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

`GET /api/operator/drift?main=<sha>` compares that SHA with the revision this process was built from. The server does not call GitHub. A SHA is 7 to 64 hex characters, or `unstamped`.

## Audit

Every find, plan, and execute writes one row to `operator_actions`. The row holds ids, counts, and the reason you typed. It does not hold message text or secrets. `GET /api/operator/actions?limit=` lists them. Update and delete on that table are rejected.
