# Planned SPILL end-state — in-store archiving, armed and steady

## 1. The piece

The storage end-state **beyond** the bound SPILL chain: automatic, in-store archiving of old room messages so no room's projection ever reaches the per-room cap unaided. It is a **planned piece**: this pack is written executable-at-gate (see the STOP in §4) and targets **main `aaa749065a6451321a949ddcb923f3174504fe35`** (verified via `git archive` of that SHA into lane scratch, 2026-10-28), assuming the bound chain in §2 has landed and deployed on top of it. Production build `ca37fee4` is not the target tree.

What exists at main `aaa749065a` today (all read at that tree):

- The archive machinery, landed: `archiveRoomMessages(store, roomId, {keepNewest = 2000, dryRun = true, belowCursor = false})` at `server/messages-store.mjs:1498`, `restoreArchivedMessages` at `:1612`, imported by `server/store.mjs:53`; the manual operator door `server/operator-archive.mjs` (PR #4123) is the **only** caller class.
- The cap: `PILOT_LIMITS.projectionBytes = 4 * 1024 * 1024` at `server/store.mjs:450`, enforced at `server/store.mjs:3585` with `409 pilot_limit` ("…Ask the room owner to have older messages archived to free space").
- The gauge/escalation job: `store-growth` at `server/jobs.mjs:659`, escalation `maxProjectionBytes: 3_500_000` at `:290`, `JOB_BUDGET_MS = 5000` at `:32`; relief leg in `server/store-relief.mjs`.
- **Absent at main (grep-verified on the extracted tree, zero hits):** `server/messages-archive.mjs`, any `messages-archive` job registration, and the string `ROOM_MESSAGES_ARCHIVE_LIVE` anywhere. There is no automatic archiving caller.
- `store.snapshot()` at `server/store.mjs:4790` has no `fullHistory` parameter yet — that is #4265's change, assumed landed by this pack, not duplicated by it.

The missing automatic caller exists in exactly one place: **closed PR #4247's head `4a82fa3104413612a10200ced718f2120dddc787`** — `server/messages-archive.mjs` (9,305 B via Contents API at that ref), the hourly `messages-archive` job on both runtimes, policy = due at ¼ cap (1,048,576 B), `keepNewest` fixed 2,000, largest-first, at most one room per live tick, dry-run unless `ROOM_MESSAGES_ARCHIVE_LIVE=1`. **Reopening #4247 is JOHN'S GATE** (MEMORY.md, SPILL-1 line: "#4247 was CLOSED in the 2026-10-25 cleanup; reopening is John's gate, and its first live run still needs the S3 arm after landing+deploy"). This pack instructs everything up to that gate in full, and the post-gate steps only as a conditional sequence that no implementer starts without John's explicit reopen decision on the record.

## 2. Current state

**Assumed-landed bound chain (do not rebuild; verify, §4 step 0).** Bindings file `~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`, cross-checked live via `gh pr view` 2026-10-28 — all three OPEN, unmerged:

| PR | What | Bound head | Record |
|---|---|---|---|
| #4900 | store-growth relief leg bounded by job deadline (`reliefDeferred`) | `e455e83c888acef7ee3f93ad368fe89a3b2faed1` | `a0e66073` |
| #4543 | BUY-TIME cap 4 MiB → 5 MiB, **land only on trigger** (room ≥3.8 MB before SPILL-1's first live run) | `e5ce7c3254000077de5dd1635dc8d6dd3a4f863d` | `69761f5e` |
| #4265 | S-1: `snapshot()` returns live window by default on archived rooms; `fullHistory` opt-in; SQL `omitted` count | `156eb4b0f3dc769d1333bebe0c3edeea067ce3a0` | `50cab6bc` |

Seat order (settle-pass-21 SYNTHESIS, "Updated seat order" item 3): **#4900 → #4543 (trigger check) → #4265**, with bound #5116 bodies-at-rest (`5ad736c6`, record `96ceda2a`, SETTLED-GREEN) "landed with the storage chain in view" and bound #5033 checkpoint-on-append (`fd3c1e0e`) in the ordinary queue. #4265's binding note carries two acceptance debts this pack inherits: **"`bench:room` owed before landing; Proof 3 owed at acceptance"** — Proof 3 = composed-head CI over **#4247 + #4256** (bindings archive note for #4265, 2026-10-24).

**Broken / missing beyond the chain:**

- **No automatic archiving.** Without #4247, relief is manual (operator door, John's session) or the store-growth relief leg. Gauge (MEMORY.md, 2026-10-28): largest room **1,433,781 B, +302,963 B/day** (~3× the prior rate) — ~7.8 days to the 3.8 MB BUY-TIME trigger, ~9.1 days to the 4 MiB cap at that rate. PERF-50 SYNTHESIS §2 (Storage) independently measured ~980–1,011 B/event inline growth and ~15.6 days to cap at the tempo it measured; the rates differ because the tempo moved — cite the gauge date with any number.
- **#4256 is also closed, unmerged** (`gh pr view 4256`: CLOSED 2026-10-25T19:57:53Z at `47fbb1858`, `mergedAt: null`; absent from current bindings `prs`). It is the SPILL-1 pin-suite leg (MA-01 certification-gate + MA-03 sequence-guard mutation pins, tests only) and half of Proof 3; bindings flags `FLAG-SPILL2` (merged, pr 4256) and `SPILL-LEGS-COMPLETE` (legs #4265 + #4256) cannot fire while it stays closed. Its restoration is a fleet act, **not** John's gate — but Proof 3 and the live run are blocked on it.
- **The S3 arm is pre-staged but inert.** Operator runbook `~/workspace/fixplan-2026-10-19/operator-session-runbook.md` §S3: steps execute only after #4247 has landed **and** deployed; the arm itself is a separate sequenced change setting `ROOM_MESSAGES_ARCHIVE_LIVE=1` in production `vars` in `cloudflare/wrangler.jsonc`, by the operator's (John's) hand. Note: "S3" here is runbook §S3 — there is no Amazon S3 anywhere in this design; archiving is in-store.
- **PERF-50 collision discipline** (SYNTHESIS §5): "Storage split / SPILL end-state" is priced **40–60 lh, trigger-gated** on "Storage > 4 GB, or cap pressure surviving bodies-at-rest + SPILL", and sharding "must not start until … the SPILL chain (#4900 → #4543 → #4265) has run". The storage split is therefore **not** part of this pack's build (§4 non-goals); this pack delivers the SPILL half of that trigger's precondition.

## 3. What fantastic means

Steady state, user-visible:

- **No room ever hits `409 pilot_limit` for projection size.** The largest room's stored projection, read from `/api/health/jobs` (`store-growth` gauge `maxProjectionBytes`), stays **below the 3.5 MB escalation line without human action**, because the hourly `messages-archive` tick archives any room due at **1,048,576 B**, largest-first, one room per live tick.
- **Archiving is invisible to readers.** Post-archive size on the muse-room-scale fixture: **3,500,932 → 930,518 B (−73.4%)** at `keepNewest` 2,000 (#4247 body, PROJECTION-ANATOMY); expected production range **0.6–0.9 MB** per archived room. List, visibility-filtered list, recent, single reads, full-text search (incl. DM privacy), and thread reads are **byte-identical** across an archive, and an archived edited message's `editHistory` survives (#4247 parity suite, §5).
- **Reads of archived rooms stay flat.** With #4265 landed: default `snapshot()` median **127 ms at 23k archived** vs 3,825 ms pre-fix, flat in archive depth (144 ms @10k vs 127 ms @23k); full history remains one explicit opt-in away (`fullHistory: true`, byte-for-byte legacy form) and the HTTP bare room GET is unchanged.
- **Every live tick is observable before it is trusted:** the dry-run tick names its planned room and projected post-archive bytes in `/api/health/jobs`; the first live tick's measured drop matches that projection; a `backfill_blocked` room is skipped and recorded (≤3 certification attempts/tick), never force-archived.
- **Rollback is a tested path, not a hope:** `restoreArchivedMessages` restores every archived message with stored records deep-equal (parity suite). Archiving is not deletion; the event log is retained. There is no operator restore route — a restore is a fleet code act arranged with Jill (runbook §S2 scope note).

## 4. The instruction

Target tree: the first main at or after the chain in §2 has landed **and deployed**. Store-adjacent / schema-adjacent discipline throughout: land singly, green at exact head, Ruling 41 does not relax this piece (it sits on the storage core every bound PR assumes).

**Step 0 — Verify the assumption, at the source (fleet, ~0.5 lh).** Two agreeing reads or one named API read per state claim: `gh pr view 4900,4543,4265,5116` show MERGED at their bound heads (for #4543, merged **only** if the ≥3.8 MB trigger fired before SPILL-1's first live run — if the trigger never fired, #4543 correctly stays OPEN and unlanded; record which). Confirm the deployed build carries them (production `/api/version`). If any leg is missing or head-moved, STOP: this pack does not cure the chain; route the gap to the settle process.

**Step 1 — Discharge #4265's two debts (fleet + seat).**
(a) `npm run bench:room -- --base origin/main --sizes 1000` at #4265's landing head, filed on the PR (its own body already carries the archived-shape probe: default snapshot 3,825 → 127 ms @23k archived; the bench fixture never archives, so the probe table remains the S-1 evidence and the bench is the no-regression record for un-archived paths).
(b) **Proof 3**: compose one tree of #4247's head + #4256's head over the post-chain main (they are the two SPILL-1 gate legs #4265's acceptance names), run one full hosted CI generation at that composed head, and file the run id — resolved by direct get, never from a delivered stream — on #4265's record. This needs step 2's #4256 restoration first; if #4247's head has been superseded by step 3's revival head, Proof 3 composes the revival head instead.

**Step 2 — Restore the #4256 pin leg (fleet act, not John's gate).** Reopen #4256 at its exact pre-close head `47fbb1858c3b00872e0407ab9cf474d0b44ce150` if the branch survives; otherwise re-file the identical tests-only diff as a successor PR and say so on the record. Merge-up to current main, re-price (hosted generation at the exact head; its suites are `tests/operator-archive.test.js` 9/9 and `tests/message-certification-continuity.test.js` 35/35 at its filed head), rebind, and hand to the seat to land singly. `FLAG-SPILL2` fires on its merge.

**Step 3 — Prepare the #4247 revival package, then STOP (fleet, ~2–4 lh prep).** Build the package so John's gate is a one-line decision, not a research task:
- Merge-up #4247's branch (head `4a82fa31`) onto post-chain main via the sanctioned API-assembly route if local git writes fault; resolve the expected overlaps by reading, not by assumption: `server/jobs.mjs` (vs #4900's deadline change), `server/messages-store.mjs`, `server/operator-archive.mjs` (shared `certifyRoomMessagesAtHead` lift), `scripts/runtime-package.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/CANDIDATE-MANIFEST.json`.
- Re-run #4247's own evidence at the revival head: `tests/messages-archive.test.js` (filed 9/9), `tests/messages-archive-parity.test.js` (1/1), `cloudflare/messages-archive.check.mjs` under workerd (1/1; filed shape: 1,241,716 → 1,183,002 B after archiving 100 messages, reader capture identical), incumbent regressions operator-archive + below-cursor + job-heartbeat + backfill-block (filed 45/45), `npm run bench:room -- --sizes 1000` (filed: all metrics `~`, no regression).
- Refresh the PR body's large-diff justification and registration sweep at the revival head (the filed sweep at `4a82fa31` reported item 1 MISSING for exactly the two test-only `cloudflare/messages-archive.*` files — a named sweep false positive with #4123 precedent; the production module `server/messages-archive.mjs` was SATISFIED in both lists; carry that note forward verbatim, do not paper over it).
- Post the package as one LAND-READY-style summary naming: revival head, Proof 3 run id, current gauge (`maxProjectionBytes` + date), and the exact ask.

**⛔ STOP — JOHN'S GATE.** Reopening #4247, and later the §S3 arm, are John's. No implementer reopens the PR, lands it, or sets `ROOM_MESSAGES_ARCHIVE_LIVE=1` before John rules. Silence is not assent on a directed question. Everything below is conditional on that ruling and is written so it can execute without further design.

**Step 4 — (Conditional) Land and deploy.** Seat lands #4247 singly at the exact green revival head; fleet never merges. Deploy through the normal pipeline; confirm the deployed build carries `server/messages-archive.mjs` and the `messages-archive` job registration on both runtimes. `FLAG-SPILL1` fires on #4265's merge, `SPILL-LEGS-COMPLETE` when both legs are in — re-read the flags after this step.

**Step 5 — (Conditional) Dry-run observation gate (runbook §S3 step 2, verbatim discipline).** The job is dry-run by default. Read one full hourly tick from `GET /api/health/jobs`, `messages-archive` row: it must name the largest room and its projected post-archive bytes, consistent with the current gauge. If the planned room is not the gauge's largest, or the projection disagrees wildly with the 0.6–0.9 MB expected range, **do not arm** — report the disagreement to Jill.

**Step 6 — (Conditional) The S3 arm — John's hand, its own change.** Per runbook §S3 step 3: set `ROOM_MESSAGES_ARCHIVE_LIVE=1` in production `vars` in `cloudflare/wrangler.jsonc` and deploy, as a standalone sequenced change, never bundled into another edit. Then §S3 step 4: read the first live tick plus the store-growth gauge and confirm the archived room's drop matches step 5's dry-run projection before leaving the job unsupervised. One room per tick is by design; the max room goes first. Subsequent ticks need no supervision unless §5's tripwires fire.

**Step 7 — (Conditional) Close the loop on #4543.** If the BUY-TIME bridge landed (5 MiB), file — do not silently decide — the revert question for Jill: keep 5 MiB as standing headroom or restore 4 MiB now that archiving relieves rooms at 1 MiB. PERF-50 §8 warns a cap raise alone "amplifies every whole-projection cost" and is only sound bundled after checkpoint-on-append + bodies-at-rest; the pack's deliverable is the measured post-arm gauge series (7 days of `maxProjectionBytes`) attached to that question.

**Explicit non-goals.** No storage split / per-room DO sharding (PERF-50 §5, 40–60 lh / 120–200 lh, trigger-gated — separate charter when a trigger fires). No delta/incremental projection persistence (PERF-50 §3 #1, its own charter; it is the only 100× prerequisite bought before triggers). No change to `keepNewest` (2,000), the ¼-cap due threshold, `PILOT_LIMITS`, or archive semantics. No second operator route, no `invalid_archive` error row, no adaptive keep-newest — all dropped from #4031 by the #4123-reconciliation ruling and not revived. No Amazon S3 or external archive store. No restore UI/route.

## 5. Acceptance

Coordinator/Jill runs these, in order; the work is accepted only when all applicable lines pass.

*Pre-gate (steps 0–3):*
1. Chain verification reads filed: PR states/heads for #4900, #4543 (landed-on-trigger or correctly still open), #4265, #5116 from `gh pr view` + deployed `/api/version` — two agreeing reads or the API method named in the same sentence.
2. `npm run bench:room -- --base origin/main --sizes 1000` output filed on #4265; no metric called worse (Holm p < 0.05 and ≥10% move is the bench's own verdict rule).
3. Proof 3: one composed head (#4247 revival head + #4256 head over post-chain main) with one hosted CI generation, all jobs success; run id resolves on a direct `gh run view` get.
4. #4256 restored and landed at its priced head (or successor PR landed with the record saying so); `tests/operator-archive.test.js` and `tests/message-certification-continuity.test.js` green in that generation.
5. Revival package: the four §4-step-3 suite groups green at the revival head, sweep re-run output filed, gauge figure dated.

*Post-gate (steps 4–6, only after John's ruling is on the record):*
6. #4247 MERGED at exactly the revival head (API read); deployed build confirmed; bindings flags `FLAG-SPILL1` / `FLAG-SPILL2` / `SPILL-LEGS-COMPLETE` re-read and reported.
7. Dry-run tick read from `/api/health/jobs`: planned room = gauge-largest room; projected bytes in or credibly near the 0.6–0.9 MB range.
8. Arm diff is exactly one line (`ROOM_MESSAGES_ARCHIVE_LIVE=1` in production `vars`) plus its deploy; first live tick's measured `maxProjectionBytes` drop matches the dry-run projection within the tick summary's own numbers; one room only archived.
9. Tripwires for the following 7 days (daily gauge read, speaks only on breach): any room crosses 3.5 MB escalation without a dry-run plan naming it; any `messages-archive` tick records a refusal other than a recorded `backfill_blocked` skip; reader-parity spot check (one archived room: conversation list + search result byte-compared against the pre-archive capture from step 5's room, if captured).

*Registration sweep (per ~/AGENTS.md pre-flight list) for the revival + arm diffs:*
1. Runtime-package closure — **REQUIRED**: `server/messages-archive.mjs` in `scripts/runtime-package.mjs` allowlist incl. import closure AND `scripts/candidate-runtime-fixture.mjs`; verify with `tests/runtime-package.test.js`, never by eye (filed SATISFIED at `4a82fa31`; re-verify at revival head).
2. Error-code catalogue, both copies — n/a: no new error code (the `invalid_archive` row was dropped by ruling).
3. Route triple — n/a: no new route (second operator route dropped by ruling; job only).
4. Harness copy sets — **REQUIRED**: `cloudflare/messages-archive.check.mjs` + test fixture wired as #4247 filed them (`cloudflare/package.json` explicit check list); the two files' item-1 MISSING is the named false positive carried in the PR body.
5. Store registries — n/a: no new table; archiving writes existing messages/archive tables via `archiveRoomMessages`.
6. Generated/mirrored artifacts — **REQUIRED**: regenerate `scripts/CANDIDATE-MANIFEST.json` for the touched deployment files and confirm byte-freshness in `CI=1 npm run check`.
7. Diff hygiene — **REQUIRED**: revival PR body carries a refreshed `## Large diff justification:` section (filed diff >300 lines).
8. Close-out — **REQUIRED**: `npm run verify:affected` plus, because the diff touches `server/**`, `CI=1 npm run check`; named suites: `tests/messages-archive.test.js`, `tests/messages-archive-parity.test.js`, `tests/operator-archive.test.js`, `tests/runtime-package.test.js`, `cloudflare/messages-archive.check.mjs`.
9. Refusal-shape step — n/a: no error code removed or refusal status remapped.

## 6. Routing

- **Revival build + Proof 3 composition (steps 1–3): Codex** — server/core work, and the merge-up/registration surfaces are his home ground. Channel: `room_request_reply` to Codex's room member with a concrete ask, a `workItemId`, and the expected result (the revival head + filed suite/sweep evidence); all Codex utilisation inside Project Room. Note the standing limit: that protocol does not wake an idle session.
- **Landings (steps 2, 4): Grok Bot, the landing seat**, singly, green at exact head, with John's Tab on merge-gate work. Jill's fleet never merges.
- **The gate and the arm (STOP, step 6): John alone** — #4247 reopening is his recorded gate; the S3 arm is an operator-session/wrangler act in his hand (runbook §S3). Jill's deliverable to him is the step-3 package, once, with the gauge dated.
- **Post-deploy verification (steps 5–6 reads, §5 items 6–9): John's Tab** for the production reads, with **Jill's fleet** owning the verification record, the 7-day tripwire watch, and the step-7 #4543 question. **Fo** is backup for any browser-side reader-parity spot check on an archived room.
- Handover channel for the piece as a whole: the muse-room record thread — the step-3 package posts there, John's ruling lands there, and each post-gate step reports there, so no step's state rests on chat relay.
