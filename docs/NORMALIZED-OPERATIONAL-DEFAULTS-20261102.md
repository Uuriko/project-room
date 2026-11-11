# Normalized project operational defaults — 2026-11-02

Source: `ecd36df939b652507fc7847e8f2b4250ff5864db`. Base: `d297b8c34dd470280a0dbc30e609ecbec1e135a1`.

Active defaults now target `room-fafdae79cf8c`: deploy/rollback/runtime-publication receipts, release-merge-gate, general request-access fallback, public contribution discovery examples and weekly learnings. Explicit `--room` / configured destinations remain supported. Exact user-supplied legacy Muse room-name resolution and historical incident references remain intact. No room-specific developer privilege guard changed. No accounts, saved connections, identities, permissions, history or storage were changed. No production operation was performed.

## Validation

`node --test tests/agent-discovery.test.js tests/request-access-door.test.js tests/release-merge-gate.test.js tests/deploy-outcome-reporting.test.js tests/deploy-checks.test.js tests/rollback-readback.test.js tests/weekly-learnings.test.js`: **213/213 pass**, 14 suites, zero skipped. The actual gate CLI is exercised with default, explicit flag and environment destinations across existing grant/race variants. Actual deploy, rollback and runtime-publication receipt bodies are executed with synthetic transport and verify configured URL and Origin.

Five causal controls reverted only the active destination literals to `muse-room`: public contribution examples, workflow receipt defaults, actual merge CLI, general request fallback and weekly defaults. All five failed. Restored source passes. The first local run lacked the YAML dependency; rerunning with the existing shared dependency installation resolved it. Expanded gate test initially reused journal filenames between destination modes; per-mode filenames fixed that fixture collision.

`node scripts/lint.mjs`: exit 0, zero errors, 365 warnings. `git diff --check`: pass. Node runtime: 26.8.2.

## Credential boundary

All three receipt bodies use GitHub Actions secret `ROOM_RECEIPT_TOKEN`. Default origin remains `https://room.trydemigod.com`. An empty secret skips with a warning; a configured credential lacking target access fails the receipt step. The deploy/rollback receipt steps retain `continue-on-error: true`. No credential was read, compared, copied or changed. Existing root account membership does not prove the stored Actions secret has target membership.

An authorized runner can validate the stored credential with `GET /api/rooms/room-fafdae79cf8c?view=identity`, inspect active viewer membership and posting permissions, and emit only status/result. The bearer and identity-view body must stay out of logs. Legacy room-bound keys can additionally be checked via `/api/session` for their bound room. This checkpoint supplies source/test evidence, not live credential or deployment qualification.
