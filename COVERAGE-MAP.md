# UT COVERAGE MAP — four efforts, one division

Built by UT-DOT lane C2, 2026-10-29. Sources read at 2026-10-29T17:43Z:
HELP-UT CHARTER/STATE/ARTIFACTS/SYNTHESIS + lanes/B10/REPORT.md ·
UT-MIXED CHARTER + STATE (full ledger; its V/D position as of that read) ·
UT-LIMITS CHARTER + STATE · UT-DOT STATE · Dot results relayed by Codex,
room seq 23005. Nothing was re-tested by this lane; this map divides work,
it does not re-run it.

Efforts: **HELP-UT** (solo stranger journeys + seat asks) · **UT-MIXED**
(paired human+agent seams) · **UT-LIMITS** (limits: local lab + bounded
production confirmations) · **Dot** (isolated local bus; relay-only
provenance — she has no Room connector / enrolled identity).

## Coverage table — scenario × arena × owner × status

| Scenario | Arena | Owner | Status |
|---|---|---|---|
| Stranger door, 16 rows (hero, sign-in, settled lots, agent pages, receipts) | Production `room.trydemigod.com` | HELP-UT C01–C24 | DONE at c47c3fc7 — door unchanged rows 1–15; row 16 ABSENT→DEGRADED |
| Solo money loops (post→claim→submit→accept→settle drills) | Production, own seeded test rooms | HELP-UT C04/C05/C17/C19/C20 | DONE at c47c3fc7 — complete, conservation exact |
| Solo negative controls (forged receipt, wrong-room invite, double claim) | Production, own test rooms | HELP-UT C16 (+ B3 pack) | DONE — controls PASS; one NEW defect (magic-link ordering, UI-only) |
| Cold-agent inbox / reply recovery + history privacy | Production, disposable rooms | HELP-UT B10 (Codex seq 22934 ask 1) | DONE at 6bda3388 — recovery WORKS; F-B10-1 found (see scorecard) |
| Seat asks: freshness rig, composed-tree rig, older-PRs audit, public-jobs evidence | Production / GitHub reads | HELP-UT B1/B2/B7/B8/B9 | DONE, consumption PENDING; ask (2) affected-test audit assigned to B4 |
| Paid-work happy path (founder×fresh, maintainer×experienced) | Production, paired rooms | UT-MIXED S1a, S1b/F1 | DONE at 6bda3388 — completes, conservation exact |
| Dispute (founder×experienced; sceptic×stale) | Production, paired rooms | UT-MIXED S2a, S2b→F2 | DONE — impossible in a two-person room; completes only with an imported third-lane decider |
| Invite own agent (founder; returning user) | Production, paired rooms | UT-MIXED S3a, S3b | DONE |
| Agent goes silent (sponsor view; maintainer view) | Production, paired rooms | UT-MIXED S4a, S4b | DONE — no reclaim on the money face; board force-release exists, undisclosed (V4) |
| Ambiguous instruction (founder×fresh; sponsor×stale) | Production, paired rooms | UT-MIXED S5a, S5b→F3 | DONE — clarification loop never closes (V3-corrected form) |
| Privacy seats / private-request injection (3 seat shapes) | Production, paired rooms | UT-MIXED S6a, S6b/F4, S6c | DONE — F-B10-1 cross-confirmed from every seat class and both faces |
| Scored / split competition for funded work | Production, paired rooms | UT-MIXED S7a, S7b | DONE — no scored competition and no native split exist |
| Cold / stale agent rejoins busy room | Production, paired rooms | UT-MIXED S8a, S8b | DONE — catch-up works at summary level; supersede tool hidden in full profile (V5) |
| Negative controls N1–N4 (forged receipt, expired invite, removed member, role-less approval) | Production, paired rooms | UT-MIXED N1–N4 | DONE — N1/N2/N4 upheld; N3 fails on visibility/state clauses |
| Seams: handoff clarity, mention/wake, permission matrix | Production | UT-MIXED X1, X3, X4 | DONE — wake rule: linkage wakes, text never does |
| Seam: presence truthfulness probes | Production | UT-MIXED X2 | IN FLIGHT at 17:43Z read (spawning T2; ungraded in M2's close) |
| Independent re-runs of counted defects | Production, original lanes' live rooms | UT-MIXED V1–V6 | DONE 17:40–17:42Z — 8 confirmed in full, 4 confirmed narrowed/corrected, 0 wholly refuted |
| Persona-fidelity audit of the paired method | Desk (reports + evidence logs) | UT-MIXED M2 | DONE 17:42Z — two-hat protocol held; downgrades named for D1/D2 |
| Seam report / scorecard consolidation / seat evidence post | Desk | UT-MIXED D1, D2, D3 | HELD at 17:43Z read (spawn when X2 + M0 + V verdicts are in) |
| Mint ledger + cleanup roll-up | Desk | UT-MIXED M0 | IN FLIGHT at 17:43Z read |
| Concurrency ramp, cap approach/cliff, entity-projection arm, 1k rooms, burst, wake latency, hydration, export | Arena A: LOCAL LAB, unbounded (local builds; main tip + PR #5218 tree where chartered) | UT-LIMITS A0–A17 | PARTIAL at 17:43Z read — A0-LAB/A0-CAP done; A3/A4/A5 running; A1/A2/A6–A17 held |
| Production confirmations (≤25 concurrent, disposable room; door latency; new-room timing) | Arena B: PRODUCTION, bounded, seat-notified seq 23011; abort thresholds in charter | UT-LIMITS B0–B6 | PARTIAL — B0 watcher running; B1/B3/B6 running; B2/B4/B5 held |
| Mint limiter edges + is PR #5061 live? | Local lab + production source read | UT-LIMITS M1/M2/M3 | DONE — #5061 NOT LIVE at 6bda3388; day-tier Retry-After understated ~24× (local, 63534b92) |
| Targeted request | LOCAL BUS (isolated) | Dot | DONE — PASS (local semantics only) |
| Working indicator | LOCAL BUS (isolated) | Dot | DONE — PASS (local semantics only); production port = UT-DOT C3WI, see (b) |
| Offline return | LOCAL BUS (isolated) | Dot | DONE — PASS (local semantics only); production port = UT-DOT C3OR, see (b) |
| Followup | LOCAL BUS (isolated) | Dot | DONE — PASS (local semantics only); no separate port — production followup/attention is owned by UT-MIXED X3 + HELP-UT B10 (linkage wakes) |
| Changed-requirement → 409 stale-context, no obsolete answer | LOCAL BUS (isolated) | Dot | DONE — PASS (local semantics only); production port = UT-DOT C3CR, see (b) |
| Working-indicator truthfulness during a long agent task (production) | Production, real room | UT-DOT C3WI | GATED — runs only the slice UT-MIXED X2 leaves unclaimed (≤1 mint) |
| Offline return: agent disconnects mid-task and returns (production) | Production, real room | UT-DOT C3OR | GATED — runs only the unclaimed return-leg slices vs B10 / S4a / S4b / X2 (≤2 mints) |
| Changed-requirement mid-flight: human edits the ask while the agent works it (production) | Production, real room | UT-DOT C3CR | GATED — version/invalidation semantics vs Dot's local 409 (≤2 mints) |
| F-B10-1 NC2 retest on the fix candidate (frozen candidate 2457a65e, PR #5282 head deef7f49) | Candidate surface — NO confirmed route | UNCLAIMED | See (c) |
| Dot sync itself (exchange plans, divide coverage, joint scorecard) | Room + GitHub #3299 + Codex relay | UT-DOT C1A/C1B/C1C/C2 | IN FLIGHT — workItemId ut-dot-sync-2026-10-29; this map + scorecard are the C2 leg |

## (a) Overlaps found and how they were resolved

1. **F-B10-1 (private-request reply injection).** HELP-UT B10 discovered it;
   UT-MIXED S6 was chartered to deepen that class from every seat — deepening,
   not duplication. Resolution: B10 is the discovery of record; S6a/S6b/S6c/X4
   are cross-confirmations; nobody re-runs B10's solo setup.
2. **Presence truthfulness.** HELP-UT (C04/C08/B10: BROKEN, known-still) and
   UT-MIXED (S4a/S4b seam observations) both touched it. Resolution: UT-MIXED
   X2 owns the dedicated production presence probes; UT-DOT C3WI and C3OR are
   gated on X2's coverage and run only what it leaves unclaimed.
3. **Cold return / agent goes silent.** B10 (cold recovery), UT-MIXED S4a/S4b
   (silence) and S8a/S8b (rejoin) cover adjacent ground. Resolution: B10 owns
   cold inbox/reply recovery; S4/S8 own the paired silence/rejoin views;
   UT-DOT C3OR takes only the unclaimed return-leg slices.
4. **Changed-requirement vs supersede.** UT-MIXED S8b found production work
   items could not be edited/superseded on the surfaces it tried (V5 later
   found `room_supersede_work` in the full 122-tool profile only); Dot's bus
   returns a 409 stale-context. Resolution: different surface and build —
   neither result grades the other (UT-MIXED coordination note). UT-DOT C3CR
   tests production version/invalidation semantics directly.
5. **Solo journeys.** HELP-UT Cluster C owns them; UT-MIXED is chartered NOT
   to re-run door rows, settled lots, or solo money drills, and HELP-UT
   reciprocally cites UT-MIXED seam findings instead of re-testing them
   (coordination note filed both ways, 2026-10-29T17:11Z).
6. **Wake / followup.** UT-MIXED X3 owns the production wake rule; HELP-UT
   B10's attention result is scoped to tracked asks on 6bda3388. Dot's local
   followup PASS is not blended with either.
7. **Production load.** UT-LIMITS Arena B is the only effort chartered to put
   concurrency on production, bounded (≤25, disposable room, seat notice
   seq 23011, named abort thresholds). Functional waves use their own
   disposable rooms at ordinary load and never push toward the storage cap.
8. **One mint pool.** All waves share the rolling-24h limiter (80/day network,
   200/day global). HELP-UT is final at 20 and closed; UT-MIXED counted 28 at
   17:40Z (worst case 29 with X2); UT-LIMITS spent 1–2 of its 12 cap by its
   17:40Z tally lines; UT-DOT is capped at 6. No wave mints against another's
   allowance.

## (b) Dot's three scenarios and who ports them

Dot keeps all three on her local bus. The production ports belong to
**UT-DOT Cluster 3**, each gated on the named prior coverage so nothing
runs twice:

| Dot scenario (local bus, PASS) | Production port | Gate |
|---|---|---|
| Working indicator | UT-DOT C3WI — truthfulness during a long agent task | Gated on UT-MIXED X2's presence/indicator coverage; unclaimed slice only |
| Offline return | UT-DOT C3OR — disconnect mid-task and return | Gated on HELP-UT B10 + UT-MIXED S4a/S4b/X2 coverage; unclaimed return legs only |
| Changed-requirement → 409 | UT-DOT C3CR — human edits the ask mid-flight | Version/invalidation semantics on production; compared with, never substituted for, Dot's local 409 |

## (c) NC2 candidate retest — UNCLAIMED

The retest of F-B10-1 against the fix (frozen candidate `2457a65e`, PR #5282,
head `deef7f49`) is **UNCLAIMED pending a confirmed route**. UT-MIXED has the
brief STAGED (lanes/V7/STAGED-BRIEF.md, staged 17:45Z per its STATE) with the
route NOT confirmed — no candidate route exists in any fleet-readable source
and production at 6bda3388 does not carry the fix. UT-DOT is searching
(lane C3NC2, read-only; lane C1C asks Codex for the candidate route).
Claim rule, agreed both waves: whichever wave first writes a CONFIRMED
reachable route into its STATE owns the retest; the other defers.

---
Provenance: every status above is transcribed from the named wave's own
STATE/REPORT files at the 17:43Z read; in-flight rows are marked as such
and may have moved since. Shared results home (proposed):
branch `jill/ut-joint-scorecard-1029`, workItemId `ut-dot-sync-2026-10-29`.
