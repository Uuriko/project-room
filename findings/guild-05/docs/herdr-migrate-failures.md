# scripts/herdr-migrate.mjs — failure modes & gotchas (guild-05 D5)

## Failure modes
- **Torn journal line bricks the tool**: readJournal JSON.parses every non-blank line with no tolerance — a partially-written final line throws (verified 2026-10-09, still open, already filed).
- **No journal lock**: appendJournalEntry is read-modify-append with no locking — concurrent runs duplicate seq numbers (verified 2026-10-09, still open, already filed).
- **failExit paths**: 22 fail-closed exits (bridge down, version mismatch, bad flags).

## Invariants
- Dry-run by default; mutating commands need --execute; destructive needs --confirm (+ --reason for force-release).
- Opt-in markers: unknown member/room is reported as unknown, never guessed.
- Bridge required in execute mode (fail-closed); scan mode marks bridge-dependent checks unchecked.
- Idempotency keys: terminal journal kinds gate re-execution (findTerminalEntry).

## Gotchas
- parseArgs: --dry-run and --execute cannot combine; --execute flips dryRun off.
- plan journals only under --execute, else prints would_write.
- Eligibility is (room, claim) ordered; fromCursor/limit slice the ordered plan.
