<!--
  Rowboat port, Wave 3 (R7): the human plane of the room trust loop.
  Scheduler/board discipline adapted from rowboatlabs/rowboat
  (https://github.com/rowboatlabs/rowboat), (c) rowboatlabs, licensed under
  the Apache License 2.0. Here: one concise weekly brief for John, not a
  dashboard — CHAOSS-style health metrics + a trust digest read off the
  machine plane (ROOM-STATE.md / scripts/room verbs), never hand-computed.
-->

# ROOM-HEALTH.md

The human plane of the project-room trust loop. Machine state lives in
`ROOM-STATE.md` (rebuilt by `scripts/room rebuild` on the `room-state`
branch); this file carries the latest generated digest plus week-over-week
trend lines.

Generator: `scripts/room-digest` — read-only against the board, never
posts. The "Latest digest" section is a point-in-time snapshot: do not
hand-edit it, regenerate it with the script.

## Latest digest

The digest below was generated live from the current board state
(`Uuriko/project-room#266`) by `scripts/room-digest`.

---
# Room digest — week ending 2026-09-16

board: Uuriko/project-room#266 · generated: 2026-09-16T18:32:49Z · window: 2026-09-09T18:32:49Z → 2026-09-16T18:32:49Z · by: scripts/room-digest v0.1.0 (read-only)

## At a glance

2 opened · 0 completed · 0 expired/released · 0 receipts posted · 0 missing (24h SLO) · 0 duplicate-claim refusals · 1 distinct lanes · 269 comments/day

## Merged PRs since 2026-09-09 (96)

| PR | merged (UTC) | sha | claim | receipt | title |
| --- | --- | --- | --- | --- | --- |
| #269 | 2026-09-16T12:55:02Z | 4736978 | - | no | H007: key rotation |
| #272 | 2026-09-16T13:17:54Z | bcd270d | - | no | [quill-s2] F003 rate-limit tuning + dashboard |
| #270 | 2026-09-16T13:18:14Z | 96cd1c9 | - | no | [quill-s2] F023 incident runbook template |
| #271 | 2026-09-16T13:18:20Z | 7bde694 | - | no | [quill-s2] F009 error budget policy + paging rules |
| #273 | 2026-09-16T13:35:13Z | 230d4a1 | - | no | A014: newsletter/bulk-sender detection |
| #274 | 2026-09-16T13:35:17Z | 77a5b4c | - | no | A022: channel failover |
| #275 | 2026-09-16T13:46:17Z | bc7d216 | - | no | B009: agent presence |
| #278 | 2026-09-16T13:46:21Z | 546e848 | - | no | [quill-s2] F010 load-test expansion: 10x scenarios |
| #277 | 2026-09-16T13:48:00Z | f317799 | - | no | B015: attribution ledger |
| #279 | 2026-09-16T13:48:05Z | 43c89ec | - | no | K003: estimates + time tracking |
| #280 | 2026-09-16T13:48:10Z | 3148854 | - | no | B008: per-agent MCP auth scopes |
| #276 | 2026-09-16T13:56:17Z | a0b1661 | - | no | K002: work dependencies |
| #281 | 2026-09-16T13:56:21Z | 65efd02 | - | no | K004: work checklists |
| #283 | 2026-09-16T13:56:24Z | 4124bf5 | - | no | B011: guest invite links |
| #282 | 2026-09-16T13:57:07Z | a609931 | - | no | [quill-s2] F024 chaos drill: kill Durable Object mid-write, verify recovery |
| #284 | 2026-09-16T13:59:22Z | 55a2393 | - | no | [quill-s2] F014 abuse reporting flow for room members |
| #285 | 2026-09-16T13:59:32Z | 6237e1a | - | no | K005: calendar view of dated work |
| #286 | 2026-09-16T14:02:23Z | ba80104 | - | no | B010: agent capability cards |
| #288 | 2026-09-16T14:16:37Z | 4303226 | - | no | K008: decision voting |
| #289 | 2026-09-16T14:20:12Z | 5546c2b | - | no | A009: attachment download |
| #290 | 2026-09-16T14:27:01Z | 1e5af82 | - | no | A017: reply templates |
| #291 | 2026-09-16T14:27:06Z | 8521969 | - | no | A021: mentions and push notifications |
| #292 | 2026-09-16T14:34:03Z | bc53ed8 | - | no | B017: skill/agent registry |
| #294 | 2026-09-16T14:34:15Z | 9bfcbbc | - | no | B019: agent reputation/staking |
| #293 | 2026-09-16T14:34:52Z | 4f69739 | - | no | [quill-s2] F012: quarterly storage-failure drills |
| #296 | 2026-09-16T14:38:54Z | 4dc3bd8 | - | no | [quill-s2] F011: cold-start optimization |
| #295 | 2026-09-16T14:39:58Z | d2e558b | - | no | A015: digest mode |
| #297 | 2026-09-16T14:43:08Z | b108264 | - | no | B012: agent onboarding checklist |
| #298 | 2026-09-16T14:46:20Z | ff2b5c4 | - | no | B013: cross-agent 1:1 DM rooms |
| #299 | 2026-09-16T14:47:02Z | 7c2eeb5 | - | no | [quill-s2] F013: moderation queue bulk actions |
| #300 | 2026-09-16T14:49:39Z | 6272dd9 | - | no | B016: per-identity rate limits |
| #301 | 2026-09-16T14:49:55Z | 8ffe8e6 | - | no | B018: task router |
| #302 | 2026-09-16T14:53:21Z | c62f23a | - | no | B020: outbound webhooks |
| #303 | 2026-09-16T14:57:06Z | dce41da | - | no | B021: Slack bridge |
| #304 | 2026-09-16T15:01:01Z | cbaf7ba | - | no | B022: Discord bridge |
| #305 | 2026-09-16T15:04:34Z | 49f787d | - | no | B023: semantic work search |
| #306 | 2026-09-16T15:08:10Z | 30c99ab | - | no | B024: signed agent claims |
| #307 | 2026-09-16T15:22:04Z | b886305 | - | no | B025: machine-readable activity feed |
| #308 | 2026-09-16T15:22:11Z | 8e8734b | - | no | B017: owner pause/resume (real task) |
| #309 | 2026-09-16T15:30:07Z | 6726901 | - | no | B019: agent sandbox (real task) |
| #310 | 2026-09-16T15:33:04Z | e6a763b | - | no | K001: work-item template gallery |
| #311 | 2026-09-16T15:35:44Z | b8d7037 | - | no | K009: polls inside rooms |
| #313 | 2026-09-16T15:38:48Z | 7089cc7 | - | no | K013: recurring rooms |
| #315 | 2026-09-16T15:40:19Z | 0c175a5 | - | no | G015: trend sparklines |
| #317 | 2026-09-16T15:43:17Z | 4477ab5 | - | no | Q001 flaky-test quarantine system |
| #316 | 2026-09-16T15:48:04Z | 1844372 | - | no | G016: cross-room benchmarks |
| #318 | 2026-09-16T15:50:09Z | 1a5284d | - | no | Q014 CI failure auto-bisect to the offending commit |
| #324 | 2026-09-16T15:50:26Z | d278536 | - | no | Q010 performance regression gates (p95 budgets per route) |
| #321 | 2026-09-16T15:51:50Z | 5df7ef9 | - | no | G012: scoped API tokens |
| #322 | 2026-09-16T15:51:53Z | f512c0a | - | no | K021: action-item extraction |
| #323 | 2026-09-16T15:51:57Z | 890d6b1 | - | no | K025: OKR tracker |
| #325 | 2026-09-16T15:52:00Z | da5e628 | - | no | K023: async standup collector |
| #326 | 2026-09-16T15:52:04Z | 90db7d3 | - | no | K020: reminder parsing |
| #327 | 2026-09-16T15:52:09Z | dafa7d4 | - | no | K018: room announcements |
| #328 | 2026-09-16T15:52:13Z | 46e2f95 | - | no | K027: file version history |
| #330 | 2026-09-16T15:52:18Z | af83a9a | - | no | K024: retrospective tracker |
| #334 | 2026-09-16T15:52:22Z | 8df5454 | - | no | K015: shared files |
| #332 | 2026-09-16T15:54:14Z | 08202ab | - | no | K019: notification preferences |
| #333 | 2026-09-16T15:54:55Z | 4f9cb8d | - | no | K017: shared whiteboard |
| #336 | 2026-09-16T15:55:36Z | 05d6df9 | - | no | K011: thread tree |
| #365 | 2026-09-16T16:26:41Z | fef4d91 | - | no | B024: harden tamper test against base64url padding-bit flake |
| #363 | 2026-09-16T16:27:07Z | 926ac59 | - | no | B011: secure default guest-token generation (crypto.randomBytes) |
| #364 | 2026-09-16T16:30:04Z | 3b33eb2 | - | no | B010: deterministic capability cards (inject publishedAt) |
| #346 | 2026-09-16T16:30:12Z | 1787767 | - | no | K026: work comments |
| #362 | 2026-09-16T16:30:18Z | f64b27c | - | no | O007: security model |
| #359 | 2026-09-16T16:30:25Z | a42bb1b | - | no | O001: user guide |
| #358 | 2026-09-16T16:30:32Z | 0edb89f | - | no | O002: admin guide |
| #361 | 2026-09-16T16:31:29Z | 1e3fe3e | - | no | O006: contributing guide |
| #343 | 2026-09-16T16:39:06Z | 94af994 | - | no | Q013: test factories |
| #349 | 2026-09-16T16:39:32Z | 8fb55a5 | - | no | O003: agent guide |
| #366 | 2026-09-16T16:47:21Z | 896344c | - | no | B015: remove wall-clock default from attribution ledger |
| #312 | 2026-09-16T17:01:21Z | 5fcdb48 | - | no | K012: room templates |
| #319 | 2026-09-16T17:01:25Z | 16adf7d | - | no | G019: event sampling |
| #320 | 2026-09-16T17:01:29Z | b3d99d5 | - | no | G020: analytics retention |
| #329 | 2026-09-16T17:01:32Z | 764b88b | - | no | K016: room markdown notes |
| #335 | 2026-09-16T17:02:23Z | f512ea2 | - | no | K014: Markdown export |
| #337 | 2026-09-16T17:02:30Z | db9cb16 | - | no | K028: global search |
| #338 | 2026-09-16T17:02:36Z | 019d215 | - | no | K029: saved searches |
| #339 | 2026-09-16T17:02:42Z | 7b9965a | - | no | K030: room analytics rollup |
| #340 | 2026-09-16T17:03:27Z | 81e281a | - | no | G010: custom dashboards |
| #341 | 2026-09-16T17:03:33Z | 4192754 | - | no | G004: health report |
| #342 | 2026-09-16T17:03:38Z | cf08df5 | - | no | G017: event schema docs |
| #344 | 2026-09-16T17:03:43Z | 37a3c40 | - | no | G018: backfill tool |
| #347 | 2026-09-16T17:03:49Z | 7028cbe | - | no | O010: FAQ |
| #348 | 2026-09-16T17:04:33Z | 8ce97a2 | - | no | W013: wiki export |
| #353 | 2026-09-16T17:04:38Z | 0d4ce37 | - | no | [quill-s2] A005 Microsoft Graph OAuth connection flow |
| #354 | 2026-09-16T17:04:44Z | 539272a | - | no | [quill-s2] A004 Gmail send approval gate |
| #355 | 2026-09-16T17:05:19Z | 3fa8fcc | - | no | [quill-s2] A006 Gmail OAuth connection flow |
| #357 | 2026-09-16T17:05:24Z | 00a1ac2 | - | no | O004: API ref generator |
| #287 | 2026-09-16T17:05:29Z | b426ba5 | - | no | K007: bounty dispute flow |
| #314 | 2026-09-16T17:10:18Z | b21b91f | - | no | G011: analytics CSV export |
| #350 | 2026-09-16T17:10:35Z | c714152 | - | no | W010: stale detector |
| #331 | 2026-09-16T17:14:55Z | 913e6ac | - | no | K022: notes to work items |
| #351 | 2026-09-16T17:22:17Z | e5c3669 | - | no | W005: recurrence detector |
| #367 | 2026-09-16T18:16:09Z | 59b9cbb | - | no | [quill-s2] Wave 1 (Rowboat port): room protocol keystone + examples + lane registry |
| #368 | 2026-09-16T18:28:38Z | 7ff8613 | RC-2026-09-16-004 | no | [quill-s2] Wave 2 (Rowboat port): machine board + typed room CLI + decay-enforcer watcher doc |

## Receipts posted (0)

(none)

## Lease expirations & reclaims (0)

(none)

## Duplicate-claim refusals (0)

(none)

## Missing receipts — past the 24h SLO (0)

(none)

## Board pressure

board_comments=269 threshold=1500 rotation_due=

## Open claims now (live)

```
RC-2026-09-16-004 | quill-s2 | submitted | 2026-09-17T18:17:54Z | ROOM-STATE.md, scripts/room, docs/ROOM-WATCH.md
RC-2026-09-16-005 | quill-s2 | submitted | 2026-09-17T18:29:38Z | docs/ROOM-ACTION-POLICY.md, scripts/room-digest, ROOM-HEALTH.md, docs/SWARM-PLUG-IN.md, docs/ROOM-WATCH.md
```

## For John's call

- swarm-room-watch is PAUSED since 2026-09-14: decay enforcement (lease sweeps, missing-receipt nudges) is not running. Re-enable is John's call.
- Nothing else needs John's call this week.

<!-- trend: week=2026-09-16 opened=2 completed=0 expired=0 receipts=0 missing=0 refusals=0 comments=269 -->

---

## Trend lines

Week-over-week, newest last. Each weekly run appends exactly one row (see
Appendix A); the machine-readable source is the `<!-- trend: ... -->`
comment at the foot of each generated digest.

| week ending | opened | completed | expired | receipts | missing (SLO) | refusals | board comments | rotation due |
|---|---|---|---|---|---|---|---|---|
| 2026-09-16 | 2 | 0 | 0 | 0 | 0 | 0 | 269 | no |

Reading the first row: the board is one day old, so this is a baseline,
not a trend. 96 PRs merged in the window (the 100-task program waves) with
2 live claims open, 0 receipts posted via the room protocol (receipts went
out as plain `[quill-s2][receipt]` prose, which the machine plane does not
parse), 0 expirations, 0 refusals, and the board at 269/1500 comments.

## Appendix A — weekly digest cron spec (PROPOSED — not enabled)

This spec is **proposed only**. Nothing has been created or enabled. The
`swarm-room-watch` cron has been **PAUSED since 2026-09-14**
(`enabled: false`, per John's direction, and Wave 2 left it paused);
re-enabling it — and enabling this digest job — is **John's call**.

The digest job is the human plane to the watcher's machine plane: it
reads, it never posts, so it is safe to run while the watcher is paused.

```yaml
---
id: swarm-room-digest
title: Swarm room digest
enabled: false   # PROPOSED — enabling is John's call
owner: goal:agent-swarm-coordination
mode: task
schedule:
  kind: interval
  timezone: America/Los_Angeles
  every: 168h
---
```

Body (follows the `swarm-room-watch` convention — `interval@30m` — at a
weekly cadence, `interval@168h`):

1. Fresh clone of `Uuriko/project-room@main` into a temp dir per run (never
   a stale worktree). No commits to `main`, ever.
2. Read the window watermark:
   `~/workspace/goals/agent-swarm-coordination/hidden_files/room-digest-watermark.txt`
   — the ISO timestamp of the last window end (default: 7 days back on the
   first run).
3. Run, read-only:
   `scripts/room-digest --since <watermark> --out $RUN_DIR/room-digest-<date>.md`
   The script never posts to the board; findings are content, not failure.
4. Update the watermark atomically (write temp file, then rename) to the
   new window end. State lives with the scheduler, never in the repo
   (config/state split, `docs/ROOM-WATCH.md` §6).
5. Report: the full digest markdown is the brief for John (chat report),
   plus the `<!-- trend: ... -->` machine line for the trend table.
   Nothing is posted to the board.
6. Repo bookkeeping (by the runner, via a normal PR — repo discipline
   applies): replace this file's "Latest digest" section with the new
   digest and append the trend row to the table above.

Failure handling (same as the watcher, `docs/ROOM-WATCH.md` §5): on
repeated failure of a verb, post nothing new and do not retry blindly —
surface the verb, the error, and the last good watermark in the digest
instead. If `gh` rate-limits: stop; the next weekly run replays from the
watermark.

## Appendix B — running the digest by hand

```sh
git clone --depth 1 https://github.com/Uuriko/project-room.git /tmp/room-digest-run
cd /tmp/room-digest-run
./scripts/room-digest --dry-run                 # inspect, write nothing
./scripts/room-digest --out /tmp/digest.md      # default window: last 7 days
./scripts/room-digest --since 2026-09-09T00:00:00Z --out /tmp/digest.md
```

Flags: `--since ISO` (window start), `--out PATH` (atomic write),
`--dry-run` (plan to stdout, write nothing). Globals: `--repo`, `--issue`,
`--help`. The digest composes `scripts/room` verbs — `metrics --since`,
`receipts-scan`, `rotation-check`, `query --live` — plus event detail
through `room _parse`/`_state`; it reimplements no board parsing.
