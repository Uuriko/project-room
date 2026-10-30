# DEPLOY-WATCH — post-landing production flip watch (bounded, 4 checks)

Lane: DEPLOY-WATCH · Wave: wave-2026-10-29-merge-execute
Watch start: 2026-10-30T05:59:44Z
Spend: ~0.6 lane-hours · Status: FILED — NO FLIP (all 19 landed, undeployed)

## Ground truth verified at watch start

- Main head at the GitHub API (`gh api repos/Uuriko/project-room/commits/main`):
  `a3ded057b08dcaa51f0eae5d1563b14848dadd8c` — "Merge pull request #5328",
  committer date 2026-10-30T05:58:11Z. Matches the charter head; main had
  NOT moved further at watch start.
- Production base URL: `https://room.trydemigod.com` — taken from
  `~/workspace/fleet-tools/README-door-monitor.md` (door-monitor tooling,
  app door), NOT from memory. Verified resolving: `GET /api/version`
  returned HTTP 200. The entry door `https://www.getdasha.com/room`
  returned the identical version payload on the same check.
- Production at wave start (per BOARD.md / STATE.md):
  sourceRevision `4b2d798dceb68359ae2697e5daf5c7561a056c3e`,
  buildId `2026-10-30T01:52:48.261Z`.

## The 19 merge commits that must ALL be ancestors of the deployed build

| # | Merge commit | PR |
|---|---|---|
| 1 | 1b27a934 | #5376 |
| 2 | 508b0edc | #5355 |
| 3 | adf177f8 | #4543 |
| 4 | 5a61fb4b | #5377 |
| 5 | 11eae6f2 | #5324 |
| 6 | eb54accf | #5337 |
| 7 | eff3d0fb | #4265 |
| 8 | 7cdf17b4 | #5333 |
| 9 | e808a0ba | #5325 |
| 10 | 6f0c4eb0 | #5336 |
| 11 | 0e2bd934 | #5343 |
| 12 | cc9c9417 | #5353 |
| 13 | cadcbce4 | #5323 |
| 14 | 450e669b | #5071 |
| 15 | d831914b | #5061 |
| 16 | eaf17c6b | #5354 |
| 17 | b9918d98 | #5330 |
| 18 | 777e3a4a | #5338 |
| 19 | a3ded057 | #5328 |

(Prefixes as supplied in the charter; full SHAs resolvable at the API.
Ancestry test at a flip: GitHub compare `deployed...<merge>` /
`<merge>...deployed` — a merge commit counts deployed only if it is an
ancestor of the deployed sourceRevision.)

## Version checks

### Check 1 — 2026-10-30T05:59:44Z (watch start)

`GET https://room.trydemigod.com/api/version` → HTTP 200, 3.32 s

```json
{"status":"ok","mode":"cloudflare-production","sourceRevision":"dfe1848a2cc3c1791e2e524ac402a45d48580d60","buildId":"2026-10-30T04:01:35.869Z","deployment":"production","storage":{"valueLimitBytes":8388642}}
```

Entry door (`https://www.getdasha.com/room/api/version`) returned the
identical payload.

Reading:
- Production HAS moved since wave start, but NOT to this wave's head.
  Current deployed commit `dfe1848a2cc3c1791e2e524ac402a45d48580d60` is
  (per GitHub API) "Merge pull request #5400 from
  Uuriko/codex/acp-release-1030", committer date 2026-10-30T03:47:13Z,
  parents `4b2d798d…` (the wave-start production commit) +
  `143813f5…`. It is a Codex release deploy, buildId 04:01:35Z.
- GitHub compare `dfe1848a…...a3ded057…`: status `ahead`,
  ahead_by 83, behind_by 0 — i.e. main head a3ded057 is 83 commits
  AHEAD of the deployed build. The deployed build is an ancestor-side
  predecessor, NOT at-or-past a3ded057.
- Verdict for check 1: NO FLIP to the wave head. None of the 19 merge
  commits can be called deployed on this build (they postdate the
  #5400 merge base; formal per-commit ancestry is run only at a flip
  to at-or-past a3ded057, per charter).

### Check 2 — 2026-10-30T06:09:45Z

`GET https://room.trydemigod.com/api/version` → HTTP 200

```json
{"status":"ok","mode":"cloudflare-production","sourceRevision":"dfe1848a2cc3c1791e2e524ac402a45d48580d60","buildId":"2026-10-30T04:01:35.869Z","deployment":"production","storage":{"valueLimitBytes":8388642}}
```

Identical to check 1. NO FLIP.

### Pre-flip baselines captured during the watch (2026-10-30T06:02:54Z, deployed build dfe1848a)

These pin the "before" state so a post-flip run is a diff, not a guess:

- Receipt titles (mint-free public read, `GET /api/public/receipts?limit=50`,
  33 receipts, nextCursor null):
  - `pwr_e7ecdab3…fe7a`: title length exactly **80** —
    `'FS-13 DRILL T2 — Dispute-outcome census of the disputes machine (drill, dispute '`
    (truncated mid-word, trailing space — E3-F1 defect LIVE on current prod).
  - `pwr_d49dc287…d353`, `pwr_5f7e32b3…16ab`, `pwr_e6fba2f4…6052`:
    title = **`Public work`** (11 chars) for all three — E3-F2 defect LIVE.
- Presence (no auth): `GET /api/rooms/utm-x2-presence-r1/presence` →
  error `unauthenticated` / "No credential." The endpoint requires a
  member identity; its hint suggests self-minting, which this lane
  must NOT do. Presence post-landing check is therefore
  **not-runnable-here without an existing member credential** for that
  room (the X2 lane's saved 0600 credentials are that lane's; using
  them is the lab/LOOP battery's run, not this watch's).

### Check 3 — 2026-10-30T06:18:27Z

`GET https://room.trydemigod.com/api/version` → HTTP 200, payload
identical to checks 1–2: sourceRevision
`dfe1848a2cc3c1791e2e524ac402a45d48580d60`, buildId
`2026-10-30T04:01:35.869Z`. NO FLIP.

### Check 4 — 2026-10-30T06:26:44Z (final check)

`GET https://room.trydemigod.com/api/version` → HTTP 200, 0.96 s,
payload identical to checks 1–3: sourceRevision
`dfe1848a2cc3c1791e2e524ac402a45d48580d60`, buildId
`2026-10-30T04:01:35.869Z`. NO FLIP.

Main-head recheck in the same run: main MOVED during the watch to
`2249dbb5da5e6f26f2f221fb54466abdda9ab37f` — per the GitHub API,
"Merge pull request #4930" (integrity cure), committer date
2026-10-30T06:07:41Z. Compare `a3ded057…...2249dbb5…`: status
`ahead`, ahead_by 10, behind_by 0 — the new main descends from
a3ded057, so all 19 wave merges remain ancestors of current main.
Production deploys neither head.

(Timestamp note: checks 2–3 were first written up from notification
times and are corrected here to the `date` output printed inside
each check command itself — 06:09:45Z and 06:18:27Z. Intervals
between the four checks: ~10 min, ~9 min, ~8 min.)

## Full merge SHAs (resolved at the GitHub API during the watch)

```
1b27a934833319cf0c7f8fe983e6f058390d0ce8  #5376
508b0edcdd9b9a83a72368811a12f69ecca9b521  #5355
adf177f81fd21347a632eb418c127284d2922ee4  #4543
5a61fb4b5aa9afa7b663ad6dbc14a6064bf91e7e  #5377
11eae6f25eacf685d8f7f64e64fdf61f11114e71  #5324
eb54accfc9605b4aa6fc9854e6f3e37509634527  #5337
eff3d0fb096d713d9264f4474a395ccc07ecac93  #4265
7cdf17b4142a81ad82f25bdbd86cb82031a9e800  #5333
e808a0ba40a6e8f1dc615f2e4323df734b4c0cef  #5325
6f0c4eb029ce934b134fb07c6af32fa5444e2ef5  #5336
0e2bd9342547f523e5e0347ed81dc4d6ab0f0f37  #5343
cc9c941751a148b0d76b3d7defa57ff13c3b9362  #5353
cadcbce4486fc03ceb76ed11ba09d5dae0d6facd  #5323
450e669b2e1f48496ec0bbf17628939946a1e0cf  #5071
d831914b1f51d9dc6d1cd94ae97ef881c88117da  #5061
eaf17c6bde8b6facf6a1ae3f047016c5d1da2505  #5354
b9918d981bc8b7f39a268a02d4d2146b1e7fef7d  #5330
777e3a4a427610fd4417257bba7f6823bf5ca722  #5338
a3ded057b08dcaa51f0eae5d1563b14848dadd8c  #5328 (= main head at watch start)
```

Ancestry procedure at a flip (for whoever runs it): for the deployed
sourceRevision D, `GET /repos/Uuriko/project-room/compare/{merge}...{D}`
must report the merge as ancestor (status `ahead`/`identical` from the
merge's perspective, behind_by 0 in `compare {D}...{merge}` terms —
equivalently one compare call `compare {mergeFullSha}...{D}` with
`behind_by: 0`). All 19 must pass before any is called deployed. If D
equals or descends from a3ded057, all 19 pass by construction, but the
per-commit API verification is still the evidence of record.

## Post-landing checklist (ready to run at a flip; status per item)

### (a) Presence — #5338 (REGISTER-FIX B)
- Defined check: `GET /api/rooms/{room}/presence` shape / members
  endpoint on a known room; baseline defect = presence `null` on
  40/40 member rows (X2 room `utm-x2-presence-r1`, wave-2026-10-29-lab
  P1A / BENCHMARKS.md).
- Runnable-here test and result: RAN the no-auth form at
  2026-10-30T06:02:54Z — `GET /api/rooms/utm-x2-presence-r1/presence`
  returned error `unauthenticated` ("No credential"). The members /
  presence shape is NOT reachable without a member identity, and this
  lane mints none. Status: **not-runnable-here** — owed to a runner
  holding an existing member credential for a known room (e.g. the
  lab X2 lane's saved credentials, or Jill's own seated identity).
  Exact pass shape at a flip: presence rows non-null for members,
  against the 40/40-null baseline.

### (b) Receipt titles — #5377 (E3-F1 / E3-F2, register rows 124/125)
Mint-free, public, fully specified specimens (from
`~/workspace/wave-2026-10-29-lab/lanes/E3-REPORT.md`):
- Long title (84 chars, truncated at exactly 80 pre-fix):
  task `fs13-drill-t2-mvd6sfci`, receipt
  `pwr_e7ecdab339d7ece65f2034474937eab17038cf597928a16f5cb53c635cf5fe7a`,
  full title "FS-13 DRILL T2 — Dispute-outcome census of the disputes
  machine (drill, dispute leg)".
  Pass = `GET /receipts/{id}` and `GET /api/public/receipts` show the
  full 84-char title, no 80-char mid-word cut.
- Null title (rendered as fabricated "Public work" pre-fix):
  receipts `pwr_d49dc287390763c5f50750f04244ee122bba0ae652e297f8cfc68b2600b4d353`,
  `pwr_5f7e32b37d9353a4903d0bd3719c81033191fde6acb841e6f5823ea1b1a516ab`,
  `pwr_e6fba2f4879b42d8588e6651c28c6205b8c3ddbeddd915c1ddd4998ef40a6052`
  (tasks `seed-dc-chain-verifier-20260930`,
  `seed-dc-directory-map-20260930`, `seed-dc-public-openapi-20260930`).
  Pass = no receipt face renders the literal title "Public work";
  expected post-fix = the task title, or "Untitled receipt" where no
  task title is reachable (per E3-FIX.md).

### (c) OWED — require identities / rooms / operator token; NOT run here, no mints
- Privacy legs — #5355 (and superseded #5346 family): OWED.
  Precondition: the privacy wave's own member identities and test
  rooms (private-request disclosure/write specimens) — retest must use
  those existing identities; minting new identities is forbidden in
  this lane (mint pool constrained).
- Decider read — #5071: OWED for the in-room leg. Precondition: a room
  with a disputed bounty and the decider / worker / sponsor identities
  from the dispute wave, read as the decider
  (`GET …/bounties/{id}/dispute`). Note the mint-free public half
  exists and is specified in lab P1A §H5 (API face
  `GET /api/public-work/tasks` disputeDecider non-null rate + human
  face `GET /receipts/{receiptId}` decider occurrence; specimen
  `pwr_18eb8146c566bc17f072fc788f6830f4a7a1b6e0a6dc8be445522840e388a36b`,
  baseline API 16/16 non-null, human face 0 occurrences) — that half
  is runnable at a flip without identities.
- LOOP H1 retest — #5353: OWED. Precondition: the LOOP wave's hero /
  stranger-door session shape (unauthenticated entry-door walk);
  retest grades the single "Join a room" anchor behaviour the PR
  changed, in the LOOP harness, not ad hoc.
- LOOP H5 retest — #5354: OWED. Precondition: the H4→dispute cast
  (sponsor / worker / verifier-as-decider D identities and a room
  running claim→submit→accept→dispute) from the LOOP/lab waves;
  grades `GET …/bounties/{id}/dispute` as D plus needs-me for W and D.
  No mints in this lane.

## Flip / no-flip conclusion — NO FLIP within the watch

Filed at watch close, 2026-10-30T06:35Z approx.

- 4/4 version checks (05:59:44Z, 06:09:45Z, 06:18:27Z, 06:26:44Z)
  observed the SAME production build: sourceRevision
  `dfe1848a2cc3c1791e2e524ac402a45d48580d60` (#5400 Codex release
  merge on the wave-start base), buildId `2026-10-30T04:01:35.869Z`.
- **All 19 wave merges are LANDED on main and UNDEPLOYED.** None may
  be called deployed. Production is 83 commits behind a3ded057, and
  further behind current main `2249dbb5…` (#4930 landed during the
  watch, 06:07:41Z).
- Post-landing production checks were therefore NOT executed as
  post-landing checks. What this watch did establish:
  - (b) Receipt titles: pre-flip baseline captured mint-free at
    06:02:54Z — both defects LIVE on the current build (80-char
    truncation; "Public work" ×3). The check is fully specified
    above with full receipt IDs and is runnable by anyone, mint-free,
    the moment a flip lands.
  - (a) Presence: not-runnable-here without an existing member
    credential (endpoint answers `unauthenticated`); exact
    precondition recorded above.
  - (c) Privacy legs (#5355), decider-read in-room leg (#5071),
    LOOP H1 (#5353) and LOOP H5 (#5354) retests: OWED, each with its
    exact precondition recorded above; nothing minted, nothing
    forced.
- Ready for whoever runs the flip: (1) confirm
  `GET /api/version` sourceRevision is at-or-past a3ded057;
  (2) ancestry-verify all 19 full SHAs (listed above) against the
  deployed commit via the GitHub compare API; (3) run (b) against
  the pre-flip baseline in this file; (4) hand (a) and the (c) legs
  to the identity-holding waves.

## Claim block

- claim: file DEPLOY-WATCH.md exists in wave dir wave-2026-10-29-merge-execute
- claim: production sourceRevision dfe1848a2cc3c1791e2e524ac402a45d48580d60 observed on 4 checks
- claim: 19 PRs landed on main, 0 deployed at watch close

## Spend

~0.6 lane-hours (bounded watch elapsed 05:59–06:35Z, mostly the
chartered ~10-minute intervals; active work = API verification,
baseline probes, this file). Scratch `~/workspace/deploywatch-scratch`
deleted at filing.
