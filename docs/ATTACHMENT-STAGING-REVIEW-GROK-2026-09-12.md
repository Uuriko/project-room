# Attachment staging review (Grok, G5)

12 September 2026. **Read-only.** Canonical new doc only. No production, schema, HTTP, or integration edits.

**Baseline:** isolated commit `b1ec4f0` (`git show b1ec4f0:server/attachments.mjs`, 98 lines, 8 Node tests). Codex later asked that G5 use that commit because the working tree is adding schema 28. Line citations below are **b1ec4f0** unless marked working-tree.

Independently replayed current working-tree `tests/attachment-staging.test.js` → **9/9** (8 original plus a recovery test Codex added while integrating). Disposable probe imported integration modules read-only (no integration writes). Stage/read/discard control flow is unchanged from `b1ec4f0`; `verify()`/`audit()` are post-baseline (G6).

This is **not** upload/download readiness. There is still no public route.

## What the module does well (not bugs)

- Exact-key retry: same id/uploader/filename/mediaType/length/sha256 returns the original view; different bytes → `409 attachment_conflict` (`b1ec4f0 attachments.mjs:48-53`). Tests cover this.
- Slice copy before persist (`:66-69`); mutating the parent buffer after stage does not change stored bytes. Tested.
- Outer `store.transaction` abort leaves zero rows. Tested.
- Session binding mismatch → `session_binding_changed`. Tested.
- Logical expiry on read does not write; physical `bytes=NULL` only on a later stage write, rolled back if that write fails (`:55-57`). Tested.
- Discard is idempotent; retry of the same id after discard is `410` (`:88-95`).
- Member byte cap 8×1 MiB is atomic; exact retry at capacity still works. Zero-byte files still consume `stagedPerMember` 32. Tested.
- Filename rejects `../`, `\`, controls, bidi (`\u202a-\u202e`, `\u2066-\u2069`). Header-injecting media types with CR/LF rejected.
- Working-tree only: recovery `audit()` hashes length+sha256, not raw payloads. That is G6, not b1ec4f0.

## Implementation faults (present in this module)

### 1. Orphaned staged bytes after membership revocation — ownership + quota

`readStaged` / `discard` require `row.uploader_id === auth.member.id` (`b1ec4f0:80`, `:92`). Owner/moderator cannot touch another member’s staged object (`404 attachment_unavailable`).

Probe after `member.access_changed` `active: false` on guest:

- Guest `readStaged`/`discard` → **401** `unauthenticated` / `Session or key expired or revoked` (credential path `store.mjs:1142`, so the inactive-member **403** at `store.mjs:1146` is never reached).
- Owner `discard` still **404**.
- Row remains `state='staged'` with `length(bytes)=3`.

Nobody can reclaim those bytes until 24h logical expiry **and** a later `stage()` in that room runs the physical UPDATE (`b1ec4f0:57`). Idle rooms keep paying `room_bytes` / `member_bytes` (`:58-64` use `length(bytes)`). Working-tree `audit()` still accepts the row because the deactivated member remains in `roomAuthority.members`.

This is an implementation ownership bug relative to the build contract (“leaving, removal … affect downloads under the same rules”; “sender or authorized moderator can remove”). Staging is not HTTP yet, but the lifecycle already cannot be cleaned up.

The existing “current access is required” test (`attachment-staging.test.js:69-73`) only asserts the deactivated **guest** gets 401. It does not assert owner/moderator cleanup or that bytes leave quota.

### 2. Tombstones permanently consume `recordsPerRoom`

Capacity uses `count(*) records` over **all** states (`b1ec4f0:58-62`). Discard/expiry nulls bytes but keeps the row. There is no purge. 4096 discarded ids block the room forever. Intentional audit retention is a product choice; as written it is a quota DoS. Not tested (`recordsPerRoom` never hit).

### 3. Any authenticating member may stage (no permission)

`stage` authenticates then inserts (`b1ec4f0:44-45`). Guest is added with `permissions: []` (`tests/attachment-staging.test.js:16` at b1ec4f0) and successfully stages. Empty grants are enough. Contract called for uploader authority inside the same controls as room writes. Missing `permissions` check is an implementation gap in this class, not merely “HTTP later”.

### 4. Active-content MIME types are stored

`validate` media regex (`b1ec4f0:35`) allows `text/html` and `image/svg+xml`. Probe staged both successfully. Only CR/LF injection is rejected. Contract: never trust declared MIME as malware safety; v1 download not preview. Staging will feed HTTP later. Denying html/svg/javascript at stage time is still missing.

### 5. SHA-256 is computed on the caller buffer before the copy

`digest(input.bytes)` at `b1ec4f0:46`, copy at `:68`. Single-threaded Node makes this hard to lose, but a SharedArrayBuffer-backed view can change between hash and INSERT. Copy first, then hash the copy.

### 6. SQL size CHECK is a duplicated literal

Table CHECK `byte_length<=1048576` (`b1ec4f0:12`) is not `attachmentLimits.fileBytes` (`:7`). Drift risk when the pilot cap changes.

### 7. Unavailable codes are inconsistent

Logical expiry on **read** → 404 (`b1ec4f0:80-81`). Same id on **stage** after expiry/discard → 410 (`:52`). Clients cannot distinguish unknown id from expired staged id on GET.

### Working-tree only (not b1ec4f0; belongs to G6)

`verify()` compares `sqlite_master` table SQL to `attachmentSchema.split(';')[0]`, dropping `CREATE INDEX room_attachments_owner`. A missing index still “verifies”. Do not treat that as a b1ec4f0 staging bug.

## Pre-integration gaps (not bugs in this class)

These are expected until Codex finishes G6+ and HTTP:

- No `committed` / message-reference state; no attach-to-`message.posted`.
- No HTTP upload/download, CSRF, auth-before-body-read, `no-store`/`nosniff`/disposition.
- Canonical public MCP still has no file routes (G4 absence tests). Keep `ship:false`.
- `roomBytes` 16 MiB never independently hit (member 8 MiB fires first).
- Worker adapter covered by Codex’s `cloudflare/attachment-staging.check.mjs` (not re-run here; Node tests only).
- Physical expiry is write-driven; no standalone reaper.
- Empty files are allowed; storage qualification said that is not yet product policy.

G6 (migration/recovery invariants) is Codex’s current schema-28 lane. This review does not duplicate it. `audit()` + recovery test are positive evidence, not a full restore contract.

## Minimum missing tests (for Codex’s files, not written here)

Implementation:

1. After uploader deactivation, owner/moderator can discard (or an explicit room-reaper expires bytes) and `length(bytes)` becomes null; today this **fails** (probe).
2. `text/html`, `image/svg+xml`, `application/javascript` policy (reject or mark unsafe).
3. `recordsPerRoom` fill with discarded rows then a new stage → capacity.
4. Two members: memberBytes vs roomBytes independently.
5. Owner cannot `readStaged` guest object (privacy; probe 404) — should be a checked test, not only guest-cannot-read-owner.
6. Inactive membership **403** path (`store.mjs:1146`) as well as revoked-credential **401**.
7. Copy-then-hash (or SAB mutation) if they keep hashing the caller view.

Pre-integration (wait for routes → G7):

- Auth before reading body; false/missing/oversize Content-Length; CSRF; cross-room URL; revoked session between body read and commit.

## Verdict

Staging at `b1ec4f0` is a real bounded in-DB lifecycle with good retry/slice/rollback. It is **not** a file-sharing product. Concrete faults to fix before HTTP: orphaned bytes after revocation, tombstone record cap, permissionless staging, html/svg accepted, hash-before-copy, CHECK/limit drift.

I am not implementing those fixes. Off integration/identity-scope/frozen MCP. G6–G9 wait for Codex assignment.
