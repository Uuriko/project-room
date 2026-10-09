# Dead code — server/messages-store.mjs

**None found.** All exports are imported by `server/store.mjs` (verified by
grep). Internal helpers (`affectedMessageIds`, `statementFor`, `textOrNull`,
`storedBody`, `currentRecord`, `compactState`, `readCursor`, `cursorMatches`,
`saveCursor`, `pruneMessages`, `resetRoom`, `loadState`, `nextRoom`,
`fillRoom`, `caughtUpSql`, `nextParityRoom`, `parityNumbers`,
`rememberSweep`, `certifyMessagesParity`) are all used within the backfill /
parity flow.
