# HARVEST-RAW — MASTER-ISSUES dedupe accounting (2026-10-30)

Companion to `DRAFT-MASTER.md` in this directory. Method: every lane ITEM/ROW/GATE line was read; each unique item was homed in exactly one section of the draft; cross-references are pointers, not recounts. Counts below are this lane's tallies from the draft as filed (grep-verifiable: 550 rows matching `^MI-`, no duplicate MI numbers, sequence MI-001..MI-550 complete).

## 1. Per-source raw counts (as the lanes reported them)

| Source | Lane-reported count | Lane rows/lines | Notes |
|---|---|---|---|
| H-A register | 124 product rows (S2 39 / S3 85) | 124 ROW lines | States: OPEN 103 · FIXED-UNDEPLOYED 10 · FIXED-ALIVE 11 (per-row ruling i: 11/124, S2 6/39). Owners named for 4 rows only (1/5/6/30 → YC-MVP); 95 rows with no owner AND no closure path |
| H-B residue | 359 items | 272 ITEM lines | Lane states: EXECUTED 38 · ADOPTED-NOT-EXECUTED 188 · PAUSED 81 · NEVER-DISPOSITIONED 28 (+16 KILL decided in-sheet, +6 conflicts resolved in-sheet, +2 folded — inside the 359's source arithmetic). Lines < items because set rows consolidate (desk-feed 36-in-2-lines, discovery paused 21-in-1, two executed sets consolidated in prose, B4+G1 2-in-1) |
| H-C conflicts | 15 STATE-CONFLICT + 13 NEW-OPEN + 4 SUSPECTED | 28 ITEM lines + suspected section | Suspected 4 are unproven by the lane's own standard: carried in draft §7b, assigned no MI, counted nowhere |
| H-D GitHub | 201 open issues + 524 open PRs (populations, API reads 2026-10-30T21:52Z) | 10 named items verified individually + 15-item no-linked-PR list (2 overlaps between the two: #5177, #5368) = 23 itemised | Populations are not items; the un-itemised remainders enter the draft as two aggregate rows (MI-154: 186 issues; MI-155: 516 PRs) |
| H-E gates | 47 gates (10 with hard deadlines; oldest: Grammas retainer, since 2026-10-15) | 47 GATE lines | Gates only; per ruling iii they never merge into fixable items |
| H-F fleet | 72 unique items (54 prose-only pitfalls · 10 of 11 monitors bad · 3 cron warts, 2 of them aspects of monitor rows · 6 staged changes · 1 platform defect) | 72 ITEM lines | 66 of 72 unowned at source |
| **Raw total** | **655 item-counts** (124 + 359 + 28 + 23 + 47 + 72, +2 population aggregates = 655) plus the two GitHub populations themselves (725 underlying: 201 + 524) | **566 lane lines** (124 + 272 + 28 + 23 + 47 + 72) | The 655 and the 566 measure different things (items vs lines) and are both reported so neither is mistaken for the other |

## 2. Unique items after dedupe

- **550 master rows (MI-001..MI-550)** in DRAFT-MASTER.md.
- Represented items: the 550 rows include set rows whose expansion is: desk-feed +34 (36 items in MI-210/MI-211) · discovery executed set +15 (16 in MI-254) · discovery paused set +20 (21 in MI-255) · methods executed set +6 (7 in MI-265) · B4+G1 +1 (MI-246) · SIMPLIFY builds +8 (9 build rows in MI-532) · SIMPLIFY ledger sets +93 (95 rows in MI-533/MI-534). **Excluding the GitHub populations, the 550 rows represent 725 lane items** (550 − 2 aggregates + 177 expansion). Including the populations (MI-154 +185, MI-155 +515), **1,425 underlying items**.
- Reconciliation against the raw 655: 655 − 19 true duplicates (§3) − 16 H-B in-sheet KILL decisions (decisions, not items — the 16 codes are exactly the C-codes a coverage grep finds in H-B and correctly absent from the draft: C01-F, C03-F, C04-B, C04-G, C05-F, C07-M, C08-8, C10-D, C11-D, C11-J, C15-C, C15-D, C15-G, C16-12, C17-13, C19-K) − 5 park-half lines (halves of adopted rows, folded) − set-expansion differences — leaves a **named residual of 15 items in H-B's internal arithmetic** that could not be traced to individual ITEM lines in this lane (H-B's section subtotals sum to 359; its lines + expansions + KILLs account for 344). Flagged, not absorbed: if the coordinator wants it closed, the act is a recount of ADOPTIONS.md against H-B's §1 list, ~0.5 lh.
- Non-lane-derived master rows (13, inside the 550): MI-067 (the 9/124 records sweep, created by coordinator ruling i — it is an act, not a lane row) · MI-154/MI-155 (population aggregates) · MI-522..MI-528 (7 OWED-WORK / FLEET-SYNC programme items, from those waves' STATE/programme files as cited in the draft) · MI-532..MI-534 (3 SIMPLIFY ledger aggregates, from its DISPOSITION-LEDGER as cited via H-C's sources).

## 3. Duplicates found — 26 lane lines absorbed (19 true duplicate items in 15 merge groups + 5 park-half folds + 2 H-D internal overlaps)

| # | Merge group (one master item) | Sources merged | Items absorbed |
|---|---|---|---|
| 1 | Accept-after-fail (MI-507, §7) | H-A row 5 + H-C conflict 1 | 1 |
| 2 | Needs-me delivered-state exclusion (MI-508, §7) | H-A row 6 + H-C conflict 2 | 1 |
| 3 | Dispute decider read (MI-509, §7) | H-A row 32 + H-C conflict 3 + H-D issue #5368 | 2 |
| 4 | Presence cure #5338 (MI-513, §7) | H-A row 59 + H-C conflict 7 | 1 |
| 5 | Unsigned receipts / no signer (MI-336, §3) | H-A row 3 + H-B Killer 3 | 1 |
| 6 | Privacy legs, cure #5355 (MI-096 + MI-098, §2) | H-B Killer 12 (one item covering both register rows 45/47) | 1 |
| 7 | Conflicting claim recipes (MI-036, §1) | H-A row 99 + H-D issue #4448 | 1 |
| 8 | Settled-lot public read (MI-514, §7) | H-B C16-2 + H-B T2 #4998 residual + H-C conflict 8 | 2 |
| 9 | YopperChild write principal (MI-229, §2) | H-B Killer 7 + H-B D-11(i) leg (the D-11 row survives for its (ii) leg at MI-233) | 1 |
| 10 | GitHub Apps / single account (MI-423, §5 — the gate is the item of record) | H-B C07-C + H-B Killer 9 (+ D-2 Phase 0 as a leg, cross-referenced) | 2 |
| 11 | Bearer tokens / scoped credentials (MI-234, §2) | H-B Killer 13 + H-B C07-E | 1 |
| 12 | Product backup pull / TM-2 (MI-233, §2) | H-B Killer 11b + H-B D-11(ii) leg + H-F backup monitor (monitor 5) | 2 |
| 13 | Injection barriers (MI-230, §2) | H-B Killer 8 + H-B Killer 8 remainder + H-F pitfall C-18 | 2 |
| 14 | Write-fault hook fix (MI-231, §2) | H-B Killer 10 + H-F pitfall F-10 | 1 |
| 15 | Show HN (MI-212, §2) | H-B C03-C (+X5) + H-B C19-B6 | 1 |
| — | Park-half folds (not distinct per H-B itself): C04-J founding half → MI-051/MI-479 · C08-7 export half → MI-357 · C13-D3 build half → MI-172 · C13-D4 build half → MI-173 · C18-D6 L2–L5 half → MI-196 | H-B §1 | 5 lines |
| — | H-D internal overlaps: #5177 and #5368 appear in both the named list and the §4 list; counted once in the raw 23 | H-D | 2 lines |
| — | H-B's own pointer line (C13-D5-H2 remainder pointer) is excluded by H-B itself and was not counted as a line above; C13-D5's two real acts are split, not merged (journal leg MI-162, H2 remainder MI-174) | H-B | 0 |

**Total absorbed: 19 + 5 + 2 = 26 lines.**

Near-duplicates deliberately NOT merged (genuinely different acts; cross-referenced in the draft): register row 48 unlisted tools (MI-006) vs catalogue-count conflict (MI-510) vs schema under-declaration (MI-139) vs no MCP receipt tool (MI-140) — four different acts on one surface · register row 120 HTML decider (MI-043) vs MI-509 (HTTP/MCP faces) · register rows 2/37 composition (MI-069/MI-091) · Killer 4 meta-monitor build (MI-226) vs each monitor's current BAD state (§2f) vs pitfall W-7 (MI-286) · C07-D key-policy residue item (MI-489) vs the §5 signer gates it feeds (MI-426..429) — gate vs build, ruling iii · YopperChild gate (MI-418) vs its fleet half (MI-229) — ruling iii · PR #4951 the item (MI-402) vs its settings gate (MI-437) — ruling iii · the mint-ledger (MI-235, EXECUTED — fleet test-traffic ledger) vs register row 35 (MI-343, product mint-recovery surface) vs H-F GC4-F probe-minting semantics (MI-506): the charter's example pair was checked — H-F's only mint mention is the GC4-F semantics, a different item; no merge was forced.

Also applied while merging, per the coordinator's rulings: (i) closure of record 11/124, S2 6/39 everywhere; the 9/124 figure is MI-067 (records sweep, §1), and the counting conflict is resolved at MI-521. (ii) Live-effort ownership preserved: YC-MVP keeps register rows 1/5/6/30 + golden-path fixes (MI-068, MI-507, MI-508, MI-087, MI-129, MI-511); FLEET-SYNC's programme keeps the deploy path, main-health charter, #5125 rework, #4931 legs (MI-522, MI-524, MI-536, MI-537); OWED-WORK keeps its 9 (MI-523..MI-528 + MI-529/MI-530/MI-531/MI-506 acts); SIMPLIFY keeps the code-detail inventory + builds (MI-532..MI-534 and constituents MI-066, MI-139, MI-510, MI-517). (iii) Gates cross-reference fixable items and never merge into them (the one gate-to-gate exception: group 10 above, where three sources name the same gate and the H-E row is the item of record).

## 4. The three headline measures, recomputed on the deduped set

Definitions (precise, as counted):
- **Owner** = the owner named at source. A PROPOSED owner class assigned by this draft (`NONE→PROP:…`) is not an owner and does not reduce any count below.
- **Dispositioned** = the item was ruled on by someone with standing: adopted, parked/paused by a named decision, killed, gated to a named gate, executed/closed, or given a recorded disposition (including H-A's filing of a register row with a cure path — see measure 1's construction). Paused-by-decision counts as dispositioned; adopted-not-executed counts as dispositioned.

### Measure 1 — items with NO owner AND NO prior disposition: **119** (strict), with the adopted-unowned variant reported alongside: **17**

Strict construction (the three sets are disjoint after dedupe):
- **95** — H-A's own set: register rows with owner NONE and no closure path (no cure PR, no deployed cure awaiting retest, no recorded disposition). H-A computed this set at source; dedupe does not shrink it (the rows other lanes duplicated — 5, 6, 32, 59 — are not in it: three are owned, one has a cure).
- **11** — H-B items whose state is NEVER-DISPOSITIONED and whose owner is NONE: Methods Tranches C-1..C-5 (MI-256..MI-260) + Three-Traditions Lessons 4, 6, 7, 8 and 2, 3 (MI-266..MI-269, MI-391, MI-392 — six lessons, all owner NONE).
- **13** — H-D itemised production defects with no owner and no disposition: issue #5177 (MI-141) + 12 of the §4 no-linked-PR list (MI-142..MI-153 minus #4449's row — counted: #3270, #3378, #3379, #3318, #1907, #3437, #3842, #4261, #4262, #4263, #4264, #4449 = 12). Excluded from this set: #5368 (merged into MI-509, which has a cure path), #4448 (merged into MI-036, inside the register's 95), #4900/#4951 (owner NONE but dispositioned by Jill's rulings — they are unowned, not undispositioned).
- **Total strict: 95 + 11 + 13 = 119.**

Variant, as instructed: **adopted-not-executed counts as dispositioned, but its unowned subset is reported separately: 17** — H-B ANE items with owner NONE at source: discovery charters + step-log wiring 8 (MI-246..MI-253) · discovery redesigns 2 (MI-389 B1, MI-390 H3) · methods remainders 4 (MI-261..MI-264) · reputation build 1 (MI-363) · two gate-class requirements whose owner field is NONE (fires-when / gates-any-build) 2 (MI-463, MI-465). 8 + 2 + 4 + 1 + 2 = **17**.

Not counted in either number, named so they are not mistaken for omissions: the two GitHub population aggregates (MI-154/MI-155, owner NONE→PROP — undispositioned in bulk, but they are populations, and counting them as 2 items beside 702 underlying members would corrupt both figures; the disposition-sprint item that would disposition them is MI-380, itself never-dispositioned but owned by John-as-authoriser) · H-F's 52 prose-only pitfalls (owner NONE, but cataloguing with a promote-or-rejustify ruling is a disposition) · H-C's new-open items (owner Codex at source).

### Measure 2 — never-dispositioned count: **28**

Exactly H-B's 28, and dedupe changed nothing: every never-dispositioned item survived as a unique master item and none was a duplicate of anything in another lane. Composition: Wave-200 conflict X2 (MI-550) · Killer 9 successor, org move (MI-378) · Clean-slate 8 (MI-379, MI-380, MI-381, MI-382, MI-383, MI-501, MI-270, MI-404) · Methods Tranches C-1..C-5 (MI-256..MI-260) · Methods Tranches D-1..D-7 (MI-494..MI-500) · Three-Traditions Lessons 2, 3, 4, 6, 7, 8 (MI-391, MI-392, MI-266, MI-267, MI-268, MI-269). 1 + 1 + 8 + 5 + 7 + 6 = 28.

### Measure 3 — unowned count: **257 of 550 (46.7%)**

Owner NONE at source, by section: §1 50 (all 46 register low-hanging rows + MI-061, MI-063, MI-064, MI-067) · §2 165 (§2a 59 of 61 — all but the two YC-MVP rows; §2b 0; §2c 15; §2d 8; §2e 22; §2f 61) · §2g 2 (MI-548, MI-549) · §3 29 · §4 3 (MI-397, MI-402, MI-405) · §5 0 (all John's) · §5b 2 (MI-463, MI-465) · §6a 4 (MI-502..MI-505) · §7 1 (MI-521, a coordinator-ruling item) · §8 0 (all owned by live efforts). Total 50 + 165 + 2 + 29 + 3 + 0 + 2 + 4 + 1 + 0 = **257**. Every unowned FIX / LOW-HANGING row in the draft carries a PROPOSED owner class with a one-word reason; proposals do not reduce this count.

## 5. Verification performed by this lane

- Draft grep: 550 `^MI-` rows, no duplicate MI numbers, sequence MI-001..MI-550 complete, no `truncated` markers (the two grep hits for the word are content: a truncated llms.txt example and pitfall F-3's subject).
- Coverage grep: every C-code in H-B appears in the draft except the 16 in-sheet KILL codes (correctly absent — they are decisions) and C13-D5-H2 (H-B's own pointer notation for MI-174). This grep caught two rows after their sections had closed — C13-D12 and conflict X2 — which were added as MI-549/MI-550 in the addendum rather than renumbering 550 rows.
- Cross-reference spot-check: all MI-to-MI references in §5/§6/§7/§8 were re-read against their targets; four wrong references found in drafting (price book, C17-11, SPW watch, #4900) were corrected in the file.
- Known limits: H-B's ±15-item internal residual (§2 above); composition verdicts in §7 are head-bound to eb325a13 while PR #5428 now sits at 3a2f3a56 (fix-state of its 9 findings UNKNOWN-AT-READ, per H-C §3); H-D's no-linked-PR list is a title/branch string-match heuristic, as its lane states.
