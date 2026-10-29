# Readiness Board — MERGE-DEPLOY-READY, 2026-10-29

> Pin line: reads taken 16:54–17:19Z against production 6bda3388, main 63534b92 at read time; production has since flipped at least once more (96d8142a observed) — states are as-read.

Assembly: lane R6-C, from every lane REPORT.md in this wave. Verification governs what prints as READY: R6-A re-verified a 35% sample (6 of 17) of R2 verdicts (5 CONFIRMED, 1 MOVED, 0 REFUTED); R6-B independently verified every READY claim (7 CONFIRMED, 1 REFUTED as stated — protection — corrected below). Where R6-A or R6-B corrected a claim, this board prints the corrected version.

Protection, corrected (R6-B): snapshot **v5 at `~/workspace/fleet-tools/protection-snapshot.json` — NOT `state/`** — values: contexts `[]` / enforceAdmins `true` / required approving reviews `0`, live-matched field-for-field, first clean poll **17:18:00Z** (`PROTECTION OK … matches snapshot v5 (0 required contexts)`).

---

## 1. Per-actor verdicts

### Jill's fleet — SPLIT: READY for API-route landing support / NOT-READY for local-write-dependent support

**READY — API-route landing support.** Evidence, each verified at source:

- Landing Ledger live: 48 PR entries + 1 branch line, no duplicate entry PR numbers, sha256 `30fe25f806022b9a08f99496310712cbcecd81124b598eb70d7831e3cbe459c9` (R1-D assembled; R6-B CONFIRMED). Path in the verify-claim block below.
- #5231 merge-up executed via the Git Data API: new head `6e8deb06` (full `6e8deb0672f48b9ba990105d5c583398d0d3752f`), behind main 0, mergeable clean (R2-H executed; R6-A grade MOVED — R2-B's NOT READY was correct at its read head `34c9f9b0`, the merge-up supersedes it).
- verify-local + ci-wait suites green (R4-D fresh-process runs): verify-local v1.3 — 14 pass / 0 fail / 2 skipped (the 2 skips are the suite's own in-code EPERM gates, by design); ci-wait v1.0 — 13/13 pass, generationRunId resolution confirmed.
- Deploy-packet proven via stdout: R3-A packets for candidate `63534b92` verified byte-for-byte by R6-B (`packet-main.md` 12,449 B, sha256 `28070f3d…`; `packet-main.json` 16,042 B, sha256 `6af3934d…`); deploy-record store validates PASS, 35 lines (R3-D/R6-B CONFIRMED).
- Protection re-pinned v5 — corrected line above (R4-A; R6-B CONFIRMED in corrected form only).
- merge-train-packet v1.2 de-leased: `REQUIRED_CHECK = null`, version `1.2`, suite 21/21 (R4-F SHIPPED-LOCAL; R6-B CONFIRMED).

**NOT-READY — local-write-dependent support while the EPERM episode holds.** Named blocker: the VM write-fault episode is active. Evidence: fresh write-probe 16:56Z returned **EPISODE 6/9** signatures, exit 1, and its verdict file failed to persist, so the sanctioned standing read is UNKNOWN/stale (R4-B); gh-read is **EPISODE-BLOCKED** in this seat (suite 1 pass / 4 fail, all disk-writing tests leaving 0-byte artefacts — R4-D); deploy-packet `--out` file writes fail, stdout route proven instead (R3-A).

- One-line next act + owner: before any landing-support run, run a fresh probe and take the episode-mode sanctioned read; proceed only on the full CLEAR chain (fresh probe CLEAR + verdict file written + immediate `episode-mode.mjs status` = NORMAL within the 15-minute bound) — owner: the landing-support lane running that run (fleet operating rule, R4-B §4).

**Hook fixes (R4-C, audited at source; R6-B CONFIRMED the swap packages):**

- GC4-C (unledgered-watcher v1.5) — **LIVE**. GC4-D (protection-watch v1.5) — **LIVE**.
- GC4-E / GC4-F / GC4-G — **staged, one-step-ready, unexecuted**: swap packages in `lanes/R4-C/SWAP-PACKAGES.md` (PKG-E door-monitor v1.1→v1.3, with its cron-body change landing together; PKG-F lane-reaper v1.2→v1.3; PKG-G deploy-watch v1.1→v1.2 + deploy-record set). These are unexecuted coordinator acts; they do not block a landing (see §5).
- GC4-B (`hook_state_set` fix) — **BLOCKED-platform-owner**: the live runtime file is reconciled back to canonical on probe; the staged fix (sha256 `c2f70a8c…`, suite 13 pass / 0 fail / 1 skip on the staged file) cannot be applied by the fleet.

### Codex — READY

- Priorities **#5266 / #5268 / #5270 landed TESTED-GREEN, in production**: all three merged 2026-10-29 16:32–16:37Z, labelled, clean; exact-head CI TESTED-GREEN (R2-A; #5270 CONFIRMED by R6-A, merge commit = production `6bda3388`).
- **#5174 / #5180 merged-undeployed** (R2-B): merged, but both were **SKIPPED-NO-CI at merge**. One-line next act + owner: **deploy from main — Codex** (sole production writer).
- Waiting on him, prepared by the fleet:
  - **#5231 @ `6e8deb06`** — merge-up done, conflict and refresh blockers cured; still draft, unlabelled, CI at the new head is the designed skip (SKIPPED-NO-CI). His acts: un-draft, label `ready-to-land` (user/App token), fresh exact-head CI.
  - **ROOM-READS stack — all NOT READY**: #5193, #5194, #5187 (R2-C) and #5192, #5195, #5191 (R2-D) are drafts, with conflicts and/or CI skipped/none, **209–284 behind** main. Merge-up packets: `lanes/R2-H/PACKETS.md`. Composed-tree map: `lanes/R2-G/REPORT.md` — Stack 1 composes with named conflicts only (manifest at #5193 and again at #5194; the **stack-order-only fixture-anchor conflict #5195×#5192** in `scripts/candidate-runtime-fixture.mjs`, both inserting after the same `server/needs-me.mjs` anchor; fragment 0340 at #5192; plus the manifest legs). Rebase legs: #5193, #5194, #5192. **#5195 is GATE-CLOSED until #5125 + #5137 merge** (both re-verified open/unmerged by R2-D, R2-H and R6-A).
  - **Storage**: **#4900 HELD by his seq 22921 — the hold stands** (see §4). **#4960 TESTED-GREEN, residual-empty** (files `[]` at head; R2-E, CONFIRMED by R6-A) — his act: land the merge commit or close as superseded. **#4543 FAILED + QUEUED** per his GC1-H reply (R2-E). **#4265 FAILED + CONFLICTED + unlabelled** (R2-E).
  - Candidate branch **`codex/release-candidate-1028` stale** (283 behind, diverged) — his to refresh or abandon (R1-B ledger line).
- Deploy: rollback for the **6bda3388↔c47c3fc7 pair is UNPROVEN-gate-clear** — fence delta zero, the prior pair's GATE-REFUSED shape does not apply, eligibility still unproven (R3-B). One-line next act + owner: **GC1-E step 5 is the settling measurement — Codex**.
- Reconstruction-record ask: **CLOSED ON HIS TERMS** — declined at seq 22989 as a prerequisite. Replaced by the read-only import-mapping proposal, annexed at `board/IMPORT-MAPPING-PROPOSAL.md` (fleet imports existing sources into the existing deploy-record store; asks nothing of him, is not a release prerequisite, and leaves per-deploy attribution `UNRECOVERABLE` unless a source states it).

### Grok — NOT-READY

Named blocker: his base PR is red and conflicted.

- **#5135 RED + conflicted** (R2-F; CONFIRMED by R6-A at head `2f49b698`, run `40824766366`): failing = the contract job's `Run npm run check` step + all six browser shards' gates step (failing job names at the head: contract, browser shards 1/6–6/6, browser, test). Smallest fix is named in R2-F: fix the contract `npm run check` step and the browser/test derivative failure at #5135's head; **then** conflict resolution + fresh CI. Composed vs main (R2-G): the pair's only composed conflict is `scripts/CANDIDATE-MANIFEST.json`, mechanically regenerable; advisory composed tree `678d5aac…` if #5135's rebase regenerates the manifest.
- **#5150 stacked on #5135, RED predominantly inherited** (R2-F, R2-G): its contract failure is inherited/shared and its browser failures (shards 1/6, 5/6, 6/6) sit on #5135's failing substrate; it cannot be graded on its own until re-run on a fixed #5135. Composed vs main: manifest-only conflict; rebase leg is #5135, #5150 rides on it.
- One-line next act + owner: **Grok fixes #5135 (contract + browser gates, then the manifest conflict) and re-runs fresh CI; #5150 follows its base.**
- Prune spec: **adoption UNCONFIRMED** — the GC3 corrected spec was never delivered in-room by the fleet (a fleet-side miss, owned by the fleet — R4-E). It has now been delivered via tracked ask **seq 22988** (R6-B CONFIRMED the post resolves, status open). Behavioural check is clean: no new bound closes in the window.

### John's Tab — READY

- Inputs staged for the next flip: `lanes/R3-C/INPUTS.md` — his **11 steps verbatim from his seq 21671** (R6-B CONFIRMED all 11 named), the candidate (`63534b92` at staging), the carried PRs (#5273, #5274, #5275 — 14 commits over production, ancestor pre-checks staged), and the ancestor floor `93b14a3c`.
- Baseline gap named: **no pack from him yet for 6bda3388 at read time** — his last posted pack is c47c3fc7 (seq 22830); the next pack's battery-diff baseline is therefore ambiguous between c47c3fc7 (last run of record) and 6bda3388 (actual previous prod), his call at run time (INPUTS §6).
- **OWED TO HIM BY JILL**: the deploy-pack spec on a readable branch — **does not exist** (649 branches checked; see §5, the falsifier).

### Fo — READY

No fleet-side blocker. His #5238 proceeds under his own claim; CI state is his to report.

### Instinct / Dot — named non-responders, not blockers

- Instinct: readiness ask seq 21992 open since 2026-10-29T03:25Z, no answer.
- Dot: dormant since 2026-10-11; GitHub #3299 is the only channel.
- Neither blocks any seat's next landing.

---

## 2. HELP-UT outputs (recorded, not this wave's work)

Per the wave STATE.md STAND-DOWN section: no further confirmation loops from this wave on any of these; R5 lanes stayed observation-only (R5-A's one notice, seq 22970, and R5-B's one request, seq 22982, both predate the stand-down).

- **Ask (1) — B10 at production 6bda3388**: cold-agent **recovery WORKS**; **3 negative controls PASS**; one new S2 defect **F-B10-1** (a non-recipient reply to a private request was recorded publicly); **presence still broken**.
- **Ask (2)**: input delivered at seqs **22953/22954** (laptop seat); **B4 executing** from those packets. Input satisfied — do not re-ask.
- **Ask (3) — B9 executed**: ten-oldest-PR audit table posted at **seq 22958** (**FINISH 7 / COMBINE #3564+#3600 / RETIRE #3399**), **awaiting Codex's ruling**.

---

## 3. John's gates (from lanes/R3-E/REPORT.md)

Reproduced from R3-E's table. Scope rule (R3-E): only acts John alone can perform. Two signing systems are kept separate — E3 deploy provenance (row 1) and the receipt signer (rows 2–5) use different keys and different acts. **None of these blocks the seats' next landing except deploy-provenance signing (row 1).**

| # | Gate (John's act only) | What it unblocks | Exact act | Minutes |
|---|---|---|---|---|
| 1 | **E3 seat-key custody** (deploy provenance) | Signed DEPLOY_RECORDs: attribution goes from structurally impossible (0% attributable; every flip's actor fields `UNRECOVERABLE`) to 100% for compliant deploys, with `OK-SIGNED` / `ALARM-UNRECORDED` / `ALARM-BAD-SIGNATURE` verdicts in deploy-watch. Until this act, deploy-packet's E3 provenance slots stay EMPTY/UNSIGNED. The fleet-side build (~8–12 lh + 2–4 lh instrumentation) is NOT his — only custody is. | Complete custody of one Ed25519 seat signing key himself (no agent generates, holds, transmits, or chooses the custodian); hand the coordinator the **public half only** for the keyring. A needed action, not a choice. | **No price on record.** Nearest analogue on file ~5 min/key (App keys) — cross-reference only, not a sourced price for this act. |
| 2 | **Receipt signer G1 — key-policy decision** | Gate 1 of 4 for the receipt signer. Nothing generates a seed until decided; production receipts stay unsigned and unsigned history accumulates permanently (receipts cannot be retro-signed). Option B (versioned signed key history) is the fleet recommendation on record. | Read the C1 one-pager (492 words); state one line: adopt A (static key), B (versioned signed history — recommended), or C (Sigstore keyless). | **~3** (Part 3 total of 6 min covers rows 2+3 together — not additive beyond 6) |
| 3 | **Receipt signer G2 — S1 schema go** | The `bounty_receipts` table (freeze-ceremony schema go, his alone). Arming is forbidden until S1 has landed. Declining does not block signing — it blocks proof. | Read the C1b one-pager; state go / no-go on the `bounty_receipts` table. | **~3** |
| 4 | **Receipt signer G3 — PR #4807 disposition** | Gate 3 of 4: decides the signing channel's vehicle. #4807 is closed-unmerged; without a disposition no channel lands and Invariant 17 stays DOES-NOT-HOLD. | One line: **reopen** / **replace** (conformed draft lands, #4807 named superseded-by-decision) / **strike**. | **Not priced in any source** — a one-line decision. |
| 5 | **Receipt signer G4 — seed ceremony** (provisioning) | The signer itself: keeper movements then issue signed, offline-verifiable receipts. Runs only after G1–G3 discharge, S1 landed, channel landed dormant. **Fleet-owed blocker, not John's:** no runnable invocation for `generateReceiptKeyPair()` exists in any source; the fleet owes the exact run instruction first. | Generate one Ed25519 keypair offline, alone; custody the 32-byte seed in his own secret store (never sent to any agent); publish the public part at the well-known URL; enter the seed himself at the secret prompt as `ROOM_RECEIPT_SIGNER_SEED` (ref as `ROOM_RECEIPT_SIGNER_REF`). | **~32**, +5 if he publishes Step 5 himself (priced separately; not in the sitting total) |
| 6 | **GitHub Apps creation + private keys** (four Apps) | Per-fleet attribution and credential separation (today 107/107 dispatches stamp `Uuriko`); the Apps are the token source for App-token labelling (`ready-to-land` may only be added with a user token or an App installation token, never `GITHUB_TOKEN`); the release-seat App is the merge credential; prerequisite for row 7. | Signed in as Uuriko, create 4 Apps by the manual form (webhook off at creation), generate one private key per App, place each key himself by an approved route, confirm mode 600, hand over App ID / Installation ID / fingerprint only, clear downloads. Breakdown: project-room-jill-fleet 10 · project-room-codex 6 · project-room-grok 6 (App + install only — **no Grok key is generated**; no receiving host/custodian is named for Grok in any source) · project-room-release-seat 8 · opening check 2 · close-out 3. | **35 total**, including all key generation and placement |
| 7 | **Webhook activation on the fleet App** | The webhook gateway going live: built and fixture-verified but NOT LIVE. This act is the single unexecuted cutover blocking every polling-replacement row (event-driven CI-wait, instant merge detection, protection-drift wake), replacing the fleet's own polling load (~600–2,400 reads/hr at burst). The ≥24 h shadow period after it is the coordinator's, not John's. | On the fleet App (from row 6): turn Webhook **Active** on, paste the coordinator-supplied URL and secret (paste, never type), subscribe to exactly: Check runs · Check suites · Workflow runs · Pull requests · Pushes · Branch protection rules; confirm the `ping` delivery shows 200 in Recent deliveries; tell the coordinator. | **~10** |
| 8 | **Cloudflare audit-record read** (operator session) | Settles the one proven direct-to-Cloudflare deploy: 2026-10-25 ~06:35Z, Worker version `8552c7cb`; 17 mandatory fields of that record are UNRECOVERABLE, each with this read named as the settling read. Account owner's session only. Scope note: the separate incident-5177 dashboard item is WITHDRAWN as John's act (Codex's existing saved profile covers it) — this row is only the audit/version record for `8552c7cb`. | In his Cloudflare account session, read the account version/audit record for Worker version `8552c7cb` and hand back the actor + sub-route it names. | **Not priced in any source.** |
| 9 | **Runner concurrency — billing/plan act** (deploy-speed gate) | The pipeline's speed ceiling: hosted generations run at median 77.3% queue share; effective concurrency measures ~3 jobs against GitHub's published 20-job Free-plan figure. Each +1 of real concurrency ≈ +1,440 runner-min/day. The cause is visible only from John's side (billing API returns zeroed/401 from the fleet seat); if the cap is plan-tier, the purchase (Team plan) is his billing act. | Settings → Billing & plans → Actions: check plan concurrency, Actions minutes/spending cap, and payment state; if plan-tier, purchase the Team upgrade (priced against ~6,000–14,000 runner-min/day demand). If billing is clean and the cap persists, the fallback GitHub support ticket is also his, as account owner. | **Not priced in any source.** |

**Priced subtotal (R3-E): ~83 minutes** (~88 with the optional row-5 publish step) — rows 2+3 = 6 · row 5 = ~32 · row 6 = 35 · row 7 = ~10. Rows 1, 4, 8, 9 carry no source price and are listed unpriced rather than estimated.

Excluded by R3-E's scope rule (not gates on this board): ROOM_EXPORT_TOKEN arming (backup door only — storage/backup board), the OAuth App act (human sign-in only), closing the direct-deploy route (a policy line, not a blocker — provenance works without it), per-release freeze-class go/no-go (landing desk), and every seat/fleet act (the E3 unarmed build, keyring assembly, the supervised arming deploy, post-deploy verification by John's Tab, the webhook shadow period, the deploy-record store append decision).

---

## 4. Open evidence caveat — #4900

#4900's verify-local count discrepancy (**27 FAIL** in the discharge run vs **41 PASS / 2 FAIL** in the HELP-UT read) remains **OPEN** — HELP-UT B6 reconciles it. This board takes no position beyond Codex's hold (seq 22921, §1): the hold stands until that reconciliation lands.

---

## 5. FALSIFIER (this wave's own charter)

**The miss, plainly:** the deploy-pack spec on a readable branch, owed to John's Tab, was preparatory work the fleet could have done and **did not finish this wave** — inputs were staged only (`lanes/R3-C/INPUTS.md`). Verified absent: all **649 branches** checked, no `*deploy-pack*` branch exists and GitHub code search for `deploy-pack` in the repo returns 0 (R3-C §7). It is **the one item a seat (John's Tab) still waits on that was fleet-doable**.

Also named, neither of which blocks a landing:

- **GC4-E/F/G swaps are packaged but unexecuted** (coordinator acts, §1). Hook tooling runs at the older versions meanwhile, with EPERM exposure — a tooling risk, not a landing blocker.
- **The EPERM episode itself is environmental, not fleet-curable.** It gates local-write routes (§1, Jill's fleet NOT-READY leg); the API routes are the standing workaround, not a cure.

---

## 6. Spend line

Lane count: **31 spawned** (wave plan; 30 lane dirs on disk at assembly, including this lane — R6-D is held for the post-board room post).

- **Actual spend figures recorded in lane STATE.md files: ~0.6 lh total, recorded by 1 lane** (R4-E: "Spend ~0.6 lh" against its 0.8 lh budget). **The other 29 lane STATE.md files on disk record no actual spend figure** — they record budgets only. No spend total beyond the recorded ~0.6 lh is claimed; budgets are not spend and are not summed as spend.
- For scale only, clearly labelled: the lane-hour **budget** figures recorded in STATE.md files sum to **30.2 lh across 28 lanes**; 2 lane STATE.md files on disk record no lane-hour figure at all (R1-A, R4-F). The wave budget of record is 40 lh (wave STATE.md).

---

## Verify-claim block

- claim: Landing Ledger is live with 48 PR entries + 1 branch line, sha256 `30fe25f806022b9a08f99496310712cbcecd81124b598eb70d7831e3cbe459c9` — check: `sha256sum ~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/LANDING-LEDGER.md`; entry count per R6-B §1 (awk over the entry section).
- claim: protection snapshot v5 is at `~/workspace/fleet-tools/protection-snapshot.json` (NOT `state/` — that path does not exist) with contexts `[]`, enforce_admins `true`, required approving reviews `0`, pinned 2026-10-29T17:01:16Z, live-matched, first clean poll 17:18:00Z — check: read that file; `gh api repos/Uuriko/project-room/branches/main/protection`; tail `~/hooks/logs/protection-watch-hook.jsonl` (R6-B §2).
- claim: #5231 merge-up packets and the executed merge-up to `6e8deb06` — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/lanes/R2-H/PACKETS.md` and `lanes/R2-H/REPORT.md`; `gh api repos/Uuriko/project-room/pulls/5231`.
- claim: ROOM-READS merge-up packets for the remaining legs — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/lanes/R2-H/PACKETS.md`.
- claim: composed-tree map for both stacks, incl. the #5195×#5192 fixture-anchor conflict and the manifest legs — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/lanes/R2-G/REPORT.md` (advisory Stack-2 tree `678d5aacd074d2cbc0277ea1e58dc8ca3d1ae71d`).
- claim: read-only import-mapping proposal replacing the reconstruction-record ask — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/board/IMPORT-MAPPING-PROPOSAL.md`.
- claim: hook swap packages PKG-E/F/G and the GC4-B staged fix — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/lanes/R4-C/SWAP-PACKAGES.md`; GC4-B staged file `~/workspace/wave-2026-10-28-help-grok-codex/lanes/GC4-B/hatch_hook_runtime.sh.staged` sha256 `c2f70a8c6817ef9d40ba2cd5034641205eb37bfd78de2c1a3a6cabd72f3a1b8a` (R6-B §6).
- claim: John's Tab inputs staged, 11 steps verbatim from seq 21671, candidate + carried PRs + ancestor floor — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/lanes/R3-C/INPUTS.md` (R6-B §8 CONFIRMED).
- claim: deploy packets proven via stdout for candidate `63534b92` — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/lanes/R3-A/packet-main.md` (12,449 B, sha256 `28070f3d…`) and `packet-main.json` (16,042 B, sha256 `6af3934d…`) (R6-B §5).
- claim: merge-train-packet v1.2 de-leased, suite 21/21 — check: `~/workspace/fleet-tools/merge-train-packet.mjs` (`MERGE_TRAIN_PACKET_VERSION = "1.2"`, `REQUIRED_CHECK = null`); `node --test merge-train-packet.test.mjs` in `~/workspace/fleet-tools` (R6-B §3).
- claim: John's gates table and its minute prices — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/lanes/R3-E/REPORT.md` and the sources named in its Source column.
- claim: verification grades governing this board — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/lanes/R6-A/REPORT.md` (R2 sample: 5 CONFIRMED, 1 MOVED, 0 REFUTED) and `lanes/R6-B/REPORT.md` (READY claims: 7 CONFIRMED, protection REFUTED as stated, corrected form CONFIRMED).
- claim: rollback for 6bda3388↔c47c3fc7 is UNPROVEN-gate-clear with fence delta zero — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/lanes/R3-B/REPORT.md`.
- claim: EPERM posture at 16:56Z (probe EPISODE, verdict file failed, standing read UNKNOWN/stale) and the operating rule — check: `~/workspace/wave-2026-10-29-merge-deploy-ready/lanes/R4-B/REPORT.md`; tool states (verify-local READY, ci-wait READY, gh-read EPISODE-BLOCKED) at `lanes/R4-D/REPORT.md`.

*Board assembled by lane R6-C. Preparation only — this wave merged, deployed, and labelled nothing except where a lane's own charter stated otherwise (#5231's fleet-branch merge-up, R2-H). States are as-read at the pin line above.*
