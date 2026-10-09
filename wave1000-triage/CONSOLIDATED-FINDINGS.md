# WAVE-1000 rollup triage — consolidated ranked findings

**Guild-40 coordinator, WAVE-2000.** 2026-10-09 ~08:25 PDT.
Branch: `wave2000/guild-40`. Method: read-only fetch of all 20 `wave1000/guild-NN`
branches (19 on `Uuriko/project-room`, guild-18 on `Uuriko/skill-harness`);
cross-read every guild's `findings/` tree against the WAVE-1000 launcher ledger
(`~/workspace/pr-wave1000/launcher-ledger.md`); deduplicated overlapping reports;
ranked by production impact. Workers: none spawned (coordinator ran as depth-2
subagent, `can_spawn=no` — consolidation done directly from branch evidence).
Room posts: GUILD-CHARTER + DONE-ROLLUP only, each read-back verified.

## Branch sources (all pushed, SHAs ls-remote-verified)

| Guild | Branch | Slice | Head |
|---|---|---|---|
| 01 | wave1000/guild-01 | claim core (7 files) | 66cc81b7b |
| 02 | wave1000/guild-02 | server/http.mjs | c02291546 |
| 03 | wave1000/guild-03 | routes + MCP | 0c023d463 |
| 04 | wave1000/guild-04 | store/sqlite/events/room | 7e7f68936 |
| 05 | wave1000/guild-05 | room scripts + migrate + runtime-package | 1e41c9728 |
| 06 | wave1000/guild-06 | remaining scripts | f7d169a97 |
| 07 | wave1000/guild-07 | client + web assets | 8ab07c98b |
| 08 | wave1000/guild-08 | claim+room test suites | 74d66d886 |
| 09 | wave1000/guild-09 | api+security+other test suites | aca6b0df7 |
| 10 | wave1000/guild-10 | docs | 39423470e |
| 11 | wave1000/guild-11 | telemetry + tripwires + plugin store | c5c37c4c0 |
| 12 | wave1000/guild-12 | streams/sse/wakes | 13e5fd1f3 |
| 13 | wave1000/guild-13 | auth/invites/identity | 222b2daf5 |
| 14 | wave1000/guild-14 | money (read-only) | 8f00d98bc |
| 15 | wave1000/guild-15 | gmail/channels/adapters | 24f74be25 |
| 16 | wave1000/guild-16 | workflows + crons + jobs | 7497e232d |
| 17 | wave1000/guild-17 | CI/deploy | 55616be67 |
| 18 | wave1000/guild-18 (skill-harness repo) | skill-harness | 7d34f95bb |
| 19 | wave1000/guild-19 | validation/parsers/sanitizers | b31a2cb83 |
| 20 | wave1000/guild-20 | locks/fences/concurrency | 563fbe565 |

Coverage: ~430 mutants, ~15k fuzz inputs, 21 race units, 10-branch re-verifies per guild.

---

## PART A — ranked findings (deduped across guilds)

Severity = impact on `origin/main` production as it stands (unmerged-branch defects
are flagged as merge-blockers, not prod bugs).

### 🔴 HIGH — live on origin/main

**A1. server/instance-lock.mjs — deterministic double-hold race: two server.mjs on one DB** (g20, 3 RACES CONFIRMED, 2 room-posted)
Interleave A (deterministic): racer hits EEXIST between `openSync("wx")` and
`writeSync`, reads the empty file as malformed→stale, unlinks the live creator's
lock and acquires too — BOTH return "acquired". Interleave B (188/200 rounds):
racing stale reclaim interleaves unlink/create so the loser deletes the winner's
fresh lock. Root cause: non-atomic file protocol; fix direction is link(2) or
flock. Repro: `findings/guild-20/race-hunt/rh01.mjs`, `rh02.mjs` on
wave1000/guild-20. No guard rails; SQLite corruption / double-mutation exposure.

**A2. Exfil hole STILL OPEN: no CODEOWNERS over .github/workflows/, staging injects deploy secrets on push-to-main runs** (g17, re-verified, not re-reported)
Fix commit b42febd80 sits unmerged on `origin/wave400/audit`; also needs the
`require_code_owner_reviews` flip (John tap — see tap list). Exploit sketch
verified in findings/guild-17/gate-g5-exfil-hole.md. Cross-ref MEMORY.md
2026-10-08 security findings.

**A3. server/guest-invites.mjs:460 — guest-invite mint deadlocks unverified owners on mail-unconfigured deployments** (g13, BUG CONFIRMED posted, read-back verified)
`GuestInvites.mint` carries the email-verification gate with NO
`emailVerificationUnachievable` bypass — the exact class already fixed for agent
invites. Account-bound room key + unverified owner + unconfigured mailer → 403
`email_unverified`, permanently (verification can never complete). Reproduced on
origin/main. Fail-first regression: `findings/guild-13/guest-invites-mail-unconfigured.test.js`
(fails current, passes with bypass). Fix shape: thread `emailVerificationUnachievable`
through `GuestInvites.mint` exactly like `AgentInvites.create`
(server/agent-invites.mjs:164). Related (cross-guild): unmerged branch
`hardwork-sec/referral-email-gate` adds the same unconditional gate to
`ReferralInvites.mint` — landing it as-is reopens the deadlock (g13 R5);
server/share-links.mjs mint carries the same gate shape (out of slice, needs owning-guild check).

**A4. server/room-activation-pack.mjs:172 — pinned DMs leak to unauthorized viewers** (g04, BUG CONFIRMED posted)
Mutation S3-adjacent/pin-visibility finding P3: pin visibility filter dropped →
8/8 pass; pins leak to unauthorized viewers. Fail-first regression pinned.

**A5. server/work-claim-routes.mjs:191 — `human ||`/`&&` permission-check logic bug** (g08, BUG CONFIRMED posted)
Confirmed boundary/logic bug in the permission check; repro + regression on
wave1000/guild-08. (Guilds 08/09 also flagged sibling boundary bugs:
server/claim-coordination.mjs:109 lapsed-lease `<=` boundary;
src/events.js:2172 `claimIsActive` expiry-instant boundary — both BUG CONFIRMED, posted.)

**A6. Slowloris connections NOT bounded: `server.requestTimeout=15000`/`headersTimeout=10000` (http.mjs:5005) do not reap idle or dripping connections** (g02, headline)
Verified 25–30s vs both http.mjs and bare node:http; platform behavior; the
defense-in-depth intent is unrealized. Needs an app-level idle watchdog.
Prod behind Cloudflare, but origin exposed. Repro in findings/guild-02/fuzz.md (F07 FAIL).

**A7. server/room-export-html.mjs:136 — deleted-message tombstone retains body in `walkExport` model** (g04, H3; BUG CONFIRMED post queued, cap hit)
The HTML renderer masks the body, but the exported message model still carries
sensitive text — privacy leak in exports. Fail-first regression verified
(9/9 green original, fails under mutant); repro on wave1000/guild-04
(findings/guild-04/regressions/reg-survived-mutants.test.js "H3").

**A8. Work-release E5/D4 round-binding is a no-op two ways (g06, BUG-3, BUG CONFIRMED posted)**
(1) `client.workRelease`/`releaseWorkItem` (client/room-agent.mjs:878/854) drop
`expectedClaimedAt`/`expectedHistoryLength` before HTTP (wire body `{"note":"n"}`);
(2) `POST /release` strict body accepts only `{note?, reason?}` and
server/work-claim-routes.mjs:1201 has no round comparison — fields 422 when sent.
So feed63746 + 6146ae702 claim a protection that doesn't exist; the release path
still silently releases stale rounds, and scripts/qa3/authz-board.mjs's release
action 422s with fields / 200s unbound. Fail-first:
tests/work-release-round-binding.test.js (3 assertions, verified failing).
Fix needs client/room-agent.mjs + server/work-claim-routes.mjs — cross-slice; flagged
for owning lane. NOTE cross-guild overlap: the wave300/fix5-release-compare branch
implements compare-and-release on release and needs a rebase (g05, g07, g20 all confirm
conflicts in server/work-claim-routes.mjs).

**A9. `wave300/sharded-claim-boards` new hazards (g20 re-verify, unmerged — merge blockers)**
H1: racy check-then-act `ALTER TABLE work_claims ADD COLUMN namespace` in
`createDurableWorkClaimRegistry` — outside any txn, no readOnly guard; concurrent
opens both observe absent column → second `ALTER` throws `duplicate column name`,
boot crashes; read-only open of a pre-shard DB attempts ALTER and fails. H2: PK
`(room_id, claim_id)` excludes namespace — cross-board same-id `set()` silently
moves the claim last-writer-wins (vanishes from first board's listing). Both
detailed in findings/guild-20/REVERIFY-REPORT.md.

**A10. Sweep settles a LIVE new round on a stale pre-txn GitHub observation (g20, RH-07 RACE CONFIRMED, cross-slice → guild-01)**
server/claim-pr-sync.mjs `commitPullRequestLookup`: sweep fetches GitHub state
pre-transaction, matches by URL only (no expectedClaimedAt token); T1 "closed"
observation settles round 2's live claim at T4 after re-link. Repro
`race-hunt/rh07.mjs`. Terminal-claim double-settle correctly refused (rh08 PASS).

### 🟠 MEDIUM — merge-blockers on unmerged branches (not prod bugs)

**B1. `wave300/fix5-release-compare` — REAL DESIGN FLAW: request_dedupe keyed by bare request_id, no room/member/route scoping** (g03, R4-1 MEDIUM)
server/request-dedupe.mjs `TEXT PRIMARY KEY` on bare `request_id`: two agents
(or one agent in two rooms) reusing the same string (e.g. "req-1") collide —
client B's mutation replays client A's stored result, B's intended write silently
skipped, B believes it succeeded (cross-room result leakage). Fix: scope key by
(roomId, memberId, route) or at minimum roomId. Should block merge.

**B2. `wave500/presence-w4-delta` (and w10) — boardSeq/?since= delta is inert against the production store** (g03, R9-1 HIGH-severity branch defect)
`boardSeq` stamping exists ONLY on the in-memory `createWorkClaimRegistry`;
production uses the durable sqlite registry (store.mjs:1119) with zero boardSeq
support → in prod every page reports `boardSeq: 0` and every `?since=` delta is
permanently empty. Tests pass only because they exercise the in-memory registry.
Must port stamping to the durable registry before merge. Also R9-2..R9-4 minors.
Cross-guild note: g08 found `guild-claimsboard/boardseq` branch clean (targeted suite) —
different branch lineage; the two must be reconciled to avoid duplicate work.

**B3. honest-backpressure branch (unmerged) — rate() semantic change breaks route-hardening L1 AND re-opens a documented privacy hole** (g02 reverify, 8 PASS / 2 TESTS_FAIL)
Its deliberate `rate()` no-rearm change conflicts with route-hardening L1
(contract conflict); and it weakens acquisition-page cache-control `no-store` →
`public, max-age=60`, re-opening the privacy hole on the receipts-toggle page.

**B4. Guild-claimsboard branch family re-verify (g08): 2 real branch bugs + 1 substantially broken branch**
- R01 guild-claimsboard-409-enrich: enriched 409 sets `.body` on ServiceError,
  tripping the catch at work-claim-routes.mjs:557 (returns JSON instead of
  throwing) — breaks the throw contract (work-claim-leases, work-claim-sqlite fail).
- R02 guild-claimsboard-compare-release: docs/openapi.yaml invalid YAML
  (YAMLParseError line 5146). R03 guild-claimsboard/lease-first: 711 pass /
  22 fail, 21 branch-caused — substantially broken. R10 lease-first-reaper:
  87/5 — breaks close/cancel event semantics and PR re-linking. R04–R09 clean.
  9 of 10 branches local-only (deleted from origin); all share a stale base.

**B5. `wave300/fix69-event-light-claims` — branch-internal inconsistency: read-contract change ships with stale tests** (g03, R5-1)
Default list view changed to summary projection (no history tails) but
tests/work-claims-read.test.js still asserts the old contract (2 failing tests on
its own tree). Author must update the test on rebase.

**B6. Scripts hang: `scripts/claims-index.mjs:71` + `scripts/merge-queue-dryrun.mjs:33` unbounded `gh api --paginate` subprocess** (g06, 2 REAL BUGS, BUG CONFIRMED posted)
`execFileSync("gh", …)` with no `timeout` — a stalled `gh` hangs the script
forever, unkillable except by signal. Same pattern at
scripts/merge-queue-eject-budget.mjs:232 (failingCheckRuns) — fix with the other
two. Fail-first: tests/gh-subprocess-timeout.test.js.

**B7. herdr-migrate journal bugs STILL OPEN (g05, already filed, no fix PRs)**
Torn journal line bricks the tool (`readJournal` AND `appendJournalEntry` both
throw — systemic halt, severity confirmed); no journal lock (30 parallel appends
→ 5 duplicate seq).

**B8. Agent-harness / replay test suites never execute in npm test (g18)**
All four replay-harness branches only run tests/harness.test.js via `npm test` —
27 replay/gate/trace/scrub tests never run (27/27 pass when run explicitly).
skill-harness perf gap: script-syntax phase has no timeout (300 scripts blew 120s).

**B9. No schedule-cron validation: overlap, every-minute, invalid 6-field crons all pass CI** (g16, m12 0/3 killed)
Fail-first: tests/jobs-scheduler-invariants.test.js (13 tests, all green) kills
13/13 critical mutants. Live corroboration: answer-engine-check.yml ≡
onboarding-probe.yml at `0 15 * * 1` (identical Monday schedules, no CI overlap guard).

**B10. Duplicated / stale-branch churn (g01, g02, g03, g04, g07, g08, g20)**
- elegant-* family: 8 branches carry only 3 distinct http.mjs diffs (will self-conflict);
  elegant-* also removes 62 input-validation checks from work-claims.mjs (g01) —
  validation parity must be re-verified if revived.
- 6 wave branches do NOT integrate with current main: fix5, fix12, fix18, fix69,
  sharded-claim-boards, elegant-server (rebase AND merge conflicts — stale).
- 11 branches silently drop `?messages=recent` snapshot windowing; 4 drop the
  `room_token_not_identity` honest-401 (g02) — likely stale-base reverts.
- presence's 3 failing tests are its own unimplemented W6 TDD tests (g02).
- wave300/fix5-release-compare needs a rebase (conflicts in server files) — confirmed
  independently by g05, g07, g20.
- g04 reverify: RV-2 fix69-event-light-claims SEMANTIC conflict
  (emitWorkClaimEvent main × emitWorkClaimEventRouted branch digest-batched
  redesign — needs owner reconciliation); RV-9 elegant-wcroutes-b stale vs QA-200
  (naive rebase regresses H4's improved 409s + E5 compare-and-release).

### 🟡 LOW / latent

- **C1. server/bounty-disputes.mjs:116** — minimum dispute bond `Math.floor(bountyAmount * 0.05)`
  slips UNDER the documented "at least 5%" (open({bountyAmount:21, bond:1}) accepted =
  4.76%); one-word fix `Math.ceil`; escrow's 25% bond uses ceil (unaffected);
  exposure < 1 milli-unit per dispute (g14).
- **C2. QA-200's invite_unavailable hint test FAILS ON MAIN** — agentErrorAx falls through to
  "Unknown error… Re-check access" (g16 r8; real stranger-facing bug with repro; outside slice).
- **C3. recordCommandOutcome re-maps full 15-min window per call** — 20k records ~30s,
  near-quadratic; ~1.5ms+ per /commands request at 20k occupancy (g11, latent).
- **C4. Per-stream pump saturates event loop at ~100 held streams** (eventsAfter O(members):
  2.6ms @1 → 24ms @100); degrades but never crashes; wave300 F1's shared pump addresses it (g12).
- **C5. server/wake-queue.mjs `enqueue()` accepts negative dueAt** — fail-first test FAILS on
  current code (live bug); `intentBytes` counts UTF-16 code units not bytes (~2x overrun
  with emoji) (g12).
- **C6. skill-harness lib/frontmatter.mjs `unquote`** — unclosed quote silently accepted as
  plain scalar, `frontmatter-parse` reports PASS (fail-open); fail-first tests skipped-pending-fix;
  perf gap: script-syntax phase no timeout (g18).
- **C7. server/analytics/schema.mjs:90-91 `columnExists()`** — 2 survived mutants unguarded by
  5 analytics suites; fail-first regression added to tests/analytics-derive.test.js (g09).
- **C8. server/channel-live-status.mjs:35 `key()`** — bare `String(connectionId)` throws raw
  TypeError on prototype-poisoned object instead of 422 (unreachable from wire) (g15).
- **C9. client `.done.json` files never pruned client-side** — unbounded disk growth for
  long-lived agents (server side prunes; client does not) (g07).
- **C10. reply-agent.test.js 1 failure pre-existing on clean origin/main** (env/timing) (g07);
  id-sec-http.test.js flaky 201-vs-403 in security-critical unverified-mint assertion —
  recommend detect-flaky (g09); messages-backfill.test.js 280s timeout needs investigation (g09).
- **C11. SAFETY_NET_CRON duplicates wrangler.jsonc truth** (drift risk); jobByName/SAFETY_NET_MS
  dead (g16).
- **C12. Bearer `<redacted>` → identical 401s** (known issue, verified) (g13).
- **C13. guild-04 S4/W4 test-gap postings**: dropping COMMIT in transaction() passes 22/22 tests
  (no commit-assertion); list() order (rowid ASC) unpinned (g04, posted) — suite holes, not prod bugs.
- **C14. guild-01 adversarial**: 9 test files / 62 validation checks removed by elegant-* branches;
  dead export workClaimRegistry (server/work-claim-routes.mjs:106, zero refs) (g01).
- **C15. guild-15 dead exports**: notConfiguredTelegram, startWebhookRotation,
  completeWebhookRotation, startGmailSync (zero callers); guild-11: TRIPWIRE_TICK_MS dead (g15, g11).

### Consolidated dead-code list (confirmed, zero refs)

| File:line | Symbol | Guild |
|---|---|---|
| server/work-claim-routes.mjs:106 | workClaimRegistry (export) | 01 |
| server/mcp-http.mjs:217 | roomMcpFetchPost | 03 |
| telemetry (server/tripwires.mjs) | TRIPWIRE_TICK_MS | 11 |
| (4 exports) | notConfiguredTelegram, startWebhookRotation, completeWebhookRotation, startGmailSync | 15 |
| workflows slice | jobByName, SAFETY_NET_MS | 16 |
| server/attachments.mjs:40 | createDownloadTracker (dormant, zero prod callers) | 19 |

## PART B — dedup map (same defect reported by ≥2 guilds)

| Canonical defect | Guilds | Status |
|---|---|---|
| guest-invite/referral email-gate funnel deadlock | 13 (BUG), + hardwork-sec/referral-email-gate R5 | open; referral branch would reopen |
| wave300/fix5-release-compare stale/conflicts | 05, 07, 20 | branch needs rebase |
| work-release round-binding no-op (claims feed63746+6146ae702 don't protect) | 06 (BUG-3) + fix5 branch (implements compare-and-release) | open on main; branch implements fix but stale |
| boardSeq inert on durable registry (presence branches) | 03 (R9/R10) + 08 (R07 clean targeted) | conflicting branch lineages; reconcile |
| 409-enrich throw-contract break | 08 (R01) + 04 (RV-9 H4 improved-409s regression risk) | branch bug |
| exfil hole open | 17 (re-verified) | tracked, unmerged fix |
| herdr-migrate journal torn/no-lock | 05 (still open) | filed, no fix PR |
| reply-agent.test.js pre-existing fail | 07 (verified on main) | env/timing |
| ?messages=recent dropped / honest-401 dropped | 02 (11 branches) | stale-base reverts |
| elegant-* duplicated work / validation removal | 01, 02 | self-conflict risk |

## PART C — per-guild verdicts (one line each)

| G | Verdict |
|---|---|
| 01 | 0 bugs; 3 test gaps closed (fail-first); slice clean; 6 wave branches stale vs main |
| 02 | 0 bugs in slice; slowloris NOT bounded (HIGH A6); honest-backpressure branch re-opens privacy hole (B3) |
| 03 | 0 bugs in slice; R4-1 request-dedupe scoping flaw (B1); R9-1 boardSeq inert (B2); R5-1 branch-internal test staleness (B5); dead func roomMcpFetchPost |
| 04 | 3 BUG CONFIRMED posted (S4, W4, P3) + H3 tombstone-privacy (A7); 0 fuzz fails |
| 05 | 0 new bugs; 2 filed herdr-migrate bugs still open (B7); fix5 needs rebase |
| 06 | 2 REAL BUGS (unbounded gh hang, B6) + BUG-3 work-release round binding (A8); 0 mutation bugs |
| 07 | 0 bugs; robustness notes; client .done.json unbounded growth (C9); fix6 merged #2139 |
| 08 | 3 BUG CONFIRMED posted (claim-coordination:109, work-claim-routes:191, events.js:2172); re-verify: R01/R02/R03/R10 branch bugs (B4) |
| 09 | 1 BUG CONFIRMED (columnExists, C7); 2 baseline-red suites need attention (C10) |
| 10 | 0 bugs; 11 family pages, 229 modules documented; 13 stale claims fixed |
| 11 | 0 bugs; 7 survived mutants all test gaps; recordCommandOutcome quadratic (C3, latent) |
| 12 | 2 low bugs live (negative dueAt, intentBytes C5); pump saturation @100 streams (C4) |
| 13 | 1 BUG CONFIRMED (guest-invites:460 mail deadlock, A3); fuzz 20/20 pass |
| 14 | 1 REAL BUG low (bond floor, C1); 26/26 property tests green; money math sound |
| 15 | 0 live bugs; 1 low key() TypeError (C8); 4 dead exports (C15) |
| 16 | 0 bugs; no cron validation (B9); r8 stranger-facing hint failure on main (C2) |
| 17 | 0 new bugs; exfil hole OPEN (A2); 31/31 workflows audited, 100% SHA-pinned |
| 18 | 1 BUG CONFIRMED low (frontmatter fail-open, C6) + replay tests never run in npm test (B8) |
| 19 | 0 bugs; 709 hostile inputs, 0 confirmed; 1 dormant export |
| 20 | 3 RACES CONFIRMED (A1 instance-lock double-hold, A10 sweep stale-settle); sharded-claim-boards H1/H2 (A9); 17 race units pass |

## PART D — counts

- Real bugs confirmed (live on main or adjacent repo): **14** — A1 (2 interleavings, 1 race),
  A3, A4, A5 (+2 sibling boundary bugs), A6, A7, A8, A10, B6 (2 bugs + 1 pattern),
  C1, C5 (2), C6, C7, C8 — all with repros or fail-first regressions on the source branches.
- Merge-blocker branch defects: **B1, B2, B3, B4 (R01/R02/R03/R10), B5, A9 (H1/H2)**.
- Test gaps closed with fail-first regressions across the wave: **~40** (mutations) + 20
  deliberate-break hardenings (g08) + 11 property tests (g14).
- Dead exports confirmed: **10**.
- Duplicated/stale-branch churn items: **10** (dedup map).

## PART E — repro index

| Defect | Repro location |
|---|---|
| A1 instance-lock double-hold | wave1000/guild-20: race-hunt/rh01.mjs, rh02.mjs |
| A3 guest-invite deadlock | wave1000/guild-13: findings/guild-13/guest-invites-mail-unconfigured.test.js |
| A4 pin leak | wave1000/guild-04: findings/guild-04/regressions/reg-survived-mutants.test.js "P3" |
| A6 slowloris | wave1000/guild-02: findings/guild-02/fuzz.md F07 |
| A7 tombstone body | wave1000/guild-04: findings/guild-04/regressions/reg-survived-mutants.test.js "H3" |
| A8 release binding | wave1000/guild-06: tests/work-release-round-binding.test.js |
| A10 sweep stale-settle | wave1000/guild-20: race-hunt/rh07.mjs |
| B1 dedupe scoping | wave1000/guild-03: findings/guild-03/reverify-R4.md R4-1 |
| B2 boardSeq inert | wave1000/guild-03: findings/guild-03/reverify-R9.md R9-1 |
| B4 409-enrich branch bug | wave1000/guild-08: reverify.md R01 |
| B6 gh hang | wave1000/guild-06: tests/gh-subprocess-timeout.test.js |
| C1 bond floor | wave1000/guild-14: findings/guild-14/regressions/g14-reg-dispute-bond-min-failfirst.test.js |
| C5 wake negative dueAt | wave1000/guild-12: findings/guild-12/regress/enqueue-negative-dueat.test.js |
| C6 frontmatter fail-open | 7d34f95bb (skill-harness): tests/mutant-reg-frontmatter.test.js (skipped) |

---
**Head SHA (wave2000/guild-40):** filled at commit time below. Report only — no code
changes, no PRs, no main pushes, no production writes.
