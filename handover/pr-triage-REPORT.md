# Open PR triage, Uuriko/project-room

Snapshot 2026-10-28, main at aaa74906. Read-only: nothing on GitHub was changed. Data: `prs.json` (raw per-PR), `triage.csv` (one row per PR).

## Counts

504 open PRs, 389 labelled `ready-to-land`.

| Class | All | of which ready-to-land |
|---|---|---|
| CANDIDATE | 226 | 217 |
| RED | 104 | 80 |
| UNKNOWN | 63 | 44 |
| SUPERSEDED | 48 | 26 |
| STALE-CONFLICTING | 44 | 10 |
| LANDED-ELSEWHERE | 19 | 12 |

UNKNOWN is 52 PRs that are green but conflict with main (pushed in the last 3 days, so someone may rebase them) plus 11 drafts.

By prefix (open / candidate / red): jill/ 223/121/22, other lanes 128/64/26, cursor/ 60/6/21, codex/ 33/12/5, grok/ 29/6/19, claude/ 17/13/3, cleanup/ 7/0/5. cursor/ has the most closable PRs (8 landed, 13 superseded). grok/ is mostly red. claude/ is mostly landable. Full breakdown is in triage.csv.

How the classes were decided:
- Branch protection requires only the `room/release-lease` status, which is set at landing time. So almost every PR shows `blocked`; that is normal and was ignored. "Conflict" means `git merge-tree` against main reports a conflict (or GitHub says `dirty` for stacked PRs).
- CI state is the latest run of each check at the head sha. "RED" means any of test/unit/browser/contract/cloudflare/gates/lint/coverage failed there.
- "Stale" uses the last push to the branch, not GitHub's `updated_at`. `updated_at` is 10-27 or 10-28 on nearly every PR because bots touch them daily, so it says nothing.
- LANDED-ELSEWHERE was proven by patch-id match (`git cherry`), an empty effective diff, or a merged PR whose body names the open PR as one of its sources.

## What the queue really looks like

- **The 389 `ready-to-land` label is not a queue.** 80 labelled PRs are red, 36 are already landed or replaced, and 54 conflict with main.
- **226 PRs are mergeable and green right now.** At about 10 merges a day that is more than three weeks of work, and they are not independent: 1,323 pairs of candidates touch at least one file in common.
- **Generated files cause most of the conflicts.** `scripts/CANDIDATE-MANIFEST.json` is edited by 128 open PRs and is the conflicting file in 83 of the 158 conflicts. `scripts/runtime-package.mjs` (85 PRs), the two copies of `errors-catalog.md` (57 each), `scripts/candidate-runtime-fixture.mjs` and `tests/fixtures/mcp-catalog.snapshot.json` follow. Every landing that regenerates the manifest breaks the next one. If CI regenerated these after merge instead of each PR committing them, most of the 52 "green but conflicting" PRs would become landable.
- **123 candidates are small (4 files or fewer) and touch none of those generated files.** That is the honest landable queue: about two weeks at the current rate.
- **210 candidates last ran CI more than 100 commits behind main**. Their green status is probably still right, but re-run CI before landing.
- **54 of the RED PRs fail only `unit` + `test`, which is the same pattern every time.** Some of that is likely one shared break or flake, not 54 separate bugs. The failure logs could not be read from here, so check one or two before triaging them one by one.

## Conflict clusters and duplicate families

**Resurrection vehicles.** Cursor's `cleanup/gN-combined` PRs each replay 2 to 16 older open PRs onto newer main. G2 (#4952) and G10 (#4950) merged today. The constituents of those two are what make up most of LANDED-ELSEWHERE. Eight more vehicles are open, and all of them are red or conflicting themselves:

| Vehicle | State | Constituents still open |
|---|---|---|
| G1 #4949 work claims/board, 72 files | red + conflict | 15 |
| G5 #4942 front door/discovery, 79 files | red | 13 |
| G6 #4956 storage slimming, 39 files | red + conflict | 8 |
| G8 #4938 public receipts, 32 files | green, conflict | 8 |
| G3 #4945 wake/presence, 52 files | red + conflict | 5 |
| G9 #4943 decision records, 50 files | red + conflict | 5 |
| G7 #4947 members/deletion, 19 files | red + conflict | 3 |
| G4 #4946 room UI, 99 files | red + conflict | 2 |

Each change now exists twice and neither copy is being kept up. Pick one path per vehicle. Either finish the vehicle and close its constituents, or close the vehicle and land the constituents that are still green. Five constituents are already clean and green (#3556, #3593, #3621, #3752, #4767) and appear in the landing list below. Landing them first makes their vehicles smaller.

**Other families:**
- MCP lean default: #4438 (grok) was replaced by #4933 (cursor), then redone as #5029 (Option A, decided 10-27). #5021 and G5 touch the same catalog files. Keep #5029 and close the other two.
- T0 deletions: #4971 (server, green), #4975 (data), and #4976 (client, green) overlap #4615 and #4521, which they replace.
- Stacked chains that have to land in order: #4150 > #4160 > #4185 (purge); #4810 > #4812 > #4814 > #4815 (conformance harness); #4295 > #4297 > #4345 (receipts); #4287 > #4289 (plugin); #5100 > #5120; #5135 > #5150; #5146 > #5148; #4988 > #4989 > #5005 > #5054 > #5059 > #5080 (codex native host, 45 to 50 shared files).
- CF-FOLD chain #4076 to #4080 (stacked, conflicting, untouched since 10-23).
- AGENT-DOOR-AUTH stages #4092 > #4416 > #4445 (conflicting, untouched since 10-23 or 10-24).
- Near-duplicates to settle: #4743 and #4885 (fail-probe fixture), #4856 and #5050 (join agent key label), #4524 and #4804 (#3778 wakeUrl), #4917 and #4983 (receipt og.png).
- Hot shared source files among live PRs: `docs/openapi.yaml` (53), `server/store.mjs` (52), `server/http.mjs` (43), `src/agent-error.mjs` (26), `server/agent-discovery.mjs` (25), `server/mcp-room-profile.mjs` (24), `src/app.js` (24), `server/bounty-escrow.mjs` (23).

## 30 best candidates, in suggested landing order

How these were picked: candidates based on main and not drafts, with green CI and no generated files touched. Ready-to-land and small PRs come first, then money, security and privacy fixes, then oldest. The list is chosen greedily so that **no two PRs in it touch the same file**, which means all 30 can land back to back without conflicting with each other. Re-run CI where noted.

1. #3621 fix(account-deletion): tear down a sole-owned room's pu... (2 files; CI success; also inside vehicle #4947)
2. #3952 fix(escrow): finalizeBounty pays an approved bounty thr... (2 files; CI success; rerun CI)
3. #4150 Purge completeness: public_work_requests + analytics ro... (2 files; CI success; rerun CI)
4. #4535 Fix #3907 (money settlement): payout lot id named lotId... (3 files; CI pending)
5. #4779 fix(tmp-hygiene): clean up secret-scan-diff probe dirs;... (3 files; CI success)
6. #4998 fix(public): lot reads consult the authoritative record... (3 files; CI success; rerun CI)
7. #5027 Add Allow header to hand-dispatched 405 responses (auth... (3 files; CI success; rerun CI)
8. #4131 Recovery audit: name unreadable rooms instead of leakin... (2 files; CI success; rerun CI)
9. #4197 Fan-out: apply the SEC-19 DM predicate to webhook deliv... (2 files; CI success; rerun CI)
10. #4472 CHALLENGE.md: remove promise pointing at a missing READ... (1 file; CI success)
11. #4976 T0 deletions (client): dead client stores owner-alerts,... (6 files; CI success; rerun CI)
12. #4979 W-39: govern .agents/skills as a deliberate, checked se... (2 files; CI success; rerun CI)
13. #4993 PIN B1-3: bonds + escrow distinguishing tests (24 bond... (2 files; CI success; rerun CI)
14. #5106 perf(canonicalJson): presort + stringify internals, sin... (3 files; CI success)
15. #5122 Reject mixed authorization context in agent preflight (2 files; CI success)
16. #5125 ATT: needs-me bountyAttention - decider/poster/worker l... (2 files; CI success)
17. #3556 Fence core work claims: claimGeneration round token + s... (9 files; CI success; also inside vehicle #4949)
18. #3593 fix(boot): instance lock binds holder identity (pid + s... (2 files; CI success; also inside vehicle #4945)
19. #3622 Guard the R2 backup target until it is restorable (#3585) (4 files; CI success; rerun CI)
20. #3638 fix(supply-chain): align sharp override at 0.35.5; pin... (2 files; CI success; rerun CI)
21. #3752 fix(sessions): work-session idempotency matcher covers... (2 files; CI success; also inside vehicle #4949)
22. #3818 fix(reviews): knownMember through ownMember - prototype... (3 files; CI success; rerun CI)
23. #4066 fix(claim-reputation): close open positions on closed/d... (2 files; CI success)
24. #4148 Job health: a current error outranks the disabled prese... (2 files; CI success; rerun CI)
25. #4193 fix(spend-pricing): run the sibling write-defense chain... (2 files; CI success; rerun CI)
26. #4240 O-5-FIX: admit the room owner to needs-attention regard... (3 files; CI success; rerun CI)
27. #4268 test(flake): FLAKE-TIMING - fix herdr F3, shed-loop tai... (3 files; CI success; rerun CI)
28. #4767 docs(discovery): llms packet text fixes - payment hones... (2 files; CI success; also inside vehicle #4942)
29. #4768 fix(cloudflare): raise /api/ready probe budget to 3000 ms (2 files; CI success; rerun CI)
30. #4810 test(conformance): PR-0 shared infra for #3676/#3677 ha... (5 files; CI success)

After these, keep landing from the 123 small candidates that touch no generated files. Hold the 66 candidates that touch `CANDIDATE-MANIFEST.json` or `runtime-package.mjs` until regeneration is moved out of PRs, or land those in one batch with a single regeneration at the end.

## Safe to close

**Close now: already on main (19)**
- Carried by merged G2 #4952: #3620, #4749, #4820, #4828, #4834, #4851, #4854, #4894
- Carried by merged G10 #4950: #4022, #4756, #4764, #4805. #4890 was deliberately dropped there in favor of #4756.
- Implemented by merged #4948 (windowed room read): #4857, #4860
- Same commit already on main: #4029, #4044
- Same change merged as #5046: #4554
- Empty diff, the workflow it deletes is already gone: #4221

**Close now: explicitly replaced (6).** These are the last six lines in the list below.

**Close once you commit to the vehicle (42).** These are replayed into open vehicles that are themselves red or conflicting. If you drop a vehicle instead, keep its constituents.
- Replayed into vehicle #4938: #4916, #4917, #4919, #4921, #4924, #4927
- Replayed into vehicle #4942: #3730, #4762, #4811, #4829, #4840, #4845, #4873, #4892, #4906, #4914
- Replayed into vehicle #4943: #4041, #4047, #4051, #4053
- Replayed into vehicle #4945: #3574, #4804, #4920
- Replayed into vehicle #4947: #3564, #4015
- Replayed into vehicle #4949: #3629, #3641, #3652, #3714, #3735, #3738, #4056, #4275, #4396, #4831
- Replayed into vehicle #4956: #4561, #4738, #4842, #4846, #4847, #4848, #4900
- #4438: explicitly replaced by #4933 (and lean flip now decided in #5029)
- #4521: board_vtwo table removal re-done in T0 deletions (data) #4975
- #4543: G6 notes cap raise superseded by slim storage (#4847/#4956)
- #4615: per-kind journal removal folded into T0 deletions #4971
- #4739: same AX recovery mappings re-done as #4977 (green)
- #4933: lean-default flip re-done as #5029 (Option A decided 10-27); confirm before closing

**Probably close: stale and conflicting (44).** These conflict with main and nobody has pushed in 3+ days (most last pushed 10-23). Close them, or ask the owner to rebase:
#3977, #3995, #4009, #4026, #4040, #4057, #4059, #4067, #4076, #4077, #4078, #4079, #4080, #4081, #4092, #4135, #4137, #4201, #4227, #4269, #4270, #4416, #4439, #4441, #4445, #4514, #4517, #4520, #4528, #4536, #4540, #4555, #4740, #4743, #4771, #4776, #4792, #4794, #4796, #4844, #4864, #4872, #4874, #4876
