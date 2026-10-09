# Integration dependencies

What the deliverable in this directory depends on. Nothing here is vendored;
everything is referenced by exact SHA and re-materialized at test time.

## 1. The SDK under test

- **Branch:** `wave2000/guild-22` (WAVE-2000 guild 22, "Python client SDK")
- **Pinned SHA:** `7a427e12b12eb3c6e974c7bbe5394cd797547ae7`
  (branch tip; SDK code commit `04fb16746`, "new Python client SDK (sdk-python/)")
- **Path in branch:** `sdk-python/` (`room_sdk/`, `tests/`, `pyproject.toml`)
- **Materialization:** `run.sh` uses `git archive wave2000/guild-22 sdk-python`
  — read-only. The released branch is never mutated by this guild.
- **Status:** guild-22 coordinator DONE and released (wave2000 launcher ledger);
  the owner is unavailable for a live handoff. The verified patch in
  `fixes/` is the repair vehicle; landing it needs the SDK owner / Dot / John.

## 2. The contract source (server)

- **Ref:** `origin/main` @ `97f4edf26` ("Merge pull request #2297")
- **Files the fixtures and fixes are pinned against:**
  - `server/store.mjs` — `eventsAfter` (envelope + cursor semantics), `command`
    (idempotency fingerprint), `validateCommand` + message.posted `shapes`
    (field allowlist)
  - `server/conversation-sync.mjs` — `readConversation` (returns raw message records)
  - `server/updates.mjs` — `readEventTail` (same envelope)
  - `server/redact-read.mjs` — `redactEventPage` (preserves the envelope)
  - `src/events.js` — `event()` factory (body has no sequence), `postMessage`
    reducer (records use `id` / `replyToId`)
  - `docs/ERROR-TAXONOMY.md` — error body shape used by the 409 fixture
- **Live cross-check:** muse-room event log read (GET
  `{origin}/room/api/rooms/muse-room/events`, read-only) confirmed the
  `{sequence, event}` envelope on real traffic (seq 8396–8445) and supplied
  the authoritative mismatch list (seq 8227) and redirect (seq 8263).

## 3. Runtime

- `python3` (stdlib only: `unittest`, `json`, `urllib`, `hashlib`) — tested on
  the VM's python3 (3.12).
- `git` (for `git archive`), `patch`, standard POSIX shell.
- No network access required or used by `run.sh` or the tests.

## 4. Coordination

- **Dot (Jill - Dot)** is John's designated orchestration authority for this
  wave; the redirect (seq 8263) and mismatch list (seq 8227) are hers.
- **Parent/launcher:** the COORD-300 launcher ledger at
  `~/workspace/pr-coord300/launcher-ledger.md` is the coordination surface;
  this guild's rollup is delivered there (this guild does not post room
  messages itself).
- **Out of scope / not depended on:** live production, deploys, credentials
  beyond the existing read-only room connection, the muse-room write path.
