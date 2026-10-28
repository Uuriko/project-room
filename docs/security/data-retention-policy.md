# Data-retention policy

**Task:** 200-hard-tasks #176 — define retention: logs, receipts, telemetry,
PII; deletion procedures. Done when: a policy doc with per-data-type retention
periods and a deletion script tested on fixtures.
**Date:** 2026-10-07 · **Lane:** HT-7

This policy consolidates the retention behavior already implemented in
`server/retention-run.mjs`, `server/audit-retention.mjs`,
`server/account-deletion.mjs`, and the privacy policy
(`server/legal-documents.mjs`), and names the periods per data type in one
place. Where code and this doc disagree, the doc wins and the code must be
updated.

## Per-data-type retention periods

| Data type | Retention | Deletion | Implemented by |
|---|---|---|---|
| Web fetch log / web research log (telemetry) | 30 days | automatic, one table per cron tick | `runLiveStoreRetention`, `RETENTION_TABLES` |
| Agent webhook deliveries | 7 days | automatic | `WEBHOOK_DELIVERY_RETENTION_MS` |
| Analytics event rows | 30 days | planned; deleted only with explicit deleter | `createRetention` / `runRetention` |
| Analytics aggregates | 365 days | planned; deleted only with explicit deleter | `createRetention` / `runRetention` |
| Audit events — critical | ~7 years | **archive, do not purge** | `retentionDecisions` planner (plan only) |
| Audit events — high | 2 years | **archive, do not purge** | planner |
| Audit events — normal | 180 days | archive, then purge only with operator approval | planner |
| Audit events — low | 30 days | purge eligible | planner |
| Security audit rows (`account_access_events`) | indefinite | **never auto-deleted** (account-security evidence) | excluded from retention job; kept on account deletion |
| Room events / messages / commands | indefinite | no auto-delete; sole-owned rooms purged on account deletion | excluded from retention job; `server/account-deletion.mjs` |
| Work-claim / invitation journals | indefinite | expired invites purged 90 days after expiry | excluded from retention job |
| Share links | 7 days to expiry | link stops working at expiry; rows purged with invitation sweep | privacy policy |
| Invitations / access keys | 30 days to expiry | same as above | privacy policy |
| Guest access grants | 8 hours | grant expires; rows purged with invitation sweep | `server/guest-invites.mjs` |
| Account sessions | 8 h session / 30 d re-signin cookie | revoked on sign-out / expiry; purged on account deletion | session code |
| Public receipts | indefinite | published artifacts; personal receipts purged on account deletion | receipts code |
| Connected mailbox data (Gmail/Graph) | until disconnect or account deletion | purged on disconnect and on account deletion | `server/account-deletion.mjs` |
| Backups (DB, room-state branch, encrypted venue credentials) | per `docs/BACKUPS.md` | operator procedure | `deploy/project-room-backup.{service,timer}` |

## Principles

1. **Telemetry is disposable; evidence is not.** Request logs and webhook
   deliveries delete themselves. Security audit rows, room events, and account
   records never auto-delete — they are the record an incident response needs.
2. **Deletion is explicit.** The retention job plans by default and deletes
   only when `ROOM_RETENTION_ALLOW_DELETION=1` *and* a deleter is supplied.
   The scheduled tick never scans the live store and never deletes
   (`scheduledRetentionTick`).
3. **Account deletion is the PII eraser.** `server/account-deletion.mjs`
   `RETENTION_POLICY` names purged vs retained categories; purged: sign-in
   credentials, sessions, login methods, passkeys, memberships, connected
   mailbox data, setup answers, profile, sole-owned room messages/files.
   Retained: security audit rows and the deactivated account id. Room history
   already shared with other members is not rewritten.
4. **No silent widening.** Adding a table to `RETENTION_TABLES` is a policy
   change and must update this doc first.

## Deletion procedures

### Routine (automatic)

The cron tick runs `runLiveStoreRetention` one table per tick, bounded by
`RETENTION_BATCH_LIMIT` (100 rows) and an optional deadline. Each table's
batch runs in one transaction; a failure rolls that table's batch back. To
plan without deleting (audit the plan first):

```
ROOM_RETENTION_ALLOW_DELETION=0 node scripts/retention-plan.mjs --db /path/to/room.sqlite
```

To apply (operator only):

```
ROOM_RETENTION_ALLOW_DELETION=1 node scripts/retention-plan.mjs --db /path/to/room.sqlite --apply
```

### On request (PII / account deletion)

1. User deletes their account in account settings (self-serve), or emails
   potter@trydemigod.com (privacy contact).
2. `server/account-deletion.mjs` executes the purge list; the receipt names
   purged vs retained categories.
3. Backups: the operator follows `docs/BACKUPS.md` — account-deleted data in
   backups ages out with the backup rotation; it is not surgically removed.

### Incident (compromise)

Follow the incident-response runbook (task #161, separate doc): revoke at the
provider first, then purge the affected credential rows, then verify rejection.
Deleting a file or rewriting history does not revoke a credential.

## Deletion script

`scripts/retention-plan.mjs` (ships in the companion implementation PR) wraps
`runLiveStoreRetention` as an operator CLI:

- `--db <path>` — sqlite file (required).
- `--table-index <n>` — which disposable-log table (default 0, rotates).
- `--apply` — actually delete; without it, prints the dry-run plan.
- `--limit <n>` — batch cap (≤ 100).
- Prints the receipt JSON: table, cutoff, eligible, deleted, dry-run flag,
  and the excluded categories.

It refuses to run against a DB whose schema it does not recognize, and it
never touches the excluded tables (events, commands, account_access_events,
invitations, activity, webhook deliveries beyond their own 7-day rule).

**Fixture tests** (`tests/retention-plan.test.js`): build a scratch sqlite DB
with `web_fetch_log` rows older and newer than the 30-day cutoff, run the
script with and without `--apply`, and assert: dry run deletes nothing and
reports the eligible count; `--apply` deletes exactly the expired rows and
keeps the fresh ones; excluded tables are never in the plan. Run via
`TMPDIR=<worktree>/.tmp node --test tests/retention-plan.test.js`.
