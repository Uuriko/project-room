# Journals: watch-journal.mjs + setup-journal.mjs

## watch-journal.mjs — attention state (SQLite, private, schema-pinned)

**Purpose.** Durable attention inbox for watchers: two SQLite databases (`ownership.sqlite` for the lifetime stdout-ownership lock, `watch.sqlite` for checkpoints + attention notices), so a short checkpoint commit never blocks on the ownership lock and a second process can always request stop.

**Data flow.** `new WatchJournal(directory, {acquire, version, create})` → `openDatabase()` validates application_id, user_version, exact schema catalog, `quick_check`, `max_page_count ≤ 4096`, then `validateRecords()` deep-checks every checkpoint/attention row (binding shape, origin canonicalization, notice signatures per version). `reconcile(binding, checkpoint, notices, now)` upserts attention rows + checkpoint in one transaction; `pending(limit)` / `ack(id)` (v1) / `acknowledge(id)` (v2/v3, explicit) drain; `health()` / `shouldStop()` / `requestStop()` coordinate the watcher loop.

**Invariants.**
- Schema versions 1/2/3 with `attentionFilter` v1 `own-attention-v1`, v2 `own-context-v2`, v3 `own-context-v3`; capacity `MAX_ATTENTION = 1000` (v3: 1001).
- Every file (db + `-journal`/`-wal`/`-shm` sidecars) must be owner-only, `nlink === 1`, no symlinks — sidecars must not resolve outside the dedicated private directory.
- `reconcile` refuses: binding change (`identity_changed`), sequence regression or event-id mismatch at equal sequence (`history_changed`), over-capacity notices.
- Notices are capped at 8192 bytes, signatures at 4096; duplicate notice ids (v2+) rejected.
- v1 uses blind `ack`; v2/v3 require `acknowledge(id)` with `validId` — "explicit_ack_required" otherwise.

**Gotchas.**
- `openDatabase` closes the db on any validation failure — never unlink either file; a corrupt state dir throws `state_schema_mismatch`/`private_state_required` (fuzz B1 confirmed all corrupt variants rejected).
- The `attentionCapacity` version gate (`version === 3 ? 1001`) is load-bearing; the mutant moving it to v2 survives the suite (test gap M5).
- `reconcile`'s `checkpoint.sequence < previous.sequence` guard: the `<=` mutant **hangs the test suite** (>240s, M6) — the equal-sequence path is exercised by tests that retry reconcile, so a regression here turns into a livelock, not a clean failure. Worth a dedicated regression test with a bounded retry.
- `PRAGMA synchronous=FULL` on every open — durable but slow; tests should use throwaway DBs.

## setup-journal.mjs — setup-time private persistence

**Purpose.** Crash-safe, single-owner journal for `connectRoom`: `privateDirectory()` (0700, realpath), `atomicPrivateJson()` (write temp 0600 → fsync → rename → fsync dir), `openSetupJournal()` (owner.sqlite `BEGIN IMMEDIATE` with `timeout: 0` — a second setup fails fast with "Another setup owns this directory").

**Invariants.** 128 KiB cap on `setup.json`; `O_NOFOLLOW` on reads; every path re-validated for privacy (no links, owner-only) on each access, not just at creation.

**Gotchas.** `timeout: 0` means lock contention is an immediate error, not a wait — callers must not retry blindly in a tight loop.
