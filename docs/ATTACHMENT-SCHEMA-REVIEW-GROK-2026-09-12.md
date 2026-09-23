# Attachment schema and recovery review (Grok, G6)

12 September 2026. **Read-only.** Canonical new doc only.

**Exact commit:** `e273a7bb5a8ce31441b6a3c3902d18d3f277351a` in `/Users/johnpotter/src/project-room-integration`  
Inspected with `git show` plus a disposable worktree at that commit (not the live working tree, which had already moved to `37f5e4d`). No integration or canonical source edits.

Codex assignment: v27→28 rollback, old writer refusal, staged BLOB integrity/digest, startup schema verification, retained private metadata, recovery completeness. Report precise bugs versus known missing HTTP/UI. G7 waits until routes exist.

Focused replay on the disposable `e273a7b` tree: `tests/writer-fence.test.js`, `tests/attachment-staging.test.js`, `tests/recovery.test.js`, `tests/recovery-comparison.test.js` → **36/36 pass**. Did not start a duplicate broad `scripts/check.mjs`.

## What this commit does (not bugs)

Schema **28**. `applicationTables` is 31 names including `room_attachments` and previously additive `agent_invite_codes` (`writer-fence.mjs`). `registerWriter` keeps `project_room_writer_v27`. Startup `exec(attachmentSchema)` only when captured `version < 28`, inside the same write transaction as fence install (`store.mjs:369-376`). Read-only startup verifies and does not migrate (`:283-296`).

Genuine v27 baseline is committed `b1ec4f0`. `tests/agent-upgrade.test.js` (and Worker `cloudflare/agent-upgrade.check.mjs`) assert:

- injected failure after the new writer is installed rolls back: `user_version` stays 27, catalog unchanged
- successful upgrade: `schemaVersion === 28`, `room_attachments.rows === 0` (v27 had no attachment rows)
- pre-open old writer UPDATE fails (`project_room_writer_v28|unsupported database writer`)
- old software `new OldStore(filename)` throws `newer than this service`

Recovery special-cases `room_attachments`: `store.attachments.audit()` then hashes `{byteLength, sha256}` instead of `SELECT *` BLOBs (`recovery.mjs:104-107`). Fixture stages `fixture.bin` / `application/octet-stream` / bytes `[0,255,7]`. `tests/recovery.test.js` requires **31** tables all with `rows > 0`. Runtime package allowlists `server/attachments.mjs` and schema `"28"`; cold candidate stages and reads a file.

Worker staging fixture no longer `exec`s the table; startup creates it.

HTTP, message commitment, and composer are still absent. That is **known missing product**, not a schema defect.

## Precise defects at `e273a7b`

### 1. Startup `verify()` / recovery accept a missing owner index

`RoomAttachments.verify()` compares `sqlite_master` table SQL to `attachmentSchema.split(';')[0]` (`attachments.mjs:41-44`), which drops `CREATE INDEX room_attachments_owner`. Probe on this commit: `DROP INDEX room_attachments_owner` then `verify()`, `audit()`, and `auditRecovery()` all succeed. Codex already accepted index verification as a G5 follow-up; it is **not** in `e273a7b`.

### 2. `lifetimeMs` is a recovery invariant, not just a staging TTL

`audit()` requires `expires_at === created_at + attachmentLimits.lifetimeMs` (`:54`). Changing the 24h constant invalidates every existing row’s recovery, including discarded tombstones. Fail-closed, but there is no migration key for a policy change. Codex called lifetime fail-closed and temporary; this coupling still belongs on the schema review.

### 3. Tombstone `audit()` re-validates with fake empty bytes

Discarded/expired rows have `bytes IS NULL`. `audit()` calls `validate({ ..., bytes: bytes ?? new Uint8Array() })` (`:58`). That does not check stored `byte_length` against the (absent) payload; it only re-runs filename/MIME rules on a 0-byte stand-in. Corrupt `byte_length` on a tombstone still “audits”. Staged rows with present bytes are digest-checked (`:56`) — that path is sound.

### 4. Packaging contract lists a required module as optional

`store.mjs` unconditionally `import { RoomAttachments, attachmentSchema }` (`store.mjs` +18). `scripts/runtime-package.mjs` `optional.push("server/attachments.mjs")`. Historical optionals that `store.mjs` also imports exist, so this matches house style — but a package produced from a tree that omitted the file would verify the allowlist and then fail on cold `RoomStore` import. At `e273a7b` the file is present, so current packages work. Contract smell, not a current break.

### 5. v27→28 never migrates attachment **bytes**

The genuine v27 path starts from `b1ec4f0`, which had no `room_attachments` table. Upgrade creates an empty table (`agent-upgrade` asserts `rows === 0`). There is no test that pre-existing BLOBs (the old test-only `exec(attachmentSchema)` on v27) survive `CREATE TABLE` without `IF NOT EXISTS`. Production v27 DBs should not have that table. Residual risk only for leftover experimental DBs.

### 6. Stale comment vs v28 fence

`store.mjs:365-368` still says agent invite codes are “purely additive … no schema version bump”. This commit **does** put `agent_invite_codes` in the v28 fenced set. Behavior is the bump; the comment is wrong.

### 7. Recovery still cannot prove later authority (known, not new)

`auditRecovery` returns `authorityFreshness: "capture-only; later revocations..."`. Unchanged. Codex’s schema doc already says a verified capture cannot prove later revocations. Not a regression.

## Checks that hold

| Ask | Evidence at e273a7b |
|---|---|
| v27→28 rollback | Injected `verifyHistory` failure: version/catalog unchanged; writer-fence “failure after fence installation rolls back” test passed in focused run |
| Old writer refusal | Cached UPDATE after upgrade throws v28 writer; `OldStore` refuses newer schema |
| BLOB integrity | `audit()` SHA-256 hex of per-row `Uint8Array`; staging test corrupts bytes → recovery throws `/Attachment data/`; Node `createHash('sha256')` is the digest used on both Node and the Worker fixture |
| Startup verification | `attachments.verify()` on migrate and read-only paths; missing **index** still slips through (defect 1) |
| Private metadata | Recovery table report is `{table, rows, sha256}`; raw bytes not in the return value; filenames/uploader ids are hashed not printed |
| Completeness | 31 application tables; extra-table read-only audit still rejects; FK check includes `room_attachments → rooms` |

`writerFenceDefinitions.length === 93` (31 tables × 3 operations) matches the writer-fence test.

## Not schema bugs (known missing HTTP/UI)

- No upload/download routes, CSRF, auth-before-body, `no-store`/`nosniff`/disposition
- No `committed` / message-reference state
- Public MCP still `ship:false` with no file tools (G4)
- G5 lifecycle faults Codex already dispositioned: orphan cleanup and copy-before-hash **accepted as code changes**; HTML/SVG not a MIME-denial problem; 404 vs 410 intentional; do not invent a write permission

Do not treat this review as HTTP readiness or as closing G5 lifecycle fixes. Those land in Codex’s integration tree after this checkpoint.

## Verdict

`e273a7b` is a real schema-28 integration: migrate in one transaction, refuse old writers, recover 31 tables without dumping attachment bytes. Concrete remaining schema/recovery defects: **unverified owner index**, **TTL baked into audit equality**, **tombstone validate-with-empty-bytes**, **optional package entry for a hard import**, **stale invite-code comment**. G7 waits for routes.
