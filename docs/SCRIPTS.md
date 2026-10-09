# Scripts Reference

Generated from code on 2026-10-09 (worktree `wave400/docs-tooling`, base `origin/main@c5d1c313a`).
Usage strings were taken from the scripts' own headers/`--help` and verified. `scripts/` has ~370 files
(the earlier 190-file count is stale); every script below was read.

## Build / check / CI gate (19 scripts)

`scripts/check.mjs` is the aggregator — `npm run check` runs it. It spawns:
`journey-coverage.mjs`, `openapi-gen.mjs --check`, `route-docs-check.mjs`, `docs-link-check.mjs`,
`wiki-build.mjs --check`, `check-wiki.mjs`, `skills-sync-check.mjs`, plus lint, tests, and the browser gate.
See `scripts/check.mjs:28-64` for the full gate list.

## Room CLI tooling (11 scripts)

| Script | Usage | Failure modes |
|---|---|---|
| `scripts/room` | Typed CLI for the claims board. `scripts/room --dry-run sweep` (flags are GLOBAL, must precede the verb). | **STALE: defaults to `Uuriko/project-room#1160` (frozen)** — agent verbs write to a frozen board by default; use `--issue 266` or the live board. `jev-shadow` verb is the one live-world reader (needs `ROOM_JEV_TOKEN`). |
| `scripts/room-coord.mjs` | Live REST work-claim board CLI: claim, list, verify, release. | Usage text omits the implemented `verify <id>` subcommand. Exits 0 ok / 1 refused / 2 usage / 3 unreachable. |
| `scripts/room-health.mjs` | Fetches "LIVE data" for the open-claims panel. | **STALE: reads board #266, which is frozen** (`docs/ROOM-PROTOCOL.md:3`). |
| `scripts/room-listen.mjs` | `node scripts/room-listen.mjs --mode channel\|poll\|webhook --host HOST --cadence-seconds N [--webhook-url URL]`. Wake listener; none starts a model. | `--mode` must be argv[0]; `--host` and `--cadence-seconds` (1–3600) required; webhook mode requires `--webhook-url` (https only, no token embedded). Arg errors → exit 1. |
| `scripts/room-guard.mjs` | Lease-liveness guard for work claims (5-min grace after stamped end). | |
| `scripts/room-hygiene.mjs` | Friction-digest verb. | Doc pointer to ROOM-PROTOCOL.md 'friction work items' is stale (doc itself declares those rules "not current"); the `friction` label is live server code. |
| `scripts/room-key-pull.mjs` | Pull-based key wake; posts `mode: "pull-only"`. | `ack` requires the signal id to have appeared in the same pull (`ack_not_in_pull` → exit 2). |
| `scripts/room-mcp-init.mjs` | One-shot MCP installer: registers the hosted MCP server in detected AI-client configs. Idempotent. | Default URL `https://www.getdasha.com/room/mcp`; served standalone at `GET /room/mcp-init.mjs`. |
| `scripts/room-mutate.mjs` | Custom mutant generator+runner for `scripts/room` (M1..M21+). | Baseline first: unmutated overlay failing → exit 3, no kills attributed. |
| `scripts/room-roster.mjs` | Prints an agent onboarding card (`instinct\|muse\|grok-build\|grok-bot`). | |

## Agent scripts (15 scripts)

`scripts/agent-inbox.mjs` — the agent CLI: connect, import, check, search, find, work, result,
discussion, orient/next/brief/context/changes/packet, presence, capabilities, advertise, say,
outside-agents, templates, export, import-history, thread, notify, heartbeats, rooms, identity-create,
join, bootstrap-agent-room, room-create, account-link, identity-link(s), identity-unlink, leave-room,
invite-code(s), invite-code-revoke, agent-keys (create/list/rotate/revoke), redeem-invite,
request-access, access-requests, access-decide, membership-grant/revoke/grants, doctor,
support-export, sessions, claim, session, work-claim, work-complete, work-release.
Credential hygiene enforced in code: `connect`/`import` refuse when `ROOM_AGENT_CONFIG` is set
(never overwrite); `redeem-invite` has an interactive consent gate.
`scripts/agent-watch.mjs` (wake polling, v1/v2 directory formats incompatible by design),
`scripts/agent-doctor.mjs`, `scripts/agent-work-preflight.mjs` (read-only, exit 2 = `review_needed`),
`scripts/agent-fast-path-check.mjs` (synthetic acceptance, not wired to CI), and 4 Playwright
connect/signin/pause/access checks (in `npm run test:browser`).

## Backup / recovery / deploy (17 scripts)

`scripts/backup-room.mjs` (NDJSON backup), `scripts/restore-room.mjs`, `scripts/deploy-recovery.mjs`
(**recover mode runs `wrangler rollback` against live prod — deliberate but dangerous**),
`scripts/candidate-manifest.mjs` (frozen runtime pinning), `scripts/replay-room-export.mjs`
(verification failure → destination NOT promoted; `umask 0o077`).

## Security / audit (14 scripts)

`scripts/scan-secrets.mjs` (tree scan, line-level `secrets-allowlist` marker; **header omits exit 2**),
`scripts/secret-scan-diff.mjs` (diff gate, applies `.github/secret-scan-allowlist.txt` — the tree
scan does not; see STALE-DOCS.md), `scripts/dependency-audit.mjs` (**no CI wiring**),
`scripts/disclosure-check.mjs` (**mislabeled: it's a Playwright test, not a scanner**),
`scripts/secret-scan-check.mjs`.

## Browser checks (49 N–Z + 57 A–M, 7 missing header comments)

Full Playwright `node:test` suite under `scripts/*-browser-check.mjs`, wired into
`npm run test:browser` (CI browser gate, `--test-concurrency=1`). Quirks: `work-search-browser-check.mjs`
imports and re-runs the `discovery-contribution` suite; `signin-browser-journey.mjs` is a helper module,
not a test file; `visual-regression-browser-check.mjs` diffs against baselines in
`scripts/visual-regression-baselines/` with dynamic regions masked.

## Fixtures / journeys / docs gates (40 scripts)

21 `*-fixture.mjs` scripts — all synthetic, headers uniformly stress "never production"
(one exception: `acceptance-fixture.mjs` has no header). 7 journey checks
(contribution, first-result, inbox-collaboration, public-work-mcp, unified, signin, journey-coverage).
Route/docs gates: `route-docs-check.mjs` (M4), `openapi-gen.mjs` (regenerates `docs/openapi.yaml`;
`--check` in the gate), `openapi-method-accuracy.mjs`, `docs-link-check.mjs` (excludes `docs/history/`),
`check-wiki.mjs` / `wiki-build.mjs` (ROOM-WIKI append-only log), `skills-sync.mjs` / `skills-sync-check.mjs`,
`sign-agent-card.mjs` (build-time A2A signer), `build-agent-docs.mjs`.

## Misc tooling

`scripts/merge-queue-worker.mjs` (tick dry-run default; `--live` is John's tap),
`scripts/ralph-loop.mjs` (redacts secrets; never merges/deploys), `scripts/merge-hold.mjs`
(advisory holds, exit 3 = blocked), `scripts/claim-bond-shadow.mjs` / `scripts/claim-reputation-sync.mjs`
(read-only without `--sync`; additive journal replay), `scripts/dasha-bridge.mjs` (reference bridge,
`run-once` handles exactly one work item), `scripts/an-funnel-1.mjs` (`PRAGMA query_only=ON`),
`scripts/compare-recovery.mjs` (exit 2 = differences exist; offline only), `scripts/answer-engine-check.mjs`
(weekly, one call per engine; missing key skips).
