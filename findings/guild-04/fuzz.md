# wave1000 guild-04 — fuzzing results (15 inputs)

Harness: `findings/guild-04/fuzz/` (`lib.mjs`: bounded `fuzz()` wrapper, every
input has a 60–150s hang timeout; `throwsBounded` asserts clean throws).
Worktree-local TMPDIR throughout. Scripts: `results-batch*.log`, `results-rerun*.log`.

## Final: 15/15 PASS

| ID | Input | Result |
|---|---|---|
| F1 | corrupt event bodies / projection JSON / NULL projection | PASS — writer fence rejects non-JSON (`malformed JSON`); valid-JSON-wrong-shape is invisible to `room()` (serves cached projection, no torn state) but `rebuildProjection` throws clean |
| F2 | duplicate / gapped / deleted event sequences | PASS — duplicate → clean UNIQUE rejection; gap → rebuild throws "not contiguous"; delete → fence keeps log append-only |
| F3 | 5 procs × 50 concurrent claim writes | PASS — 250 claims, zero lost, zero torn |
| F4 | duplicate claim delivery | PASS — idempotent redelivery, idempotent delete, dep-waive correct |
| F5 | disk-full (`ulimit -f`) | PASS — writes stop with `ERR_SQLITE_ERROR`, never hang; file reopens, `quick_check` ok |
| F6 | WAL byte corruption | PASS — SQLite ignores bad-checksum frames, recovers to pre-WAL state; no torn data served |
| F7 | 20 hostile room ids (path traversal, null bytes, …) | PASS — all 4xx-or-clean, no hangs, no stray rows |
| F8 | 5000-event export | PASS — 11.4MB streamed with no heap growth; trailer verifies over full stream |
| F9 | flood-guard burst (100 sends) | PASS — 30 allowed / 70 denied, `Retry-After=2s`, refill after 60s, garbage ids ignored |
| F10 | hostile ids for roomKeyHostId / validAttachmentData | PASS — 6 accepted / 15 rejected-as-422; boolean-only verdicts |
| F11 | 100 racing directory `set()`s (2 procs) | PASS — exactly one settings row, coherent values |
| F12 | 10 hostile export replays | PASS — every malformed input throws clean and bounded; valid export replays `verified:true` |
| F13 | hostile HTML export (XSS payloads) | PASS — all escaped, tombstones intact, `javascript:`/`data:`/`http:` URLs never linked, unknown event types ignored |
| F14 | malformed room-context inputs | PASS — null state/room, negative/non-integer sequence, NaN clock → clean RangeError/TypeError; garbage members/workItems tolerated |
| F15 | SQLITE_BUSY contention | PASS — busy in 536ms, lock release → write succeeds, no torn state |

## Bugs found in the fuzz harness itself (fixed, not product bugs)

The prior coordinator's scripts had never successfully run (broken `../../server/`
import paths — fixed to `../../../server/`). Of the 15, 8 failed on first run for
harness reasons, all fixed and re-verified green:
- F1: didn't expect the writer fence to reject non-JSON at write time.
- F2: fallback test inserted a duplicate without expecting the UNIQUE throw.
- F3/F11: `process.argv` indices wrong under `node -e` (argv[1], not argv[2]).
- F5: nested `bash -c` + `node -e` quoting broke the worker — rewritten to a temp file.
- F6: `store.close()` checkpoints the WAL away before corruption — corrupt first, then close.
- F12: `object-cell` regex matched no real field (title lives inside the projection JSON) — retargeted to the rooms row id; added no-op-skip when a hostile variant isn't present in the export.
- F13: naive substring assertions (`onerror=`, `javascript:`) false-positived on escaped text and inert `<code>` rendering — replaced with unescaped-handler-attribute and `href="javascript:"` checks.

## Product findings from fuzzing

1. **Writer fence validates event bodies** (`malformed JSON` on non-JSON writes) —
   confirmed defense, not a bug.
2. **Event-log integrity gap**: the integrity checksum explicitly excludes the event
   log ("Rooms, projection bytes, and invitation rows. Not the event log."). A
   semantically-corrupt-but-valid-JSON event body is invisible on reopen and only
   surfaces on `rebuildProjection`. Threat model is narrow (requires a store bug or
   direct DB tampering), but the log/projection divergence has no checksum —
   recorded as a hardening gap, not a BUG CONFIRMED.
3. **HTML export defense-in-depth confirmed**: `safeEvidenceHref` + `esc()`/`attr()`
   + CSP meta all hold under hostile input.
