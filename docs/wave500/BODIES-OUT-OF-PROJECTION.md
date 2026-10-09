# Bodies-out-of-projection (W6/17)

**Status: the core mechanism is already shipped (Phase 1a, 2026-10-07).**
This doc records what exists, with file:line evidence, and what is still
missing. It is not a greenfield design — greenfield design would be
re-litigating shipped code (see §1.3 of
[ADVERSARIAL-REVIEW.md](./ADVERSARIAL-REVIEW.md)).

## 1. Status quo: it exists

The implementation lives in `server/projection-at-rest.mjs`, added by commit
`382dbb28f` ("perf(storage): move bodies >= 256 chars out of room row",
2026-10-07 07:40 PDT). The mechanism:

### 1.1 What it is

- **Content-addressed side table.** `projection_bodies(room_id, sha, body)`
  (`server/projection-at-rest.mjs:26-31`), `PRIMARY KEY(room_id, sha)`,
  `sha` is the SHA-256 of the body. Rows are immutable — a write that is
  later rolled back can never change what an existing `bodyRef` means.
  Dedup is per-room (same body posted twice in one room is stored once).
- **Threshold.** `BODY_AT_REST_MIN_CHARS = 256`
  (`server/projection-at-rest.mjs:22`). A message body ≥ 256 chars is replaced
  in the *stored* projection by `bodyRef` (its SHA-256); shorter bodies stay
  inline. (The 256 value, not 512, is deliberate: with bodies-at-rest on,
  muse-room's projection still grew ~350 B/event because 38% of recent bodies
  were 256–511 chars and stayed inline.)
- **One serializer.** `storedProjection(db, roomId, state, { enabled })`
  (`server/projection-at-rest.mjs:88`) is the *only* way a projection becomes
  the text in `rooms.projection`. `RoomStore.storedProjection`
  (`server/store.mjs:2686-2688`) wraps it with the store's `bodiesAtRest`
  flag; every writer uses the method. Slimming is on only when the store was
  opened with `bodiesAtRest` (`ROOM_BODIES_AT_REST=1`; `server/store.mjs:1170-1172`,
  `cloudflare/room.mjs:98`); hydration is always on regardless of the flag.
- **Hydrate-on-read.** `hydrateProjection(db, roomId, state)`
  (`server/projection-at-rest.mjs:114-124`) puts bodies back into a state
  parsed from `rooms.projection`, verifying `sha256(body) === bodyRef` on
  every ref (integrity check, not just a lookup). `store.room()`
  (`server/store.mjs:2653-2669`) hydrates on every cache miss; the reducer,
  the in-memory cache and every reader keep full bodies.
- **Raw-record hydration.** `hydrateRecordText`
  (`server/projection-at-rest.mjs:133-142`) covers one message record read
  straight out of `rooms.projection` with SQLite JSON functions — the
  conversation-sync unindexed path (`server/conversation-sync.mjs:107`), with
  a `recover` fallback into the hydrated store.
- **GC via trigger, in the same statement.** `projection_bodies_release`
  (`server/projection-at-rest.mjs:32-37`) deletes, on `UPDATE OF projection`,
  every body the new projection no longer references — deleted, redacted and
  purged text does not outlive the projection that held it.
  `projection_bodies_room_gone` (`server/projection-at-rest.mjs:39-42`)
  cleans up on room delete.
- **Open-time schema install.** `PROJECTION_BODIES_SCHEMA` is in the store's
  schema list (`server/store.mjs:1076`) and exec'd at open
  (`server/store.mjs:1788`) — existing databases get the table with no
  rewrite of history.
- **Rollback story shipped.** `RoomStore.rehydrateAllProjections()`
  (`server/store.mjs:2673-2684`) writes every room back with full bodies in
  one transaction; the release trigger then empties `projection_bodies`. An
  older build must run this before a rollback (module header,
  `server/projection-at-rest.mjs:13-15`). `atRestBodyBytes`
  (`server/projection-at-rest.mjs:127-130`) reports the bytes held
  out-of-projection.

### 1.2 How the projection is built today (the fold)

For readers who need the whole picture: the projection is the fold of the
immutable event log. Events live in `events(room_id, sequence, id, body)`;
`_replayRoom` (`server/store.mjs:2717-2740`) reduces them with `applyEvent`
(from `server/event-log.mjs`, imported `server/store.mjs:26`) starting from
`emptyRoomState()` (`server/store.mjs:2747`). Message-post events append full
bodies to `state.messages` in memory. On commit, `store.storedProjection`
serializes the in-memory state (slimming bodies ≥ 256 chars when enabled) and
the write path checks `Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes`
(4 MiB, `server/store.mjs:427`, enforced `server/store.mjs:4787`) **before**
the `INSERT INTO events` — the 4 MB cap is atomic with the event write, so a
room can never half-exceed it. Then `UPDATE rooms SET sequence=?, projection=?`
persists the slimmed row (`server/store.mjs:4800`).

Key consequence: the cap is enforced on the *stored* (slimmed) bytes, and the
usage gauge agrees — `server/usage-summary.mjs:86` measures
`length(CAST(projection AS BLOB))`, i.e. the slimmed row, not the hydrated
state. Bodies-at-rest buys real headroom against the binding constraint.

### 1.3 What it covers — and the verified gaps

| Area | Status | Evidence |
|---|---|---|
| Slim on write (message post, redaction, invites, land-queue) | ✅ shipped | `server/store.mjs:2686`, `server/message-redaction.mjs:143`, `server/access-requests.mjs:349,537`, `server/guest-invites.mjs:333,420,609,795`, `server/agent-invites.mjs:311`, `server/guest-agent-links.mjs:246`, `server/land-queue.mjs:888` |
| Hydrate on read (`store.room()`) | ✅ shipped | `server/store.mjs:2664-2665` |
| Raw-record read path | ✅ shipped | `hydrateRecordText`, `server/conversation-sync.mjs:107` |
| Search over bodies | ✅ covered | `store.search` reads `this.room(roomId).state` (`server/store.mjs:4162-4165`) — hydrated |
| Parity checker | ✅ shipped | `server/messages-store.mjs:430-431` hydrates, throws on missing |
| Schema install on existing DBs | ✅ shipped | `server/store.mjs:1076,1788` |
| Rollback | ✅ shipped | `server/store.mjs:2673` |
| Tests | ✅ shipped | `tests/projection-at-rest.test.js` |
| **Restore path hardening** | ❌ **unassigned** | `server/store.mjs:2691-2710` exists but is unhardened — see §3 |

### 1.4 Verdict on the adversarial review's claim

`docs/wave500/ADVERSARIAL-REVIEW.md` §1.3 says the fail-closed 500 restore path
is "the one failure mode nobody is assigned to" — the restore path exists,
but the review's substance is **verified correct**:

1. **Unbounded replay on the read path.** `_restoreBodiesFromLog`
   (`server/store.mjs:2691`) calls `_replayRoom(roomId, sequence)`, which
   replays from `projection_checkpoints` *if one exists* — but checkpoints are
   only written on history import (`server/store.mjs:4124`) and provenance
   repair (`server/store.mjs:2567`). The normal write path writes no
   checkpoint. For most rooms a missing body row means replaying the **entire
   event log** (up to 1M events) inside a `store.room()` call.
2. **No self-healing — the replay recurs.** `_restoreBodiesFromLog` refills
   bodies **in-memory only** (it mutates the parsed state before the
   deep-freeze at `server/store.mjs:2666`). It never re-inserts the missing
   rows into `projection_bodies` and never rewrites the stored projection.
   `store.room()` caches per-sequence, so the *next write* invalidates the
   cache and the next read replays the full log again. A room with a missing
   row pays a full-log replay on every write→read cycle until something
   rewrites its projection.
3. **Fail-closed 500 on every read when unrecoverable.** If the replay cannot
   restore a body (e.g. PRIV-1 redaction rewrote the wording out of the event
   log — `server/messages-store.mjs:141` — the one case the design explicitly
   names as "only an out-of-band write"), `fail(500, "projection_corrupt")`
   fires inside `store.room()` (`server/store.mjs:2703`), which is the read
   path for nearly everything: the "500s every room read" claim is accurate
   for the unrecoverable case.

Note the mitigating facts, for fairness: a missing body row can *only* be
caused by a write outside `storedProjection` (comment at
`server/store.mjs:2689-2690`) — there is no known producer of missing rows in
the shipped code; and the projection cache means an idle room pays nothing.

## 2. Design: the remaining work (hardening, not architecture)

The core write/hydrate design is §1. The design work that remains is the
restore path. Requirements: a missing body row must not (a) replay an
unbounded event log on a hot read path, (b) recur forever without healing,
(c) 500 every read when the body is genuinely unrecoverable.

**Option A — heal on restore (recommended, small).** After a successful
`_restoreBodiesFromLog` replay, re-insert the restored `(room_id, sha, body)`
rows into `projection_bodies` inside the same read transaction (or a
follow-up write). The replay becomes once-only per room; the recurring-DoS
property disappears. Cost: one extra write on a path that is already
exceptional; the immutable-rows invariant is preserved (same content, same
sha).

**Option B — checkpoint on restore (bounded replay).** After a restore replay,
write a `projection_checkpoints` row (full bodies, mirroring
`server/store.mjs:2567`'s convention that checkpoints keep full bodies).
Subsequent restores replay only from the checkpoint. Complements A; alone it
bounds the replay but does not stop recurrence.

**Option C — degraded-read mode (for the unrecoverable case).** When replay
cannot restore a body, serve the room with the affected messages marked
body-unavailable (tombstone-shaped) instead of `fail(500)`. Readers already
handle `body == null` as a tombstone (`server/store.mjs:4168` skips them in
search). This converts "500s every room read" into "that message's body is
gone" — which is the honest state, since redaction already produces exactly
that. The `projection_corrupt` 500 stays for genuinely corrupt projections
(missing authority fields, etc.).

**Explicit non-goals.** Previews: the shipped projection keeps
`{bodyRef}` only — no `{hash, length, preview}`. Keeping an inline preview
would duplicate redaction-sensitive text and reintroduce the GC subtlety the
trigger solves; search and conversation reads hydrate the full body anyway.
Length: derivable from `projection_bodies` at write time if a gauge ever
needs it; not stored in the projection today.

## 3. Migration: rooms with bodies already in the projection

There is no eager backfill and there should not be one:

- **Lazy slimming on next write.** When a room with a full-body projection is
  next written with bodies-at-rest enabled, `storedProjection` slims every
  body ≥ 256 chars into `projection_bodies` (insert-if-absent) and stores the
  slimmed row; the release trigger has nothing to delete. History is never
  rewritten — the event log is untouched.
- **Rooms that never write again** keep full bodies forever. That is fine:
  they are idle; they do not approach the 4 MB cap.
- **Mixed-version safety.** Hydration is always on, slimming is flag-gated, so
  a build with the flag off reads slimmed rows (rehydrating any `bodyRef` a
  raw-read state carries — `server/projection-at-rest.mjs:89-90`) and writes
  full bodies back. The deploy lane pins `ROOM_BODIES_AT_REST=0` during
  rollout (`docs/DEPLOY-LANE.md:23`) while `deploy-prod.yml:228,239` sets it
  to 1 on the finished deploy — **these two disagree and should be reconciled**
  (doc drift, not a code bug).
- **Rollback.** `rehydrateAllProjections()` before rolling back to a build
  without `hydrateProjection`; otherwise the old build serves `bodyRef`
  strings as message bodies — silent read corruption.

## 4. What breaks if done wrong

1. **Export/restore.** `server/room-export.mjs:64` enumerates all tables, so
   `projection_bodies` rides the NDJSON export today — and
   `scripts/backup-room.mjs` copies the sqlite file whole. But any hand-rolled
   export that names tables explicitly and omits `projection_bodies` produces
   a backup whose projections reference bodies that do not exist. On restore,
   every room read then takes the §1.4 path: full-log replay, or 500s if the
   events cannot restore the bodies. The one healing path is history import
   (`server/store.mjs:4123-4124`): it writes the projection through
   `storedProjection` (re-slimming, re-inserting bodies) and writes a
   full-body checkpoint.
2. **Raw SQL over the stored projection.** Any *new* path that reads
   `rooms.projection` with `json_each(... '$.messages')` and extracts `$.body`
   without `hydrateProjection`/`hydrateRecordText` returns `bodyRef` hashes to
   users. Existing raw readers are safe because they only extract work-item
   and id fields, never bodies (`server/agent-identities.mjs:482`,
   `server/store.mjs:2015,2085,2497,2511,2518,2539`, `server/messages-store.mjs:232`
   prunes by id only).
3. **The release trigger's shape assumption.** `projection_bodies_release`
   deletes every body whose sha is not in
   `json_each(NEW.projection, '$.messages')`. If the projection JSON ever
   nests or renames `messages`, that subquery silently returns empty and the
   trigger **deletes all bodies for the room in the same statement**. Any
   projection-shape change must assert against this trigger (a test should
   pin it).
4. **Projection-size gauge drift.** `server/usage-summary.mjs:86` measures the
   stored row. Correct today. Any gauge that compares the *hydrated* state
   against the 4 MB cap would misread headroom — the cap is enforced on
   stored bytes (`server/store.mjs:4787`).
5. **Tests asserting projection bytes.** `renameKey`
   (`server/projection-at-rest.mjs:44-51`) deliberately preserves key order so
   a slim→hydrate round trip is byte-identical to the original stored row;
   byte-equality tests on `rooms.projection` legitimately differ between
   flag-on and flag-off stores.
6. **Rollback without rehydrate.** §3 — old build serves `bodyRef` as body
   text.
7. **Recurring restore DoS.** §1.4 point 2 — the restore path never heals the
   DB today.

## 5. Estimated projection savings (real numbers)

`docs/wave500/PROJECTION-COST-TABLE.md` has **not** landed (the wave500 docs
dir holds only `ADVERSARIAL-REVIEW.md`, `EVENT-BUDGET-DESIGN.md`,
`ROOM-ROTATION-DESIGN.md`). Numbers below are from the shipped code comments
and the G11 incident that motivated it:

- **G11 (2026-10-06):** muse-room reached **82% of the 4 MB projection cap**
  and was ~0.7 days from refusing writes, with the event cap ~10 days out
  (`server/store.mjs:420-426`). Projection bytes — not events — were the
  binding constraint.
- **Immediate savings:** ~**317 KB freed on muse-room on the next write**
  once the threshold dropped to 256 chars
  (`server/projection-at-rest.mjs:18-22`).
- **Ongoing growth:** inline body growth per message roughly **halved**; before
  the 256 threshold the projection still grew ~350 B/event because 38% of
  recent bodies were 256–511 chars and stayed inline
  (`server/projection-at-rest.mjs:16-17`).
- **Accounting:** `atRestBodyBytes` (`server/projection-at-rest.mjs:127-130`)
  reports the exact bytes held out-of-projection per room — the gauge to watch
  in production rather than re-estimating.

Honest caveat: bodies-at-rest moves text out of the *stored row*; the
in-memory state and the event log still carry full bodies. It buys headroom
against the 4 MB cap, not against total disk.

## 6. Relationship to the wave300 payload-store lane

`refs/heads/wave300/payload-store` ships a **general content-addressed blob
store**: `payload_blobs(sha256, byte_length, media_type, bytes)` with global
(content) scope and cross-room dedup, `payload_pins` for pin-set GC, an
R2-ready `BlobBackend` interface, HTTP routes (`POST`/`GET|HEAD
/api/rooms/{room}/payloads`, 413 over 25 MiB), and a message-post wire-in that
externalizes inline payloads > 64 KiB (server-side hash, pinned in the same
transaction). Design doc: `docs/PAYLOAD-STORE.md` on that branch.

**Verdict: reuse the idea, do not merge the implementations — yet.**

- **Same primitive, different jobs.** `projection_bodies` is a synchronous,
  per-room, message-body-only side table on the hot `store.room()` read path
  (better-sqlite3, trigger GC, immutable rows). The payload store is a
  general, global, HTTP-facing blob store with an async R2-ready backend and
  pin-set GC. Both are sha256 content-addressed; that is the reuse.
- **Why not build bodies-at-rest on the payload store now:**
  1. The hot read path (`store.room()`) is synchronous. The payload store's
     `BlobBackend` is async (R2-ready) — wiring async blob reads into the
     synchronous fold/hydrate path is a real redesign, not a swap.
  2. The binding constraint is *now* (G11 was 0.7 days from refusing writes);
     bodies-at-rest is shipped, tested (`tests/projection-at-rest.test.js`),
     and rollback-safe. Depending on the payload store's rollout would couple
     the fix to a branch that is based well behind main (its base predates
     PR #2065; the diff is large).
  3. Trigger-based release is simpler than pin-set GC for immutable
     same-content rows, and the rollback story (`rehydrateAllProjections`)
     already exists.
- **Convergence path (later, optional).** Once the payload store lands and
  stabilizes, `projection_bodies` could migrate under `payload_blobs` with a
  `kind='projection_body'` pin per room+sha — gaining cross-room dedup (bot
  announcements duplicated across rooms are the obvious win) and R2 offload.
  The migration must preserve the two properties the current design relies
  on: synchronous read availability and the same-statement release guarantee.
  Until then, the two stores coexist; they must not share a table (different
  GC and lifecycle semantics).

## Open items (unassigned)

1. **Harden `_restoreBodiesFromLog`** — §2 options A (heal on restore) + C
   (degraded-read mode). This is the adversarial review's "one failure mode
   nobody is assigned to," verified in §1.4.
2. **Reconcile `ROOM_BODIES_AT_REST` rollout docs** — `deploy-prod.yml`
   sets it to 1; `docs/DEPLOY-LANE.md:23` says pin 0 during rollout.
3. **Pin the release trigger against projection-shape changes** — a test that
   fails if `$.messages` moves without updating
   `server/projection-at-rest.mjs:32-37`.
