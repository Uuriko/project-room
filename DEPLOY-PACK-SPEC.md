# DEPLOY-PACK SPEC

For John's Tab (muse-room member `ai_adTD17Gg80FzEUaf`), from Jill's fleet.
Discharges his standing ask at muse-room seqs 22544/22545 (deploy-pack spec on a
readable branch), accepted by Jill at seq 22669.

Branch: `jill/deploy-pack-spec-1029` · File: `DEPLOY-PACK-SPEC.md` (branch root).

## 0. Roles (the split this spec serves)

- **Codex is sole production writer** — he dispatches deploys.
- **John's Tab verifies deploys** — the post-deploy pack is his, under his
  Step 0 ownership (his commitment at muse-room seq 20686; his 11 steps at
  seq 21671). The fleet never runs his smoke and never posts a verdict in
  his name.
- **Jill's fleet supplies evidence legs on ask** (version / ancestor / ready
  reads, packet builds, the API battery) and runs post-landing affected
  checks.

Two artefacts are called a "pack". This spec covers both and how they join:

| Artefact | When | Produced by | Consumed by |
|---|---|---|---|
| **Deploy packet** (`deploy-packet.mjs` output) | Before a flip, against a named candidate SHA | Jill's fleet tool `fleet-tools/deploy-packet.mjs` v1.1 | The dispatching seat (Codex); Tab reads its smoke plan + rollback pair |
| **Post-deploy pack** (one prose result post) | After a flip | John's Tab | The room (the deploy's verification of record) |

## 1. The deploy packet — contents

Built by `deploy-packet.mjs` from the candidate tree itself (it reads
`.github/workflows/deploy-prod.yml`, `.github/workflows/rollback-prod.yml`,
and `docs/DEPLOY-LANE.md` at the candidate SHA via `git show`; nothing is
invented). One packet is a markdown file plus a JSON twin with identical
content. Fields:

- `packetType: "DEPLOY_PACKET"`, `packetVersion`, `status:
  "DRAFT-NOT-DISPATCHED"` — a packet never dispatches anything.
- `preparedAt`, `preparedBy`, `targetSha` (the candidate, full 40-hex),
  `mainTipAtPacket` (so a stale packet is recognisable).
- `carriedPRs` + `carriedDerivation` — the PRs the candidate carries over
  current production, with how the list was derived (`--prs`,
  `--prs-file`, or `--derive-carried-from <prevSha>`).
- `buildArtifacts`:
  - workflow file / name / concurrency group for `deploy-prod.yml`;
  - jobs as parsed at the candidate (names, `needs`, timeouts — at recent
    trees: gate / probe / deploy / release-runtime at 10 / 30 / 40 / 15 min);
  - both wrangler deploy commands and the pre-deploy artifact names;
  - the two Workers: `project-room` (canonical, app door
    `https://room.trydemigod.com`) and `project-room-staging` (public entry
    Worker, entry door `https://www.getdasha.com/room` — a live entry door,
    not a staging environment);
  - pre-deploy snapshot: the deploy job runs `scripts/deploy-recovery.mjs
    snapshot` before upload; artifact `pre-deploy-<sha>` (pre-deploy version
    ids, observed source revisions, code schemas) is retained 90 days and is
    the rollback pair's version-id source;
  - `releaseRuntime`: on gate+deploy success, packages the deployed runtime
    and publishes the Node runtime release;
  - `receiptFormat`: the receipt formats from `DEPLOY-LANE.md` at the
    candidate tree.
- `deployRecordDraft`: the INTENT deploy-record draft plus
  `intentValidation` (`{ok, problems}` — the packet only surfaces when
  validation passes). The record is **not** appended to
  `fleet-tools/state/deploy-records.jsonl` until the seat actually
  dispatches; at dispatch the seat fills every EMPTY field and appends via
  `deploy-record.mjs` (validation refuses omitted fields).
  - **E3 provenance slots are EMPTY / UNSIGNED by design.** Scheme: ed25519,
    payload `<buildId>|<sourceRevision>|<actor>|<at>`. Arming is John's
    key-custody gate: no key is generated, held, or used by the tool, and
    the agent-card key must never be reused for this. Before arming, a
    present-but-unsigned record verifies as UNSIGNED, never OK-SIGNED.
  - Pre-act rule: before any dispatch, the dispatcher records a pre-act
    journal entry (`fleet-tools/state/pre-act-journal.jsonl` via
    `pre-act-journal.mjs`) naming the act and this deployId.
- `smokePlan`: the verification plan of §3 below, with the previous
  production pair and the ancestor floor filled in.
- `rollback`: previous production `(sourceRevision, buildId)` per door;
  `rollback-prod.yml` as parsed (single job, 20 min at recent trees);
  required inputs at rollback time — `prod_version_id` (REQUIRED, from the
  deploy run's `pre-deploy-<sha>` artifact or `wrangler versions list`),
  `entry_version_id` (optional), `reason` (REQUIRED), and a committed JSON
  receipt covering the exact current/target pair (per
  `scripts/manual-rollback.mjs`).
  - **Version-id honesty:** fleet state (`deploy-watch-state.json`) carries
    only `(sourceRevision, buildId)` per door — Cloudflare version ids are
    NOT in fleet state, so the packet's rollback pair is
    `(sourceRevision, buildId)` plus the version ids in the dispatching
    run's pre-deploy artifact. A packet never invents version ids.
  - In-deploy recovery: `deploy-prod` itself recovers on smoke failure via
    `scripts/deploy-recovery.mjs recover`, only to a prior Worker whose
    recorded schema meets the candidate floor with an identical writer-fence
    blob; otherwise it reports ROLL FORWARD REQUIRED. Schema migrations are
    forward-only: a code rollback does not undo one.
  - A rollback is a deploy: it gets its own DEPLOY_RECORD chain (new
    deployId, terminal phase `ROLLED-BACK`, mandatory field set enforced by
    `deploy-record.mjs`).

## 2. Producing a packet

```
node ~/workspace/fleet-tools/deploy-packet.mjs --sha <full 40-hex> \
  (--prs-file <json> | --prs 5273,5274,5275 | --derive-carried-from <prevSha>) \
  [--repo-dir <path>] [--deploy-watch-state <path>] \
  [--created-at <iso>] [--out <packet.md>] [--json-out <packet.json>]
```

- `--repo-dir` must contain the candidate object. The shared clone
  (`~/workspace/project-room`) is stale (2026-10-18) and will not; use a
  current checkout or a prepared store at the candidate SHA.
- **Stdout route (proven):** with no `--out`, the packet markdown goes to
  stdout and a status line to stderr:
  `{"state":"PACKET-BUILT","status":"DRAFT-NOT-DISPATCHED","targetSha":…,
  "deployId":"dep-<yyyymmdd>-<sha8>-DRAFT","carriedPRs":N,
  "intentValidation":"PASS","outputs":[]}`. `--emit json` for the JSON twin.
- **Episode rule for `--out`:** this VM has a recurring EPERM write-fault
  episode (a subtree latch: after git/python/fetch executes in a process
  subtree, later writes in that subtree are refused). Proven behaviour
  (MERGE-DEPLOY-READY lane R3-A, 2026-10-29): during an episode, `--out`
  exits 2 with `ERROR WRITE: atomic write … EPERM` **after** the packet has
  built and passed intent validation — the failure is the file write, not
  the packet. In a write-probe CLEAR window the same tool version writes
  both files in-process (post-episode discharge, item 5). Standing rule:
  1. Check freshness first — `episode-mode.mjs status` verdicts go stale
     after 15 minutes and then read UNKNOWN; re-run `write-probe.mjs` if
     the verdict is older than that.
  2. In an episode (or UNKNOWN), build via **stdout**, capture the bytes,
     and file them through a clean write path; verify the filed files by
     hash against a second fresh build (timestamps normalised).
  3. Never treat an `--out` EPERM as a packet defect.
- Worked example (2026-10-29, candidate `63534b92`, carried #5273/#5274/
  #5275): `packet-main.md` 12,449 B sha256
  `28070f3d57c11d84a4b6a5615c7e3921b208181e5e264b16f1bc433b951d3915`;
  `packet-main.json` 16,042 B sha256
  `6af3934dae1f5f3b6f1a1f6437b9e9375443b3f87f114be0667c2e62bbdf7ec1`;
  intentValidation PASS; priorBuild derived from deploy-watch state as
  production `6bda3388` / buildId `2026-10-29T16:43:38.679Z`.
- The deploy-record store is checked, never written, by packet work:
  `node ~/workspace/fleet-tools/deploy-record.mjs validate-store` → PASS
  (at last check: 35 lines = 1 STORE_META + 34 DEPLOY_RECORD, 0 defective).

## 3. Verification inputs — what must be staged per flip

The packet's `smokePlan` and Tab's run both consume the same inputs. A
staging sheet per flip names:

| Input | Rule |
|---|---|
| Candidate / deployed revision (full SHA) | Named by the landing seat's announcement or read from the doors after the flip. A pack always names the **deployed** rev, never a pre-staged candidate — if main moved before the flip, re-derive against the deployed rev. |
| Current production pair | `(sourceRevision, buildId)` from `GET /api/version` on **both** doors — app `https://room.trydemigod.com/api/version`, entry `https://www.getdasha.com/room/api/version`. Multiple agreeing reads. |
| Expected post-flip pair | The candidate sourceRevision on both doors; the new buildId is knowable only at flip — never pre-filled. |
| Previous verified prod rev | The ancestor leg: deployed rev must descend from it (compare API `status: ahead`, or `git merge-base --is-ancestor <prev> <new>` exit 0). |
| Ancestor floor | `93b14a3c6686408595a2e651a8ab8a23717044f0` — the same ancestor check runs against the floor. |
| Carried PR list | Compare `<prevProd>...<deployed>`: status, ahead/behind counts, commits grouped by PR (merge commits at the tip + each PR's own commits). This is the pack's "new since previous prod" line. |
| CI state at the deployed rev | Read at flip time, never staged. |
| Ready baseline | The previous build's recorded `/api/ready` behaviour (see §5, step 3 — regression is judged against the baseline's fraction, not against perfection). |

## 4. The 11 steps (John's Tab's, verbatim names — seq 21671)

Harness: `work/pr/upd/smoke.mjs` (his seat-local path; not in the repo),
headless Chromium, signed-in harness account, against prod. Each step =
screen, action, pass condition. Any failing step gets a screenshot plus its
error text. Report form: `Smoke <n>/11` — the denominator is always 11;
known-open flags **N1** and **U2** are reported alongside, never deducted.

| # | Step | Action / pass condition | Per-step input |
|---|---|---|---|
| 1 | open-room | Load `/?room=<harness room>`; pass = signed in (`#main` visible, no password field), shell shows "Connected", one Updates and one Catch up button | Prod base URL + harness room id + harness account session — **room id and account are seat-held, in no fleet record; Tab supplies at run time** |
| 2 | updates-dialog | Open Updates, click each filter (needs, mentions, all, saved); pass = dialog opens, every `/updates` call < 400. Flag U1 (P2) if the Catch up pill counts needs-you but Needs me shows 0 rows | Step 1 session |
| 3 | catchup-dialog | Open Catch up (via Updates if not in top bar); pass = dialog opens with a "Mark caught up" / "Already caught up" button. Flag P3 if Needs-you rows differ from pill count | Step 1 session |
| 4 | project-dialog | Settings → Project; pass = dialog opens, clicking first item focuses its work card and its Details expand. Flag P3 if dialog label differs from card status | A project/work card present in the harness room (seat-held state) |
| 5 | participants | Open People; pass = active member rows equal the "N members" label, member options open, Refresh availability presence calls all < 400 | Step 1 session |
| 6 | atroom-no-assistant | **Only in scratch room `qa-johnstab-n1-smoke`**: send "@Room smoke N1 probe <ts>"; pass = a no-assistant hint shows or the POST answers 409. A plain post with no hint = N1 open (P2) | Scratch room name + a fresh `<ts>` at run time |
| 7 | connect-dialog | Settings → assistant setup; pass = setup dialog opens with provider options | Step 1 session |
| 8 | room-overview | Open Overview; pass = dialog opens reading "Overview" | Step 1 session |
| 9 | more-menu | Open the More menu; pass = it lists Settings, and Activity (if present) opens exactly one dialog | Step 1 session |
| 10 | inbox-removed | Pass = `#nav-inbox` absent (since #4260) | The loaded room page |
| 11 | rooms-nav | Close all dialogs; pass = room view shows "Connected" and "# general" | Step 1 session |

## 5. The verification sequence around the smoke (packet `smokePlan`)

Trigger: the landing seat's deploy announcement, or door-monitor
BUILD-MOVED, whichever first.

0. **Step 0 procedure** — Tab's own (§4). Fleet supplies evidence legs on
   ask only.
1. **Version agreement** — `GET /api/version` on both doors, twice; all
   reads must agree on `(buildId, sourceRevision)` per door and across
   doors. Persistent disagreement = doors split → verdict REFUSED, stop.
2. **Ancestor + floor + inclusion** — deployed rev descends from previous
   live rev (compare `status: ahead` or `merge-base --is-ancestor` exit 0);
   same check against the floor `93b14a3c…`. Inclusion sub-check: if the
   landing seat still asserts the #5131 gate (room seq 20780), the deployed
   rev must also descend from #5131's announced landing head (detail line,
   not a verdict field).
3. **Ready, flap-sampled** — `GET /api/ready` per door at t≈0, +5 min,
   +10 min; report the worse door's n/3 with any 503 body. A build is
   REGRESSED on ready only if its fraction is worse than the previous
   build's recorded behaviour.
4. **11-step screen smoke** — §4, Tab only. `smoke=<passed>/11`; each
   failing step gets a detail line (step + screen + observed) plus
   screenshot/error text.
5. **No-identity API battery + diff (fleet complement)** — door-verify v1.1,
   canonical routes from `docs/openapi.yaml` at the deployed tree:
   `node ~/workspace/fleet-tools/door-verify.mjs --target <buildId-or-rev-prefix> --out ~/workspace/fleet-tools/state/door-verify-runs/<buildId8>-<run-iso>.json`,
   then `--diff <previous-baseline-run.json> <new-run.json>`. One runner
   only, named in the result detail.
6. **In-workflow smoke (already run by deploy-prod)** — the deploy job's own
   smoke step at the deployed tree; cited, not re-run.
7. **Shelf checks** (DEPLOY-LANE.md) — before the deploy is called done:
   Board claimableCount > 0 and newest public receipt < 7 days old.
8. **One result line** — posted within 4 h of detection (first move: in
   reply to muse-room seq 20686; later moves: under the seat's deploy
   announcement), in the format of §6.

Fallbacks: 4 h with no result line → Jill re-asks Tab once via
`room_request_reply` naming the flip. 8 h → Jill's fleet runs the API
battery + diff itself and posts a line marked `smoke=UNVERIFIED-seat-idle`;
Fo is asked for browser evidence on named failures. Build reverts mid-run →
finish the reads against what is live, post with `verdict=TRANSIENT` naming
both observed pairs. Any 429 anywhere → STOP; the run's only report is
RATE-LIMITED; re-run once after the hour turns. Re-baselining
(`door-verify-baseline.json`) happens only **after** the verdict line is
posted; an ALERT build still becomes the baseline, its failures carried by
name as STILL-BROKEN.

## 6. How Tab consumes a pack per flip — the posted result

One prose result post (plus detail paragraphs on failures), in this order:

1. **Header** — deployed rev (full) + build timestamp + `= main #<head PR>`.
2. **Forward move** — yes/no, with the ancestor pair named (prev rev, floor).
3. **New since previous prod** — the carried PR list (§3).
4. **Ready** — 3 samples ~5 s apart in his posted packs, reported `n/3 200`
   with time and any 503 body. (The packet plan's flap-sampling in §5.3 is
   the fleet complement; his posted fraction is the one of record.)
5. **Smoke** — `n/11` + known-open flags (§4).
6. **Battery** — `work/pr/deploy-verify/verify.py` (seat-local; only its
   posted aggregates are in the record) diffed against the previous prod
   run: verify.py live pass/fail, repo prod-deploy-smoke failures, pr-test
   pass/fail, checklist pass/fail + manual count, and the browser-script
   class aggregates — each with its "was" numbers from the previous pack.
7. **CI at the deployed rev** — state at the rev, read at flip time.
8. **Verdict line** — "No P0/P1", or named failures with detail paragraphs.
   The machine-readable result line format (from the packet's smoke plan):
   `POST-DEPLOY-VERIFY build=<buildId> rev=<rev8> prev=<prevRev8> ancestor=OK|FAIL|UNKNOWN doors=agree|split ready=<n>/<3> smoke=<n>/11 battery=<n>/<total> diff=FIXED:<n>,STILL-BROKEN:<n>,REGRESSED:<n> verdict=VERIFIED|ALERT|REFUSED|TRANSIENT`
9. **Corrections** — when a first read is wrong, a **second post**
   referencing the first (worked example: seq 22640 correcting seq 22589).
   A posted pack is never edited.

## 7. Named gaps (stated, not papered over)

- **Harness room id (step 1), the harness account, verify.py's internal
  check list, and the checklist's item list are seat-held.** They appear in
  no fleet record; this spec names them as Tab-supplied at run time and
  cannot stage them.
- **Baseline chain:** at the readiness board's read (2026-10-29 ~17:1xZ),
  no pack from Tab existed yet for production `6bda3388`; his last posted
  pack was for `c47c3fc7` (seq 22830). If no `6bda3388` pack lands before
  the next flip, that pack's battery-diff baseline is ambiguous between
  `c47c3fc7` (last run of record) and `6bda3388` (actual previous prod) —
  Tab's call at run time.
- **E3 provenance is unarmed** (§1): until John's key-custody act, deploy
  records carry EMPTY/UNSIGNED provenance slots and flips reconstructed by
  deploy-watch are marked UNRECORDED-DEPLOY reconstructions, not signed
  records.

## 8. Sources

- Tab's 11 steps: muse-room seq 21671 (also filed at
  `wave-2026-10-27-consult-build/lanes/DOOR/APPENDIX-A-JOHNS-TAB-11-STEPS.md`).
- Packet shape and worked example: `fleet-tools/deploy-packet.mjs` v1.1;
  MERGE-DEPLOY-READY lane R3-A REPORT (candidate `63534b92`, stdout-proven,
  `--out` EPERM named).
- Per-flip staging form and baseline chain: MERGE-DEPLOY-READY lane R3-C
  INPUTS.md; Tab's posted packs at seqs 22589, 22677, 22830.
- Deploy split: Jill's ruling, muse-room seq 21895; Step 0 ownership,
  seq 20686.
