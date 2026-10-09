# Gotchas (guild-12 slice)

1. **Enqueue validation has no lower bound on `dueAt`.** Negative (or zero)
   `dueAt` is accepted and the wake is immediately due. Fail-first
   regression: `findings/guild-12/regress/enqueue-negative-dueat.test.js`.
   (Fuzz F7 finding.)

2. **`recover()`'s exhausted-lease path was untested.** The M-18 contract
   ("exhausted leases go to dead on crash recovery") lived only in a code
   comment; the suite never exercised it. A `>=`→`>` mutant stranded
   exhausted leases in `leased` forever and passed everything. Fail-first
   regression: `findings/guild-12/regress/recover-exhausted-dead.test.js`.
   (Mutant M04.)

3. **`maxAttempts: 5` (the legal max) is unpinned.** The boundary mutant
   (`>`→`>=`) survived — no test enqueues with exactly 5. (Mutant M06.)

4. **Absolute timing constants are unpinned.** Tests assert relative order
   (due after backoff), not the values of `leaseMs`/`baseBackoffMs`, so
   constant changes (M13/M14) are invisible to the suite.

5. **WorkWakes unit verdicts need the whole wake suite.** `agent-wake.test.js`
   is client-level; `transition`/`permitted`/`ack` mutants survived it and
   died on the full set. Never judge a `work-wakes.mjs` mutant on one file.

6. **`eventsAfter` runs before the stream-limit check in `stream()`.** A
   client with a bad cursor gets its cursor error even at the 100-stream
   cap — cursor validation isn't starved by load. (Also: auth happens before
   the cap check, so 429s never leak auth state.)

7. **Shared-pump head-of-line effect (fanout branch).** One far-behind stream
   drags the shared page window; head streams wait for the window to catch
   up. Documented tradeoff, not a bug — but a latency-sensitive consumer
   should use its own room or a fresh cursor.

8. **`wakeCoalesceKey` concatenates URL + eventId with no separator**
   (fanout F2, `server/agent-plugin-store.mjs`). Practically untriggerable
   (eventIds are UUIDs), but a `JSON.stringify([url, eventId])` key would
   remove the latent collision class.

9. **`/tmp` is hostile.** Scratch worktrees and files vanish (another agent
   wipes it). Keep everything under `~/workspace/`. (Also: `/tmp` is a
   near-full tmpfs — always `TMPDIR=$worktree/.tmp` for test runs.)

10. **Mutation runs need `flock` per source file.** Concurrent mutants on the
    same file corrupt each other; the driver serializes via
    `.tmp/mutlock-<file>`. The runtime may SIGTERM background sessions whose
    metadata registration timed out — the driver's `trap restore EXIT`
    guarantees the source is restored; re-run the unit.

11. **Baseline first.** A KILLED verdict is meaningless without a green
    baseline on the same tree. The guild-12 baselines:
    `findings/guild-12/logs/BASELINE-*.log` (all green).
