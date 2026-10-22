# Message domain checkpoint — 2026-10-18

## Scope delivered

Schema 39 adds bounded internal reducer history beside normalized messages and
fences older writers. The current-record API never returns that history copy;
message redaction and account deletion erase it. Existing archived rows migrate
lazily and remain recoverable through the journal.

Message admission is extracted into `server/message-command-service.mjs`; pure
message/poll/pin/redaction reducers are in `src/message-reducers.js`. The shared
event coordinator supplies explicit authority guards. Runtime packages and browser
asset declarations include both modules. This is a real domain boundary, but the
projection carrier still exists and this is not canonical entity-only storage.

An archived edit reads its entity and original posting provenance. An archived
reply restores all visible ancestors with one projection write. A legacy chain
uses at most one replay. Work proposals, completion evidence, progress and
decisions resolve their referenced records through the same admission boundary.
Permission or revision failures roll restoration back with the command.

Public feeds seek from indexed cursors. Squad references and stable receipt
cards work across archival. Recent snapshots preserve their visible window,
omitted count and older visible pins; explicit full snapshots retain the old
full-history contract. Exact omitted counts still scan metadata.

Recovery replay now owns its event-ID maps and audit log for one fold, avoiding
repeated copying of every accumulated journal entry. It uses the same domain
reducer, preserves duplicate/conflict behavior and never mutates the input state.

## Reproducible measurements

Run `scripts/test-env.sh node scripts/benchmark-message-boundaries.mjs` with Node
24.19 or later. Optional positional arguments select history sizes. Each edit
runs at an identical head and rolls back; modes alternate, with two warmups and
12 measured samples per mode. A separate, untimed sample profiles SQL result rows,
serialized result bytes and bound bytes. Rollback time is excluded. These are
in-memory SQLite measurements on a shared Mac, not production latency claims.

Final 10,000-message confirmation, eight messages retained, 6,322 projection bytes:

| Measurement | Entity restoration | Optimized legacy recovery |
| --- | ---: | ---: |
| Median edit | 3.06 ms | 466.90 ms |
| p95 edit | 3.71 ms | 474.74 ms |
| Prepared statements | 21 | 24 |
| SQL result rows | 19 | 10,022 |
| Serialized SQL result bytes | 4,563 | 7,959,978 |
| Bound parameter bytes | 15,984 | 16,025 |
| Room replays | 0 | 1 |

At 1,000 messages, the profiled run also used 21 statements and 19 result rows
for entity restoration (4,544 result bytes). SQL row/byte counts establish the
history-independent lookup behavior more directly than wall-clock samples.
Bound bytes include repeated reads and writes; they are not WAL bytes or actual
on-disk write amplification.

Before the replay-journal change, the 10,000-message legacy baseline measured
40.88 seconds median and 68.64 seconds p95. That run experienced different host
contention, so its ratio against the final run is indicative rather than a
controlled production speedup. The old path's repeated journal copying was also
observed in a native process sample. This checkpoint does not measure 100,000
messages, production Durable Object latency or room-placement isolation.

## Verification

- Final message/replay/recovery/snapshot/privacy/census/manifest run: 163 passed.
- Final runtime-package/browser/Workers/writer-fence run: 17 passed.
- Repository checks passed: syntax, lint, schema/documentation checks, secret
  scanning, public assets and design-token/contrast checks.
- Schema and reader integration run: 112 passed, including lazy schema 38 upgrade.
- Extracted reducer and message domain run: 117 passed.
- Browser edit/delete/pin checks: 10 passed.
- Workers checks: 5 passed, including archived edits with replay disabled and
  recent snapshot/seek behavior.
- Cold package and manifest qualification: 43 passed.
- Batched ancestry restoration and message regressions: 59 passed.
- Replay fold/recovery tests: 51 passed; subsequent replay/domain integration:
  50 passed.
- Platform-path/census recheck using canonical `/private/tmp`: 89 passed.

These runs overlap; their counts must not be summed into a unique-test total.
The broad run observed 11,063 tests: 11,025 passed, 30 failed, 8 skipped. It ran
while later changes were being made and is not a clean final-tree certificate.
Identified snapshot-shape, module packaging, census and macOS temporary-path
failures were subsequently corrected or passed focused rechecks. Linux sandbox
host-process checks remain unqualified on this Mac: production isolation requires
`/usr/bin/bwrap`; no unsandboxed fallback was introduced to make tests pass.

## Remaining completion contract

Follow `ARCHITECTURE-EXECUTION-PLAN.md`. Canonical entity-only writes, removal of
message projection serialization, independent work/attempt/artifact aggregates,
durable scheduling, room placement, the complete human/agent experience and
production rollout remain unfinished. Rolling mode remains opt-in. No deployment,
push or public release was performed by this checkpoint.
