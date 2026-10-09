# Fixture ledger — POISONED (negative control)
# Must be flagged by accountWave, never silently counted:
#   1. Guild 01 spawned TWICE (duplicate coordinator spawn)
#   2. Guild 02 DONE *before* its spawn line (impossible ordering)
#   3. Guild 03 DONE twice (double completion)

- LAUNCHER HEARTBEAT 2026-10-09T07:52:00-07:00 — canonical launcher live, wave begins.
- Guild 01 spawned (slice: server/work-claims, mission: mutation testing).
- Guild 02 DONE @ 2026-10-09T07:50:00-07:00 — impossible: done before spawn.
- Guild 02 spawned (slice: server/http.mjs, mission: API fuzzing).
- Guild 01 spawned (slice: server/work-claims, mission: mutation testing DUPLICATE).
- Guild 03 spawned (slice: routes+MCP, mission: route fuzzing + docs).
- Guild 03 DONE @ 2026-10-09T08:19:00-07:00 — first done.
- Guild 03 DONE @ 2026-10-09T08:25:00-07:00 — second done, duplicate.
- LAUNCHER HEARTBEAT 2026-10-09T08:35:00-07:00 — ~3 agents live. Steady.
