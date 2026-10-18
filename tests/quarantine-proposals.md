# Quarantine candidates — evidence file (Q-1 trigger)

Generated: 2026-10-18T08:27:50.234Z · window: last 48h · workflow: test.yml · repo: Uuriko/project-room

Proposals only — nothing here is quarantined. Acceptance: the owning lane
confirms with `scripts/flaky-detect.mjs` (>=5 runs), assigns an owner, and
the landing authority enters the test in `tests/quarantine.json` with
`repair_by` <= entry + 14 days. An entry without evidence is worse than
no entry: quarantine weakens a gate.

## Proposed entries (5)

### tests/soak-leak-detection.test.js > soak harness PASSES on a clean server

- signature: rerun-flip · job: unit shard 1/3 · head: d0b9e0606dc0beee82789e534ad1b4699db352e8
- evidence: https://github.com/Uuriko/project-room/actions/runs/39073299611
- draft repair_by: 2026-11-01 (if entered 2026-10-18)

### scripts/native-wake-bridge-browser-check.mjs > macOS wake signal: bounded revalidation for a live session, stale access dropped for a dead one

- signature: rerun-flip · job: browser shard 3/6 · head: b5954b6ab3cf3d31a1632f043ee580d405426406
- evidence: https://github.com/Uuriko/project-room/actions/runs/39024836806
- signature: rerun-flip · job: browser shard 3/6 · head: 96ed3c44a810bcc2698ea25460d4251b47bb4c5d
- evidence: https://github.com/Uuriko/project-room/actions/runs/38997148579
- signature: rerun-flip · job: browser shard 3/6 · head: fc42cee7e0b05c76db702bb84ec95f4c45bcca8b
- evidence: https://github.com/Uuriko/project-room/actions/runs/38993892942
- draft repair_by: 2026-11-01 (if entered 2026-10-18)

### tests/agent-upgrade.test.js > genuine v12 data upgrades atomically; old writers cannot write the current schema

- signature: rerun-flip · job: unit shard 1/3 · head: 9029b108e74c5ac028e3cc4dfdd2a709efbd7413
- evidence: https://github.com/Uuriko/project-room/actions/runs/38952387177
- draft repair_by: 2026-11-01 (if entered 2026-10-18)

### scripts/chat-performance-browser-check.mjs > chat requests activity only; Record loads the complete tail, retries failure and returns to lean reads

- signature: rerun-flip · job: browser shard 3/6 · head: 26f8db6414530edfee13e4fd32f8a2a1f76ad759
- evidence: https://github.com/Uuriko/project-room/actions/runs/38909434553
- signature: rerun-flip · job: browser shard 3/6 · head: 48e8cd551ef09354dab34083c74c3e42a7573f57
- evidence: https://github.com/Uuriko/project-room/actions/runs/38885628744
- draft repair_by: 2026-11-01 (if entered 2026-10-18)

### tests/shed-loop-attention.test.js

- signature: same-sha-divergence · job: unit shard 1/3 · head: e45efaae3c4b8a7cb0b0c54ce3fb8ad9b1f19805
- evidence: https://github.com/Uuriko/project-room/actions/runs/39037652430 , https://github.com/Uuriko/project-room/actions/runs/39036665939
- draft repair_by: 2026-11-01 (if entered 2026-10-18)

## Needs naming before any proposal (1)

- unit shard 1/3 — timeout-flip, head 105f3a4959cfd781dff2a2bb0cc70e09f3952e90: job cancelled at/near its timeout and passed on re-run at the same head; a timeout names no failing test, so no entry is proposed — the shard's evidence goes to the shard flake hunt (T-2) instead
  evidence: https://github.com/Uuriko/project-room/actions/runs/39077371719

## Excluded — not flaky tests (0)

None.

## Documented specimen NOT proposed by this scan (1)

- `tests/join-vocabulary.test.js > walkthrough: one word (invite) joins through all four mechanisms`
  — failed once on hosted CI (run 39019426641, unit shard 3/3), then passed 2/2
  at the exact base head and 2/2 on the merged tree (issue #3877's record).
  NOT proposed: within this scan window its head has no passing observation,
  so neither same-head signature fires — its passes are at other SHAs, which
  the trigger deliberately does not count. Defer, do not enter; if it recurs
  the trigger catches the flip, or a lane confirms it with
  `scripts/flaky-detect.mjs` and proposes entry manually with that evidence.
