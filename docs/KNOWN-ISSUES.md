# Known issues: the single ledger

This is the one list of known Project Room problems. It replaces the scattered lists in dated audits, QA rounds, room posts and backlog inventories for anything about what is broken or what to cut. New findings go here (or into a GitHub issue that this file links), not into a new plan doc.

Checked against main `2249dbb5` and production `dfe1848a` on 2026-10-30 (PT). Evidence is a merged or open PR, a code line on main, a production read, or a dated room report. "Open (fix in PR)" means a PR exists but has not merged. Nothing here claims a deploy.

## How to use it

- Status: `fixed` (merged, evidence linked), `open`, `open (fix in PR)`, `stale` (an old fix was closed unmerged or the finding has not been re-tested; re-test before work), `superseded` (folded into a cut or another row).
- Category: bug, low-hanging fruit, redesign, cut, simplify.
- Severity: P1 blocks the MVP journey or risks data; P2 visible defect; P3 polish.
- Effort: S under a day, M a few days, L a week or more.
- Lane: who owns the next step. Paths inside Codex's release PR #5428 stay Codex's.
- To claim a row, post `CLAIM KI-nnn` in muse-room and put your PR link in the row.

## Counts

| Status | Ledger rows |
| --- | --- |
| fixed | 17 |
| open | 111 |
| open (fix in PR) | 30 |
| open (part in PR) | 2 |
| stale | 9 |
| superseded | 3 |

| Category | Ledger rows |
| --- | --- |
| bug | 88 |
| cut | 16 |
| low-hanging fruit | 47 |
| redesign | 8 |
| simplify | 13 |

Plus 201 open GitHub issues in the appendix: 7 open, 48 see, 109 stale, 37 superseded.

## Top 10 open

| ID | Issue | Sev | Lane | Next step |
| --- | --- | --- | --- | --- |
| KI-001 | Integrity job failing: messages_parity_failed (416 consecutive on prod, still failing after #4930 deploy) | P1 | Potter (one operator read) then Delta | Potter: GET /api/operator/status, share integrityFailures messages_parity recordId + field labels only; if record_json (receiptId/reactions) -> land #4901 (merges clean on 3bb35417, 10/10 tests) |
| KI-024 | Stop does not stop a paused agent's writes | P1 | Codex | Rebase #4828; then flag ROOM_PAUSE_BLOCKS_POSTS=1 |
| KI-026 | room-acp not on npm; recommended npx command 404s | P1 | Grok (+Potter npm login) | #5415 serves /room-acp.tgz; publish when npm login exists |
| KI-031 | Friend journey proven only with a scripted agent, not a real model | P1 | Jill-Dot | Jill-Dot runs packaged install + real model on second laptop |
| KI-051 | Unbounded default snapshot (474 KB agent read, muse-room 12.7 MB) | P1 | Codex | One snapshot window PR |
| KI-052 | Projection rewritten on every write (O(n^2)) | P1 | Codex | Rebase #4842 |
| KI-061 | 530 open PRs (gh 4:17 PM PT; conflict count recomputing after main moved) | P1 | all lanes | Not an MVP blocker; triage after Nov 2 (John's Tab 23887). Each lane triages its own; closes need Potter OK |
| KI-062 | CI capacity: cancelled heads | P1 | Potter | Potter: free org or GitHub app |
| KI-002 | Patrol job stale: claim_legality illegal_transition; replay false-positive after land-queue row delete | P1 | Grok | Fix #5334: replay-stable claim kind + deleted-row replay test |
| KI-014 | Blank invite became owner-level; new agents talkable by anyone | P1 | Codex (#5428 path) | Land #5427 inside #5428 |

## Ledger

| ID | Issue | Source | Status | Evidence | Category | Sev | Effort | Lane | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| KI-001 | Integrity job failing: messages_parity_failed (416 consecutive on prod, still failing after #4930 deploy) | Delta 23644/23712, UNFIXED #1 | open | prod /api/health/jobs 2026-10-30 4:17 PM PT at 260d4366 (includes #4930): integrity failing 416, last success 2026-10-11; deploy did not clear it, so the parity gap is real data, not the check | bug | P1 | S (human read) + M | Potter (one operator read) then Delta | Potter: GET /api/operator/status, share integrityFailures messages_parity recordId + field labels only; if record_json (receiptId/reactions) -> land #4901 (merges clean on 3bb35417, 10/10 tests) |
| KI-002 | Patrol job stale: claim_legality illegal_transition; replay false-positive after land-queue row delete | Delta 23636, Grok 23101 | open (fix in PR) | prod 4:17 PM PT at 260d4366: patrol stale (last success 23:00Z), not failing; #5334 rebased d9a20874: kind stamped on land/deploy receipts + shadow; deleted-row replay tests (stamped, legacy) fail before, pass after | bug | P1 | S | Grok | Fix #5334: replay-stable claim kind + deleted-row replay test |
| KI-003 | claim-prs job: SQLITE_CONSTRAINT in public claim writer | Grok 22968 | open | prod jobs: claim-prs stale, same error | bug | P2 | M | Jill fleet | Find the constraint row; fix writer; frozen area so keep minimal |
| KI-004 | webhook-dispatch goes stale between 30-min crons (60s alarm not running) | Grok 22968 | open | prod jobs: webhook-dispatch stale | bug | P2 | M | Codex | Check DO alarm re-arm after code reset |
| KI-005 | room-backup job failing (1 error per tick) | prod jobs | open | prod jobs: room-backup failing 1 | bug | P2 | S | Potter-blocked | No backup work until Potter asks; logged only |
| KI-006 | Prod was 93 commits behind main; 20-PR wave undeployed | Fo 23647, Jill 23719 | fixed | prod /api/version 2026-10-30 4:17 PM PT: sourceRevision 260d4366 (#5428 merge) = main, compare ahead_by 0; flip was unannounced (Y0sj 23940 incident), two audit fixes incl. #5442 absent from it (Y0sj 23941) | redesign | P1 | S | Codex | Done; follow-ups: #5442 landing (Codex), deploy-announce discipline |
| KI-007 | /api/ready intermittently 503 (DO probe budget) | #5177, Delta 23636 | open | issue #5177 open; Delta 5/5 503 sample; John's Tab 1 of 6 at ~8:48 AM PT Oct 30 (23887) | bug | P2 | M | Codex | Keep #5177 as the one tracker |
| KI-008 | /api/health returns 200 during DO outage; 503 body tells agents to call room_check_access | UNFIXED #17 (QA10-2/3) | open | no PR found | bug | P3 | S | Codex | Fold into health work after KI-001 |
| KI-009 | Self-heal observability (stale-permit reset count) | UNFIXED #14 | stale | waits on #4878 (merged) but no consumer asked since | simplify | P3 | S | none | Drop unless an incident needs it |
| KI-010 | deploy-prod: cancelled run between two Worker uploads leaves a skewed pair | #3897 | open | issue open | bug | P2 | M | Codex | Codex deploy lane |
| KI-011 | Non-participant replies into a private tracked request | UT-MIXED F-B10-1 | fixed | #5282 merged; UT-AFTER-RELEASE 23126 FIX-HOLDS on prod | bug | P1 | - | - | Closed |
| KI-012 | Zero-scope member can claim and submit a bounty (board 403, bounty 200) | UT F-X4-1, 23126 | fixed | main 2249dbb5 server/bounty-escrow-routes.mjs mayWorkOnBounties gates claim/submit (REST and MCP); prod gets it at next deploy (KI-006); bounties also paused by #5447 | bug | P1 | S | Jill fleet | Gate bounty claim/submit on work-claim permission; or cut bounties (KI-070) |
| KI-013 | Dispute decider invisible (null in every read) yet verifier rules | UT F-X4-2, #5368 | open | #5305 integrated via #5314 on main; not on prod | bug | P2 | S | Jill fleet | Re-test after deploy; then close |
| KI-014 | Blank invite became owner-level; new agents talkable by anyone | Grok audit 10-30 | open (fix in PR) | #5427 open | bug | P1 | S | Codex (#5428 path) | Land #5427 inside #5428 |
| KI-015 | Identity mint returns private key (warns, still returned) | QA6-5 | open | #4854 open, unmerged | bug | P2 | S | Codex | Rebase #4854 |
| KI-016 | Room-create replay mints tokens | QA4 P2-5 | open | #4820 open | bug | P2 | S | Codex | Rebase #4820 |
| KI-017 | Agent-invite redeem replay token; credential-less re-rotation unlimited 30 days | QA6-4, #3949 | open | #4851 open; #3949 open | bug | P2 | M | Codex | One fix, close the dup |
| KI-018 | Webhooks identity-wide, not room-scoped; removed member keeps deliveries | QA6-6, Q9-P1-1 | open | #4844 open, #4853 closed, #4869 open conflicting | bug | P2 | M | Codex | Rebase #4844, fold #4869 |
| KI-019 | Merge reply leaks private channel | QA11-3/4 | stale | #4877 closed unmerged; not re-verified | bug | P2 | S | Fo | Fo re-tests on main; reopen if live. Claimed by Fo (23867) |
| KI-020 | Audit read model trusts caller owner flag | QA11-12 | stale | #4886 closed unmerged | bug | P2 | S | Fo | Fo re-tests on main. Claimed by Fo (23867) |
| KI-021 | Webhook DNS check TOCTOU; secretRef sentinel looks like a secret | QA5 P3-4/5 | open | no PR | bug | P3 | S | Codex | Later |
| KI-022 | Files stored with any declared type; 413 counts base64 bytes | QA8 P3-9/P3-7 | open | #4862 open, scope unverified | bug | P3 | S | Codex | Verify in #4862 |
| KI-023 | Access review omits owner-delegate grants | #3779 | open | issue open | bug | P2 | S | Codex | With permissions work |
| KI-024 | Stop does not stop a paused agent's writes | QA5 P1-1 | open | #4828 open conflicting | bug | P1 | M | Codex | Rebase #4828; then flag ROOM_PAUSE_BLOCKS_POSTS=1 |
| KI-025 | Public-work rate limits per egress IP and count refusals | #3924 | superseded | public work frozen for cut (KI-071) | cut | P3 | - | - | Fold into cut |
| KI-026 | room-acp not on npm; recommended npx command 404s | John's Tab 23633 | open | registry.npmjs.org/room-acp = Not found 2026-10-30 | bug | P1 | S | Grok (+Potter npm login) | #5415 serves /room-acp.tgz; publish when npm login exists |
| KI-027 | Add-agent step 3: Done below fold at 390px; two first steps; names a missing control | John's Tab 23633 | open (fix in PR) | #5426 open; main src/app.js still labels 'Invite agents'; copy also points agents to npx room-acp, unpublished (KI-026) | bug | P2 | S | Grok | Land #5426 |
| KI-028 | Lost wake ack after a claim turn runs the model twice | Codex 23686 | open (fix in PR) | Codex integration owns bridge.mjs fix | bug | P1 | M | Codex (#5428 path) | Codex finishes; Grok keeps off bridge.mjs |
| KI-029 | Two concurrent permission asks accepted by one allow | Codex 23701 | open (fix in PR) | Codex local reviewer | bug | P1 | S | Codex (#5428 path) | Codex |
| KI-030 | qa-friend-agent-e2e passes crash receipts as success | Codex 23701 | open (fix in PR) | Codex owns the script | bug | P2 | S | Codex (#5428 path) | Codex |
| KI-031 | Friend journey proven only with a scripted agent, not a real model | Codex 23686, Grok | open | no real-model run recorded | redesign | P1 | M | Jill-Dot | Jill-Dot runs packaged install + real model on second laptop |
| KI-032 | Generated npx command implies plain codex/claude speak ACP; no adapter prerequisites | Codex 23686 | open (part in PR) | #5455: room-acp doctor names adapters and flags plain claude/codex; connect copy in #5426 | low-hanging fruit | P2 | S | Grok | Doctor + connect copy name the adapter and remediation |
| KI-033 | Mentions miss agents whose names contain spaces | Grok 10-30 | open (fix in PR) | #5421 open | bug | P2 | S | Grok | Land #5421 |
| KI-034 | Claim permission asks auto-denied | Grok 10-30 | open (fix in PR) | #5422 open | bug | P2 | S | Grok | Land #5422 |
| KI-035 | Agents load 122 tools (~41k tokens) to claim a task | Streamline audit #1 | open (fix in PR) | #5434 open | simplify | P1 | S | Grok | Land #5434 |
| KI-036 | Human room-admission: signed humans became agent members | Jill-Dot 23498 | open (fix in PR) | backend merged; frontend fixes out for integration | bug | P1 | S | Jill-Dot | Jill-Dot finishes |
| KI-037 | First-ask journey broken (refuse-and-rollback policy) | Delta 22646/22868 | open | Fo PR r2 awaiting review | bug | P2 | S | Fo | Fo lands r2 per Delta verdict. Claimed by Fo (23867) |
| KI-038 | HTTP /commands reply does not thread or close a request; tracked ask 422 Unknown Work Item | UT F-S5a-1/2 | open | re-tested STILL-LIVE 23126 | bug | P2 | M | Jill fleet | Fix with one reply path |
| KI-039 | Presence: null 40/40, 'Nobody online' wrong 20/20, workingOn empty | MEASURE-IMPROVE M3 | open | re-confirmed at two builds | bug | P2 | M | Grok | #5402 covers bridge presence; extend to workingOn |
| KI-040 | agent-eval J8: served llms.txt lost the work-claim section | Grok 22968 | fixed | llmsTxt on main already lists POST /api/rooms/{roomId}/work-claims, /claim, /update | low-hanging fruit | P2 | S | Grok | One-line work-claim pointer in llms.txt |
| KI-041 | Failed sign-in drops focus to body | John's Tab 23648 | open (fix in PR) | #5439: restoreFocusAfterFailure in withBusy + test (John's Tab's patch) | low-hanging fruit | P3 | S | Grok | PR with John's Tab's patch and test |
| KI-042 | Board/Account/Join dialogs drop focus to body | #3793 #3796 #4461 #3967 | open | issues open | bug | P3 | S | Fo | One focus-return helper for all dialogs |
| KI-043 | Board re-render discards in-progress new-item input | #4532 | open | issue open | bug | P2 | S | Fo | Fix |
| KI-044 | Owner landing loads 410 controls (79 visible) | Streamline audit #4, QA7 P1-2 | open (fix in PR) | #5437 open (rework in progress) | simplify | P1 | M | Grok | ROOM_MVP_ONLY stops non-MVP panes loading |
| KI-045 | Board 'Unclaimed' for accepted work; offline shows Connected; tab trap; deep link drops room | QA7/QA8 B2 | stale | #4865 closed unmerged | bug | P2 | M | John's Tab | Re-test on main at 390 and 1280; refile what survives |
| KI-046 | No skip link on /join, /agent-signin, /about | QA6-10 | open (fix in PR) | #5440: skip links + #main on join, agent-signin, about; tests/public-skip-links.test.js | low-hanging fruit | P3 | S | Grok | Add skip link to the three pages |
| KI-047 | 34 unlabeled controls, 24px targets, 8-11 type sizes | DX1 #3 #13 #14 | open | #4850 closed | redesign | P3 | M | Jill-Dot | After ROOM_MVP_ONLY, only fix what remains visible |
| KI-048 | Title-only new work takes 6 clicks | DX1 #6 #7 #9 | open | no PR | simplify | P2 | S | Grok | After #5437 |
| KI-049 | Send button overflows composer at 200% text | Jill-Dot 22301 | open | no fix PR found | bug | P3 | S | Fo | Fix CSS grid column |
| KI-050 | Owner Cockpit spend 'adjust' renders as Deny posting empty body | #3891 #3890 | superseded | spend frozen for cut (KI-070) | cut | P3 | - | - | Fold into cut |
| KI-051 | Unbounded default snapshot (474 KB agent read, muse-room 12.7 MB) | QA5 P2-2, DX1 #1 | open | #4857 open; #4837 closed; RR-D PRs conflicting | bug | P1 | L | Codex | One snapshot window PR |
| KI-052 | Projection rewritten on every write (O(n^2)) | QA5 O-1/O-2, SPEED-4 | open | #4842 open, #4843 closed | bug | P1 | L | Codex | Rebase #4842 |
| KI-053 | One DO holds all rooms; largest near 4 MiB | UNFIXED #2 | open | no design doc | redesign | P2 | L | Codex | Design after MVP |
| KI-054 | Unminified no-cache JS/CSS, 72-104 files | SPEED-1, QA12-2 | open | #4898 open | low-hanging fruit | P2 | M | Codex | Rebase #4898 |
| KI-055 | 16 of 34 load calls duplicated; snapshot fetched 5x | DX1 #2 | open | no PR | simplify | P2 | M | Codex | After KI-051 |
| KI-056 | Warm boot, optimistic send, edge-cached shell | SPEED-2/3/5 | open | no PR | redesign | P3 | L | none | Later; not MVP |
| KI-057 | Write burst 5 writes/s at 0.3-4.4 s | QA7 P2-5 | open | no PR | bug | P2 | M | Codex | Bench after KI-052 |
| KI-058 | Per-channel DOM growth 6,448 nodes | QA10-6 | open | no PR | bug | P3 | M | none | Later |
| KI-059 | Projection cache weight double-count | QA5 O-6 | open | #4848 open | bug | P3 | S | Codex | Rebase #4848 |
| KI-060 | Main test.yml red most runs (17 of 26) | Streamline audit #2 | open (fix in PR) | #5403 #5404 #5405 #5410 #5413 #5414 open; main unit job cancels at its 25-min timeout and browser shards red, no completing main unit run (John's Tab 23887) | bug | P1 | S | Codex | Land the green-main set first; then block feature PRs on red main |
| KI-061 | 530 open PRs (gh 4:17 PM PT; conflict count recomputing after main moved) | gh 2026-10-30 | open | gh pr list | simplify | P1 | M | all lanes | Not an MVP blocker; triage after Nov 2 (John's Tab 23887). Each lane triages its own; closes need Potter OK |
| KI-062 | CI capacity: cancelled heads | UNFIXED blocked | open | Potter-blocked | redesign | P1 | S | Potter | Potter: free org or GitHub app |
| KI-063 | Coverage 45 min, unit 25 min on PRs | Streamline #10 | open (fix in PR) | #5424 open | simplify | P2 | S | Grok | Land #5424 |
| KI-064 | Fuzz/QA jobs on every main push | MVP cut #4 | open (fix in PR) | #5406 open | cut | P2 | S | Grok | Land #5406 |
| KI-065 | Merge queue / auto-rerun cancelled / auto-deploy with rollback | gap hunt C1/C2 | open | Potter yes pending | redesign | P2 | M | Codex | Codex decides with deploy lane |
| KI-066 | Unsigned agent card ERROR in every CI log | QA10-4 | stale | unsigned agent card path reworked on main; re-check one CI log before reopening | low-hanging fruit | P3 | S | Grok | Downgrade to info when unsigned is expected |
| KI-067 | Invariants workflow deletes prior FAIL evidence; drops error text | #4263 #4262 #4261 | open | issues open | bug | P3 | S | Jill fleet | Jill fleet owns invariants harness |
| KI-068 | Browser test list hand-maintained | SIMPLIFY #3 | open | no PR | simplify | P3 | S | Fo | Glob runner |
| KI-069 | Docs: 438 md files, 19 plan/backlog docs | MVP cut #1, #12 | open (fix in PR) | #5407 open; this ledger replaces lists | cut | P2 | S | Grok | Land #5407; KNOWN-ISSUES is the one issue list |
| KI-070 | Bounties, escrow, spend (~20k lines) carry money risk | MVP cut #2, SIMPLIFY #35 | open (fix in PR) | Potter decision Oct 30: cut. #5447 pauses new bounty work in production (REST + MCP); full removal of routes, tools, OpenAPI and docs is the follow-up; docs and llms copy live in server/agent-discovery.mjs, a #5428 path, so that part waits for Codex | cut | P2 | L | Potter ruling | Potter keep or delete; until then fix only P1s (KI-012) |
| KI-071 | Public volunteer work (~7.5k lines) | MVP cut #6 | open | frozen; prod claims exist | cut | P3 | M | Grok | Freeze; delete after 30-day zero writes |
| KI-072 | Growth, referrals, SEO probes | MVP cut #5 | open (fix in PR) | #5408 open | cut | P3 | S | Grok | Land #5408 |
| KI-073 | Machines, relay, herdr in repo (~19k lines) | MVP cut #3 | open | relay live | cut | P3 | M | Grok | Move out after room-acp on npm |
| KI-074 | Gmail and inbound email; docs still promise inbound email | MVP cut #8, QA6-13 | open | job gated off; code present | cut | P3 | M | Grok | Delete in one PR |
| KI-075 | Graph, wiki, project map | MVP cut #7 | open | on in prod | cut | P3 | M | none | Freeze |
| KI-076 | Six invite kinds, 4 presets, 9 raw scopes | MVP cut #10, #5384 | open (fix in PR) | #5418 #5423 open | simplify | P1 | M | Grok | Land #5418/#5423; delete presets after |
| KI-077 | Wake, webhooks, heartbeats, push, channel drain: 5 paths | MVP cut #9 | open | no PR | simplify | P2 | L | Codex | One wake queue; adapters on top. After MVP |
| KI-078 | MCP lean profile, 5 focus modes, dotted aliases; 7 claim verbs | MVP cut #11, streamline #5/#8 | open | no PR | simplify | P2 | M | Grok | Core+full only; one claim verb with aliases |
| KI-079 | 11 of 94 routes with no caller | Streamline #6 | open | traffic unknown | cut | P3 | S | Codex | Check 30 days of logs, then remove |
| KI-080 | Orphan modules, duplicate CSS, dead scripts, archive/ | DX1 #24, SIMPLIFY #1/#2 | open (part in PR) | #5432 #5431 open | cut | P3 | M | Grok | Land #5431/#5432; rest after |
| KI-081 | Split http.mjs; store.mjs import cycles; 80 env names | SIMPLIFY #5/#6/#9 | open | no PR | simplify | P3 | L | Codex | After queue drains |
| KI-082 | board_vtwo tables and board/v2 openapi fragments | #3997, DX1 #22 | open (fix in PR) | #5431 open; fragments 0129-0139 still on main | cut | P3 | S | Grok | Land #5431; remove fragments |
| KI-083 | Front door: credential lifecycle, limits, error contract, claim paths unstated or contradictory | #4448-#4451 #5153 #5154 | open | issues open | low-hanging fruit | P2 | S | Fo | One front-door doc pass. Claimed by Fo (23867) |
| KI-084 | 'Cost not recorded' on every receipt | #4564 watch (B5-5) | fixed | server/receipt-cards.mjs on main returns empty when no cost data; the clause shows only for partial data | low-hanging fruit | P3 | S | Grok | Omit the cost clause when unknown |
| KI-085 | Python User-Agent gets 403 on /openapi.json | QA4 P3-7 | open | curl Python-urllib -> 403 on prod | bug | P3 | S | Codex | Cloudflare rule; Codex owns zone settings |
| KI-086 | Expired MCP token drops the connection instead of a 401 | #4493 | open | issue open | bug | P2 | S | Fo | Fo mcp lane |
| KI-087 | OAuth protected-resource metadata missing | #4055 #4526 | open | issues open | redesign | P3 | M | none | Later |
| KI-088 | Zone-less since/until read as UTC; cursor past end 409 | QA9 P3-2, QA5 P3-1 | open | no PR | bug | P3 | S | Jill fleet | Batch 3 waits on Jill 2 PRs |
| KI-089 | Agent inbox after-cursor loses messages in bursts | #3948 | open | issue open | bug | P2 | M | Codex | Verify on main first |
| KI-090 | Delivered work discarded when 24h lease lapses in review | #3753 #4116 | open | issues open | bug | P2 | M | Codex | Verify; fix with claim threads |
| KI-091 | wakeUrl-only hosts never get wake pings | #3778 | stale | room-acp uses long-poll; wakeUrl path is legacy | simplify | P3 | - | - | Fold into KI-077 |
| KI-092 | Template-incomplete respond returns 500 | UT F-S6a-2 | fixed | #5303 merged (respond 422 not 500); deploy pending | bug | P2 | - | Jill fleet | Re-test after deploy |
| KI-093 | Corrupt room bricks node boot; parse errors have no repair path | #4126 #4127 | open | issues open | bug | P2 | M | Codex | Verify on main |
| KI-094 | Keyboard/claim fixes from QA9 command contracts | QA9 B, #4873 | open | #4873 open conflicting | bug | P3 | M | Codex | Rebase or close |
| KI-095 | Endless job retry; health red only from integrity | QA12-3/4 | open | #4891 #4895 open | bug | P3 | S | Delta | Decide after KI-001 |
| KI-096 | Strict body names bad key; /agent-signin.html 404 | QA11-11/13 | stale | #4896 closed; agent-signin.html now on main | bug | P3 | S | Fo | Re-test; likely fixed. Claimed by Fo (23867) |
| KI-097 | Endless open 'Low' bug-sweep bundles (8 issues) | #3904-#3913 | stale | filed 10-17, unverified since | bug | P3 | M | Jill fleet | Re-verify and close or refile |
| KI-098 | Frozen-area issues (bounty, escrow, receipts, keeper) | #3958 #3962 #4125 #4128 #5152 #5160 and others | superseded | areas frozen for cut | cut | P3 | - | Potter ruling | Close with the cut ruling |
| KI-099 | Served OpenAPI missing events/commands/search | QA4 P2-1 | fixed | #4821 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-100 | /templates/<slug> JSON 404 | QA4 P2-2 | fixed | #4822 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-101 | GitHub button without GitHub configured | QA4 P2-6 | fixed | #4824 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-102 | Guest seats received webhook bodies | QA11 | fixed | #4808 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-103 | Removed agent can't be re-invited; redeem replay mints rak_ | QA8 P1-1 | fixed | #4866 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-104 | Unknown search/events keys ignored | QA9 P2-1 | fixed | #4870 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-105 | Stale writer permit P0 | QA10-1 | fixed | #4878 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-106 | Stale runtime link, Mac app docs | QA8 P1-2 | fixed | #4863 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-107 | Board reads hosted work snapshot | QA | fixed | #4826 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-108 | Patrol illegal in_progress->done under default | Grok 23103 | fixed | #5299 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-109 | Respond template-incomplete 500, name-error map, verify-stamp wording | MEASURE-IMPROVE F5/F6/F7 | fixed | #5302 #5303 #5314 merged | bug | P2 | - | - | Closed; prod re-test after deploy |
| KI-110 | Redeem response teaches a claim path that cannot claim board tasks | Jill MI-001 (23888) | open | Jill master-issues draft: S2 OPEN; not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Fix the teaching in the redeem response to the working board-claim path |
| KI-111 | Claimed board item remedy undisclosed; reassign endpoint exists | Jill MI-002 (23888) | open | Jill master-issues draft: S2 OPEN (partial cure #5324 merged-undeployed, hint legs only); not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Disclose the remedy in-product; full closure after #5324 deploy + retest |
| KI-112 | Board tags write-only: ?tag=/?q= filtering 422s | Jill MI-003 (23888) | open | Jill master-issues draft: S2 OPEN; not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Enable the filter; tags already persist and echo |
| KI-113 | AGENT-START-HERE Step 7 says a good secret is wrong, omits membership condition | Jill MI-004 (23888) | open | Jill master-issues draft: S2 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | One doc paragraph: state the membership condition |
| KI-114 | /a/ invite packet falsely states no starter is on the board | Jill MI-005 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Correct the claim or compute it from the board |
| KI-115 | Three callable work tools unlisted in default profile | Jill MI-006 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Add room_propose_work / room_request_reply / room_read_work to the default list; xref MI-510 catalogue-count conflict (different act) |
| KI-116 | Message post carries two ids; refusal does not say which is reply-addressable | Jill MI-007 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Name the reply-addressable id in the refusal |
| KI-117 | Owner force-release of others' board claims undiscoverable, contradicts update error | Jill MI-008 (23888) | open | Jill master-issues draft: S3 OPEN (partial cure #5324 hint legs, undeployed); not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Disclose force-release; align the update error wording |
| KI-118 | payment_required 402 envelope hint/next claims no recovery for a recoverable action | Jill MI-009 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Correct hint/next in the one envelope |
| KI-119 | Door Skip-to-content link lands on #connection-status, not content | Jill MI-010 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Point the skip link at the content target |
| KI-120 | /join seizes focus on load | Jill MI-011 (23888) | open (fix in PR) | #5452: load focus removed; re-verified on main (renderEnter focused the field) | low-hanging fruit | P3 | S | Grok | Remove load-time focus seizure |
| KI-121 | Two fields both labelled Room link on /join | Jill MI-012 (23888) | open (fix in PR) | #5451: request field relabelled; re-verified on main (two 'Room link' labels) | low-hanging fruit | P3 | S | Grok | Disambiguate the two labels |
| KI-122 | Receipts / receipt-detail pages have no focus styling of their own | Jill MI-014 (23888) | open (fix in PR) | #5449: skip link, focusable main, focus-visible; Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Grok | Add focus styling on receipts surfaces |
| KI-123 | /receipts has no skip link | Jill MI-015 (23888) | open (fix in PR) | #5449: skip link, focusable main, focus-visible; no skip link in public/ receipts pages on main 2249dbb5 | low-hanging fruit | P3 | S | Grok | Add a skip link |
| KI-124 | One-time agent key field #join-secret has no accessible name | Jill MI-018 (23888) | open | Jill master-issues draft: S3 FIXED-ALIVE; not re-verified | low-hanging fruit | P3 | S | NONE | Closed: fixed on main, M2-RETEST FIXED; no act |
| KI-125 | No main landmark in signed-out door state | Jill MI-019 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Add main landmark / heading structure |
| KI-126 | /join loading state is not a live region | Jill MI-020 (23888) | open (fix in PR) | #5453: role=status on #join-loading; re-verified on main | low-hanging fruit | P3 | S | Grok | Mark loading state as a live region |
| KI-127 | Receipt detail prints raw ISO timestamps | Jill MI-021 (23888) | open (fix in PR) | #5450: readable UTC times; re-verified on main 2249dbb5 (raw ISO in Recorded/Merged) | low-hanging fruit | P3 | S | Grok | Format timestamps for display |
| KI-128 | Receipt-detail SR noise: em-dash value, 197-char badge alt duplicating text | Jill MI-022 (23888) | open (fix in PR) | #5454: 'none' and short badge alt; re-verified on main | low-hanging fruit | P3 | S | Grok | Trim badge alt / placeholder value |
| KI-129 | Receipts list duplicate link names out of context | Jill MI-023 (23888) | stale | not reproduced on main 2249dbb5: list links are the receipt titles | low-hanging fruit | P3 | S | Grok | Include state/date context in links' accessible names |
| KI-130 | Message-list focus outline is dead CSS (.message-list vs class=timeline) | Jill MI-025 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Fix the selector to the served element (one line) |
| KI-131 | Board j/k navigation starts dead, undiscoverable | Jill MI-026 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Land initial focus inside #work-board; surface the shortcut |
| KI-132 | needs-me snippet truncation splits a grapheme cluster, drops U+064E | Jill MI-027 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Grapheme-aware truncation |
| KI-133 | Invite code with Arabic-Indic digits cannot match JOIN_CODE_PATTERN | Jill MI-028 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Normalise Arabic-Indic digits before the pattern match |
| KI-134 | Dates/times never zone-labelled | Jill MI-029 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Add time elements + zone labels |
| KI-135 | Invite-expiry relative text hand-built English, no Intl APIs | Jill MI-030 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Use Intl.RelativeTimeFormat / PluralRules |
| KI-136 | Counters hard-code en-US formatters, binary English plurals | Jill MI-031 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Route counters through locale formatters |
| KI-137 | Credits render as raw milli-credit integer | Jill MI-032 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Format from the structured amount (display leg only) |
| KI-138 | #join-enter-home tap target 40x19 px at 360x640 | Jill MI-033 (23888) | open (fix in PR) | #5453: 44px minimum; re-verified on main (inline link, no size rule) | low-hanging fruit | P3 | S | Grok | Enlarge the tap target |
| KI-139 | Wordmark font 140,632 B = 65% of door wire, for one heading | Jill MI-034 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Subset or drop the font for the wordmark |
| KI-140 | Public HTML uncacheable, no ETag, on all public surfaces | Jill MI-035 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Extend the /src/* validator pattern to public HTML |
| KI-141 | Two conflicting claim recipes in official docs | Jill MI-036 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Reconcile to one claim recipe, cross-referenced; H-D #4448 merged here (same front-door conflict) |
| KI-142 | One-call enrolment promise omits the possible 428 proof-of-work step | Jill MI-037 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Disclose the possible 428/nonce step; docs-only |
| KI-143 | Pre-join 403 hint names a dead end: agent identity cannot mint guest seats | Jill MI-038 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Correct the hint's first branch |
| KI-144 | The two origin_denied hints contradict each other | Jill MI-039 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Reconcile the two hint texts |
| KI-145 | Sibling public lists paginate inconsistently (?cursor= vs ?after=) | Jill MI-040 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Codex (proposed) | Accept one pagination parameter across both lists |
| KI-146 | magic/request 422 misnames its cause | Jill MI-041 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Name the extra-field cause in the 422 |
| KI-147 | llms-full blanket claim that unknown query params are ignored is false | Jill MI-042 (23888) | open | Jill master-issues draft: S3 OPEN; not re-verified | low-hanging fruit | P3 | S | Jill-fleet (proposed) | Correct llms-full; docs-only |
| KI-148 | Reviewer queue action cannot complete a review; item stays delivered after POST /review approve | Jill MI-129 (23888) | open | Jill master-issues draft: OPEN (tree eb325a13); not re-verified | bug | P2 | S | Codex | Suggest/build the completing action (POST /update state:done) on queue surfaces; with MI-508, this is product-floor item 9 |
| KI-149 | R1-F1: accountableHumanId defaults to the room owner, silently widening the named talk set | Jill MI-130 (23888) | open | Jill master-issues draft: OPEN (pin 9a45a451); not re-verified | bug | P2 | S | Codex | Bind sponsorship to the actual inviter; fix-state at current #5428 head UNKNOWN-AT-READ (candidate commits named in H-C §3) |
| KI-150 | R1-F3: third talk-policy authorisation path in muse rooms contradicts its own comment | Jill MI-131 (23888) | open | Jill master-issues draft: OPEN; not re-verified | bug | P2 | S | Codex | Remove or document the museDevelopmentAccess && canInviteCoOwners path; no test covers it |
| KI-151 | R2-F1: stale approver for the life of the bridge process | Jill MI-132 (23888) | open | Jill master-issues draft: OPEN; not re-verified | bug | P2 | S | Codex | Rebuild/re-check the PermissionBroker approver on refresh; UNKNOWN-AT-READ at current head |
| KI-152 | R2-F2: bridge execution and posting unfenced; only the ack carries the fencingToken | Jill MI-133 (23888) | open | Jill master-issues draft: OPEN; not re-verified | bug | P2 | S | Codex | Fence execution + posting by listener lease; UNKNOWN-AT-READ at current head |
| KI-153 | R2-F3: replayed delivery skips re-authorisation | Jill MI-134 (23888) | open | Jill master-issues draft: OPEN; not re-verified | bug | P2 | S | Codex | Re-check mayTalk/membership before re-delivering a stored reply; UNKNOWN-AT-READ at current head |
| KI-154 | R3-F1: permission receipt posts are fire-and-forget; room record can contradict the outcome | Jill MI-135 (23888) | open | Jill master-issues draft: OPEN; not re-verified | bug | P2 | S | Codex | Make receipt posts guaranteed or fail closed; a lost corrective denial is a proof defect; UNKNOWN-AT-READ at current head |
| KI-155 | R3-F2: plain deny silently becomes a standing rejection (reject_always fallback) | Jill MI-136 (23888) | open | Jill master-issues draft: OPEN; not re-verified | bug | P2 | S | Codex | Apply the one-time principle to denials as to allows; disclose the selection in the receipt |
| KI-156 | R3-F3: two decisions inside one poll interval resolve to the first; immediate correction invisible | Jill MI-137 (23888) | open | Jill master-issues draft: OPEN; not re-verified | bug | P2 | S | Codex | Re-poll / sequence-check before granting; bounded to the 1500ms default window |
| KI-157 | A11: no outcome link exists to hand a non-participant (Board route: publicId/publicUrl null, /receipts/<id> 404) | Jill MI-138 (23888) | open | Jill master-issues draft: OPEN (production + composition); not re-verified | bug | P2 | S | Codex | Build a pointable outcome link; the YC diligence-click failure, not wording |
| KI-158 | Six MCP tools' listed schemas under-declare what their validators require | Jill MI-139 (23888) | open | Jill master-issues draft: OPEN at main 2249dbb5; not re-verified | bug | P2 | S | Codex | Express conditional requirements in schema or relax validators; owned by SIMPLIFY ledger (INV-B D7, 2026-11-13), xref §8 |
| KI-159 | No MCP receipt tool exists in either catalogue | Jill MI-140 (23888) | open | Jill master-issues draft: OPEN (production + composition); not re-verified | bug | P2 | S | Codex | Add an MCP receipt read; pairs with the decider-read conflict (MI-509): the MCP face lacks both outcome reads |
| KI-160 | Issue #3270: MCP identity mint 500s for reserved role names where REST returns actionable 422 | Jill MI-142 (23888) | open | Jill master-issues draft: OPEN, no naming PR found; not re-verified | bug | P2 | S | Codex (proposed) | Align MCP mint error with the REST 422 |
| KI-161 | Issue #3378: access-request approve silently discards the decider's note (written only on deny) | Jill MI-143 (23888) | open | Jill master-issues draft: OPEN, no naming PR found; not re-verified | bug | P2 | S | Codex (proposed) | Persist decision_note on approve as on deny |
| KI-162 | Issue #3379: invite redeem mint-vs-link fork unsignaled in the 201 response, undisclosed in llms.txt | Jill MI-144 (23888) | open | Jill master-issues draft: OPEN, no naming PR found; not re-verified | bug | P2 | S | Codex (proposed) | Signal the fork in the response + docs; silent-duplication class |
| KI-163 | Issue #3318: test time bomb — begin-scope-retry hardcodes claim scope expiry 2027-01-01 against the wall clock | Jill MI-145 (23888) | open (fix in PR) | #5448: expiry now relative to the clock; tests/begin-scope-retry.test.js:17 hardcodes 2027-01-01 on main | low-hanging fruit | P2 | S | Grok | Make the test clock-relative before it fires |
| KI-164 | Issue #1907: flaky/hanging — room import round-trips a large (1500-event) export never resolves | Jill MI-146 (23888) | open | Jill master-issues draft: OPEN, no naming PR found; not re-verified | bug | P2 | S | Codex (proposed) | Diagnose the hang; oldest defect-pattern item in the list |
| KI-165 | Issue #3437: human UI has no surface for bounties or credit balances; first-owner money journey invisible to a human | Jill MI-147 (23888) | open | Jill master-issues draft: OPEN, no naming PR found; not re-verified | bug | P2 | S | Codex (proposed) | Human money surface; xref §5 sponsor-surface gate (design call is John's) |
| KI-166 | Issue #3842: qa5-a11y-c-browser-check fails on main: #tasks-board-open never visible, 0/6 tests | Jill MI-148 (23888) | open | Jill master-issues draft: OPEN, no naming PR found; not re-verified | bug | P2 | S | Jill-fleet (proposed) | Fix the check or the board button visibility on main |
| KI-167 | Issue #4261: unit-ci shard receipts list the deliberate fail-probe fixture as a failure | Jill MI-149 (23888) | open | Jill master-issues draft: OPEN, no naming PR found; not re-verified | bug | P2 | S | Jill-fleet (proposed) | Harness cluster MI-149..152: jointly they make CI evidence partially untrustworthy |
| KI-168 | Issue #4262: invariants harness failure records drop error text for non-assertion throws | Jill MI-150 (23888) | open | Jill master-issues draft: OPEN, no naming PR found; not re-verified | bug | P2 | S | Jill-fleet (proposed) | Preserve error text in failure records |
| KI-169 | Issue #4263: invariants workflow destroys failing evidence: comment replacement deletes prior FAIL tables | Jill MI-151 (23888) | open | Jill master-issues draft: OPEN, no naming PR found; not re-verified | bug | P2 | S | Jill-fleet (proposed) | Append, never replace, FAIL evidence |
| KI-170 | Issue #4264: acceptance fixture generated-module write race on cold checkout + invariants spawn storm | Jill MI-152 (23888) | open | Jill master-issues draft: OPEN, no naming PR found; not re-verified | bug | P2 | S | Jill-fleet (proposed) | Fix the race / storm |
| KI-171 | Bounty evidenceUrl field: required, never checked, carries nothing | Jill MI-502 (23888) | open | server/bounty-escrow-routes.mjs:371 requires evidenceUrl; never fetched or checked | cut | P2 | S | Codex (proposed) | DECISION-PENDING: delete the requirement, or start checking the field — the one outcome ruled out is the current required-but-dead state |
| KI-172 | /api/opportunities.json: a live-looking dead feed — 200, generatedAt advances, opportunities always empty, referenced nowhere | Jill MI-503 (23888) | open | route still served; docs list it; issue #1609 open | cut | P2 | S | Codex (proposed) | DECISION-PENDING: remove the feed surface; claimable work exists elsewhere and nothing references this feed |

## Blocked on Potter

- KI-001: one bounded operator read of the integrity failure row (room id and mismatch labels only).
- KI-062: CI capacity (free GitHub org or GitHub app).
- KI-070: keep or delete bounties, escrow and spend.
- KI-026: an npm login for publishing room-acp (the served tarball in #5415 works without it).
- KI-005: backups stay untouched until Potter asks.

## Merged from Jill's master-issues draft

Jill's draft (seq 23888, 550 items, branch evidence/master-issues-2026-10-30 at c6a056eb) was merged on Oct 30. Added as KI-110 onward: the open product low-hanging items (MI-001 to MI-046), the audit-proved open items (MI-129 to MI-140), named GitHub defects with no PR (MI-142 to MI-152) and two dead surfaces (MI-502, MI-503); 63 rows. Folded as duplicates: MI-013 into KI-046, MI-044 into KI-040, MI-141 into KI-007, MI-153 into KI-083. Skipped as already fixed (alive or merged, awaiting deploy): MI-016, MI-017, MI-024, MI-043, MI-045, MI-046. Spot-checked on main: MI-015, MI-145, MI-502, MI-503 confirmed. The other rows carry Jill's state and are marked not re-verified. The remaining ~470 items (fleet process, gates, positioning decisions, redesign programmes, PR and issue populations) stay in Jill's draft by reference; they are policy and process, not code defects.

## Agent feedback (Oct 30 follow-up)

- Fo (23862, 23867): agrees with ranking; KI-006 is 93 behind, not 83; cut bounties (KI-070) rather than gate KI-012; claims KI-019, KI-020, KI-037, KI-083, KI-096; dates (23915): KI-019/020/096 re-tests by Mon Nov 2, KI-037 by Wed Nov 4, KI-083 by Fri Nov 6, KI-042 after.
- John's Tab (23887): agrees broadly; put KI-006 first because it gates whether the KI-001 fix is live; KI-061 is not an MVP blocker; owns post-deploy verification, no code lane.
- No reply yet from Codex, Delta, Jill (posted a separate master-issues draft), Jill-Dot, Muse or Instinct-3.

## Grok Bot connector audit (Oct 30, 5:30 PM PT)

Measured live on production `3bb35417` via hosted MCP with Grok Bot's muse-room identity. Tools exercised in `qa-reach-20261030-77cd43`. Core profile: 14 tools; `profile=full`: 123; `profile=lean`: 14; `focus=work`: 42.

| ID | Issue | Type | Pri | Fix |
|---|---|---|---|---|
| KI-173 | Cold `room_needs_me` starts at seq 0: muse-room returned 3-week-old mentions (seq 792-1444) at head ~23.9k; 80 paged calls (133 s) only reached seq 16k (~110+ calls to today) | Bug | P1 | Open (fix in PR) #5465: cold read starts at head-500; `since: 0` replays |
| KI-174 | Core profile has no Board tools (list/read/claim/update work); #5434 (claiming in core) is still open, not merged | Missing tool | P1 | Merge #5434, or a host can use `?focus=work` (42 tools) |
| KI-175 | Core profile has no wake, heartbeat, webhook or file tools; hosts on mcp-remote need `?profile=full` or a focus in the URL (mcp-remote passes the query string) | Design | P2 | Document `?focus=automation` / `?profile=full` in the connector snippet; add `room_mcp_snippet` variants |
| KI-176 | `room_check_access` (no roomId) lists archived rooms (17 of 21 for Grok Bot); every write there is 409 `room_archived` | Bug | P2 | Open (fix in PR) #5466: list live rooms, return `archivedRooms` count |
| KI-177 | An owner cannot leave a throwaway room (`Owner must retain membership administration`); only path is archive | Design | P3 | Allow owner leave when the room is archived, or document archive as the leave path |
| KI-178 | `room_respond_to_request` context fields are schema-optional | Not a bug | - | Intentional (F-S6a-2): the handler returns a 422 naming the missing fields; tests pin it |
| KI-179 | `room_join` with `{}` returns a generic `invalid_arguments` instead of naming linkToken/inviteCode | Agent UX | P3 | Open (fix in PR) #5467: names `linkToken or inviteCode` as missing |
| KI-180 | Board backlog: 720 unclaimed in muse-room, 141 idle 21+ days with no PR (oldest 32 days) | Process | P2 | Proposed triage list in muse-room; owners close or re-scope theirs; nothing closed by Grok Bot |
| KI-181 | Wake push stored `authentication` bearer but never sent it, so webhook receivers that verify a bearer key could not trust Room doorbells | Bug | P2 | Open (fix in PR) #5461 |
| KI-182 | Grok Bot connector cannot use OAuth: metadata is published but there is no dynamic client registration | Missing | P3 | Add `/oauth/register`; see #5462 (docs/GROK-BOT.md) |
| KI-183 | `/api/opportunities.json` always empty plus uncalled legacy routes live in `server/http.mjs` (Codex's lane) | Cut | P3 | Codex removes in his next http.mjs pass; Grok Bot did not touch it |

## Sources mined

QA2 to QA12, DX1, SPEED, SIMPLIFY, gap hunt, architecture top problems, the Oct 2 roadmap, control-pane plans, relaunch list and the Oct 25 unfixed ledger (all private audit notes); [FOCUSED-DELIVERY-PLAN](FOCUSED-DELIVERY-PLAN.md), ACP-BRIDGE-PLAN section 6b (on #5374), [total backlog](PROJECT-ROOM-TOTAL-BACKLOG.md); open GitHub issues; the MVP cut and streamline audit; muse-room reports from Delta, John's Tab, Fo, Jill's fleet, Jill-Dot and Codex (Oct 29 to 30); production `/api/health/jobs` and `/api/version`.

Limits: the room event read covered Oct 29 to Oct 30 only; older QA was taken from the audit notes. Appendix issues are triaged by title and date, not re-tested.

## Appendix: open GitHub issues

| Issue | Filed | Title | Triage | Category |
| --- | --- | --- | --- | --- |
| [#5384](https://github.com/Uuriko/project-room/issues/5384) | 2026-10-30 | Later: simplify invites to Guest / Member (default) / Owner, Advanced scopes, and a who-can-talk-to-this-agent setting | see ledger | - |
| [#5382](https://github.com/Uuriko/project-room/issues/5382) | 2026-10-30 | Next (after stabilize gates): remote agents always reachable, mentionable and visible in hosted Room — verify and document | open (title-level triage) | bug |
| [#5381](https://github.com/Uuriko/project-room/issues/5381) | 2026-10-30 | Later: simple YAML workflow files over existing webhooks and wakes | open (title-level triage) | bug |
| [#5380](https://github.com/Uuriko/project-room/issues/5380) | 2026-10-30 | Next (after stabilize gates): answers with receipts — full room history search returning linked threads | superseded (frozen cut area) | cut |
| [#5379](https://github.com/Uuriko/project-room/issues/5379) | 2026-10-30 | Next (after stabilize gates): one signed log — extend the hash chain to approvals and git events | open (title-level triage) | bug |
| [#5378](https://github.com/Uuriko/project-room/issues/5378) | 2026-10-30 | Next (after stabilize gates): branch rooms — one thread per Board claim and its PR | open (title-level triage) | bug |
| [#5372](https://github.com/Uuriko/project-room/issues/5372) | 2026-10-30 | Later: competitor deep dive on Block Buzz (humans + agents workspace) | open (title-level triage) | bug |
| [#5371](https://github.com/Uuriko/project-room/issues/5371) | 2026-10-30 | Next: room-acp bridge - join Room with one command and one invite link (ACP) | open (title-level triage) | bug |
| [#5370](https://github.com/Uuriko/project-room/issues/5370) | 2026-10-30 | Later: expose qualified reviewer credit on the record (exclude self, empty and stale reviews) | superseded (frozen cut area) | cut |
| [#5369](https://github.com/Uuriko/project-room/issues/5369) | 2026-10-30 | Later: typed agent activity annotation on work-linked messages (Linear-style), consumer first | open (title-level triage) | bug |
| [#5368](https://github.com/Uuriko/project-room/issues/5368) | 2026-10-30 | Later: dispute decider cannot read the dispute on any surface (UT-DUAL S2 finding) | see ledger | - |
| [#5177](https://github.com/Uuriko/project-room/issues/5177) | 2026-10-29 | Production readiness intermittently exceeds DO probe budget after 8ebdea deployment | see ledger | - |
| [#5160](https://github.com/Uuriko/project-room/issues/5160) | 2026-10-28 | Re-home bounty guidance into the MCP posting path (successor to #4017) | see ledger | - |
| [#5154](https://github.com/Uuriko/project-room/issues/5154) | 2026-10-28 | Compact llms.txt dropped the review-policy disclosure: self_attested default now stated nowhere in llms.txt or AGENT-START-HERE | see ledger | - |
| [#5153](https://github.com/Uuriko/project-room/issues/5153) | 2026-10-28 | Front door contradicts itself on custom User-Agent: llms.txt says every request, AGENT-START-HERE golden-path examples omit it | see ledger | - |
| [#5152](https://github.com/Uuriko/project-room/issues/5152) | 2026-10-28 | Receipt tier text hard-codes 'human verdict' for reviewed public-work receipts — live receipt shows an agent reviewer and Humans: — | see ledger | - |
| [#4533](https://github.com/Uuriko/project-room/issues/4533) | 2026-10-22 | helper-owner-exercise.mjs still clicks Save-as-result directly (same stale shape cured in #3837) | stale (unverified since filing) | bug |
| [#4532](https://github.com/Uuriko/project-room/issues/4532) | 2026-10-22 | Board post-open re-render discards in-progress new-item form input | see ledger | - |
| [#4526](https://github.com/Uuriko/project-room/issues/4526) | 2026-10-22 | OAuth legacy-chain routes missing OpenAPI operations (route-triple item 3): oauth-protected-resource, oauth/authorize, oauth/register | see ledger | - |
| [#4493](https://github.com/Uuriko/project-room/issues/4493) | 2026-10-22 | Expired or stale MCP token gets a dropped connection instead of a structured 401 | see ledger | - |
| [#4473](https://github.com/Uuriko/project-room/issues/4473) | 2026-10-21 | Growth kit URL carriers disagree after a create result clears | superseded (frozen cut area) | cut |
| [#4461](https://github.com/Uuriko/project-room/issues/4461) | 2026-10-21 | Board-adjacent views open with focus on <body>; board initial focus lands on #board-close | see ledger | - |
| [#4451](https://github.com/Uuriko/project-room/issues/4451) | 2026-10-21 | Front-door Limits section is a fragment (unenumerated 512 KiB commands) and states no rate limits or mint quota anywhere | see ledger | - |
| [#4450](https://github.com/Uuriko/project-room/issues/4450) | 2026-10-21 | Front door states no credential lifecycle: 30-day mcpToken expiry with no renewal, rotation, or revocation stated in llms.txt / llms-full.txt / AGENT-START-HERE | stale (unverified since filing) | bug |
| [#4449](https://github.com/Uuriko/project-room/issues/4449) | 2026-10-21 | Front-door error contract drift: llms.txt gives a bare 409 and a truncated example; the operative public-work error codes exist only in AGENT-START-HERE | superseded (frozen cut area) | cut |
| [#4448](https://github.com/Uuriko/project-room/issues/4448) | 2026-10-21 | Front door teaches two different public-work claim paths (match autoClaim vs direct /claim) and never reconciles them | see ledger | - |
| [#4264](https://github.com/Uuriko/project-room/issues/4264) | 2026-10-19 | acceptance fixture: generated-module write race on cold checkout + invariants spawn storm | see ledger | - |
| [#4263](https://github.com/Uuriko/project-room/issues/4263) | 2026-10-19 | invariants workflow destroys failing evidence: comment replacement deletes prior FAIL tables; uploaded artifact vanished unchecked | see ledger | - |
| [#4262](https://github.com/Uuriko/project-room/issues/4262) | 2026-10-19 | invariants harness: failure records drop the error text for non-assertion throws (bare testCodeFailure) | see ledger | - |
| [#4261](https://github.com/Uuriko/project-room/issues/4261) | 2026-10-19 | unit-ci shard receipts list the deliberate fail-probe fixture as a failure | see ledger | - |
| [#4231](https://github.com/Uuriko/project-room/issues/4231) | 2026-10-19 | CI-DIET shadow bars: patch 01 (coverage equivalence) + patch 02 (cloudflare diff-gate) — sampling tracker | stale (unverified since filing) | bug |
| [#4128](https://github.com/Uuriko/project-room/issues/4128) | 2026-10-18 | Keeper blind spot: nonterminal bounties matching no DUE_WHERE branch are invisible to due, overdue, and next-due (NULL challenge_ends_ms repro) | see ledger | - |
| [#4127](https://github.com/Uuriko/project-room/issues/4127) | 2026-10-18 | Parseable-but-wrong projections have no repair path: hollow reads, raw TypeErrors, F5 tool refuses anything that parses | see ledger | - |
| [#4126](https://github.com/Uuriko/project-room/issues/4126) | 2026-10-18 | One corrupt room bricks node-server boot: unguarded JSON.parse in repairProjectionProvenance (store.mjs:3128) and checkpoint parses | see ledger | - |
| [#4125](https://github.com/Uuriko/project-room/issues/4125) | 2026-10-18 | verifyConservation never runs in production, and its per-bounty checks ignore payable flows — a chain-valid forged payout passes it | see ledger | - |
| [#4116](https://github.com/Uuriko/project-room/issues/4116) | 2026-10-18 | reassignWork reopen (delivered→in_progress) keeps a lapsed lease — dead-lease inheritance sibling of the send-back fix | see ledger | - |
| [#4088](https://github.com/Uuriko/project-room/issues/4088) | 2026-10-18 | public-read-model: per-record failures are swallowed silently — add a skip channel with record ids | stale (unverified since filing) | bug |
| [#4073](https://github.com/Uuriko/project-room/issues/4073) | 2026-10-18 | CF-FOLD: execute the decision-17 check-shadow fold (#3217 item 3b implementation) | stale (unverified since filing) | bug |
| [#4071](https://github.com/Uuriko/project-room/issues/4071) | 2026-10-18 | Post-landing correction owed: PR #3953's three reviewed findings shipped uncorrected | stale (unverified since filing) | bug |
| [#4065](https://github.com/Uuriko/project-room/issues/4065) | 2026-10-18 | Static-asset cache/ETag behaviour differs between the edge and Node asset paths | stale (unverified since filing) | bug |
| [#4064](https://github.com/Uuriko/project-room/issues/4064) | 2026-10-18 | work-handoff: file list silently truncates at 64; envelope checksPassed is asserted, never evaluated; verify() comment overclaims a room check | stale (unverified since filing) | bug |
| [#4063](https://github.com/Uuriko/project-room/issues/4063) | 2026-10-18 | claim-autolink: superseded matches eat links, repo-case defeats webhook freshness, auto-link events attribute to the owner | stale (unverified since filing) | bug |
| [#4062](https://github.com/Uuriko/project-room/issues/4062) | 2026-10-18 | claim-reputation fold leaks positions on closed/deleted claims (phantom positions count toward HOARDING_CAP) | stale (unverified since filing) | bug |
| [#4061](https://github.com/Uuriko/project-room/issues/4061) | 2026-10-18 | Worker claim-prs job never runs autolink discovery or deploy linking (production is the Worker) | stale (unverified since filing) | bug |
| [#4055](https://github.com/Uuriko/project-room/issues/4055) | 2026-10-18 | Serve /.well-known/oauth-protected-resource (RFC 9728) — unblocks Claude Connectors / ChatGPT Apps discovery | see ledger | - |
| [#3998](https://github.com/Uuriko/project-room/issues/3998) | 2026-10-18 | [docs] CHALLENGE.md "Featured agents" promise points at a nonexistent section — delete the promise lines (census D10) | stale (unverified since filing) | bug |
| [#3997](https://github.com/Uuriko/project-room/issues/3997) | 2026-10-18 | [migration] Remove retired board_vtwo_* tables/stub (code-sweep C-06, via census cluster G) | see ledger | - |
| [#3976](https://github.com/Uuriko/project-room/issues/3976) | 2026-10-18 | AEO follow-up: serve docs/FAQ.md at /faq with FAQPage JSON-LD (and fix its stale bounty lines) | superseded (frozen cut area) | cut |
| [#3975](https://github.com/Uuriko/project-room/issues/3975) | 2026-10-18 | AEO: no alternatives/comparison coverage for AgentBounties, Clanker Cloud, Company OS (battery prompts 19-21 ABSENT) | superseded (frozen cut area) | cut |
| [#3967](https://github.com/Uuriko/project-room/issues/3967) | 2026-10-17 | Board card work link opens the record behind the still-open board dialog — keyboard focus stays trapped in the board | see ledger | - |
| [#3962](https://github.com/Uuriko/project-room/issues/3962) | 2026-10-17 | [QA-WAVE-C L2] Fresh-room members read 0.00 credits until the first escrow write: genesis issuance is lazy and balances() never triggers it | see ledger | - |
| [#3961](https://github.com/Uuriko/project-room/issues/3961) | 2026-10-17 | Share-link agent copy misstates access: co_admin join-agent response calls it a 'guest pass' (read+chat, work out of scope); co_admin share-link refusal claims a browser session is required | stale (unverified since filing) | bug |
| [#3960](https://github.com/Uuriko/project-room/issues/3960) | 2026-10-17 | Cold founder invite dead-end: unverified-email owner can create/post/work but share-link creation fails with misleading errors and no verify path | stale (unverified since filing) | bug |
| [#3958](https://github.com/Uuriko/project-room/issues/3958) | 2026-10-17 | Stranger receipt: paid settlement (lot_) receipts absent from /receipts index, and the lot receipt page shows From = To (same account), no worker/poster names, no description of the work | see ledger | - |
| [#3949](https://github.com/Uuriko/project-room/issues/3949) | 2026-10-17 | Invite replay: credential-less re-rotation is unlimited within the 30-day window — code+requestId replays repeatedly take over the identity and lock out the saved-secret holder (#3923 residual) | see ledger | - |
| [#3948](https://github.com/Uuriko/project-room/issues/3948) | 2026-10-17 | Agent inbox after-cursor silently loses messages: burst over limit is skipped forever, and an over-head cursor suppresses future DMs/mentions (#3922) | see ledger | - |
| [#3924](https://github.com/Uuriko/project-room/issues/3924) | 2026-10-17 | [B3] Public-work rate limits are per-egress-IP and count refused attempts: one retry storm starves every agent behind the IP | see ledger | - |
| [#3913](https://github.com/Uuriko/project-room/issues/3913) | 2026-10-17 | [Low] Bug sweep 2026-10-16 — lane 14 (SCRIPTS-OPS) Low findings bundle (4) | see ledger | - |
| [#3911](https://github.com/Uuriko/project-room/issues/3911) | 2026-10-17 | [Low] Bug sweep 2026-10-16 — lane 12 (CLOUDFLARE-DO) Low findings bundle (3) | stale (unverified since filing) | bug |
| [#3910](https://github.com/Uuriko/project-room/issues/3910) | 2026-10-17 | [Low] Bug sweep 2026-10-16 — lane 11 (STREAMS-WAKE) Low findings bundle (3) | stale (unverified since filing) | bug |
| [#3909](https://github.com/Uuriko/project-room/issues/3909) | 2026-10-17 | [Low] Bug sweep 2026-10-16 — lane 10 (BOARD-UI) Low findings bundle (5) | stale (unverified since filing) | bug |
| [#3908](https://github.com/Uuriko/project-room/issues/3908) | 2026-10-17 | [Low] Bug sweep 2026-10-16 — lane 08 (IDENTITY-ACCESS) Low findings bundle (3) | stale (unverified since filing) | bug |
| [#3907](https://github.com/Uuriko/project-room/issues/3907) | 2026-10-17 | [Low] Bug sweep 2026-10-16 — lane 07 (MONEY-SETTLEMENT) Low findings bundle (2) | superseded (frozen cut area) | cut |
| [#3906](https://github.com/Uuriko/project-room/issues/3906) | 2026-10-17 | [Low] Bug sweep 2026-10-16 — lane 06 (MONEY-ESCROW) Low findings bundle (1) | superseded (frozen cut area) | cut |
| [#3904](https://github.com/Uuriko/project-room/issues/3904) | 2026-10-17 | [Low] Bug sweep 2026-10-16 — lane 02 (MESSAGES-INTEGRITY) Low findings bundle (2) | see ledger | - |
| [#3897](https://github.com/Uuriko/project-room/issues/3897) | 2026-10-17 | [Medium] deploy-prod: a cancelled run between the two Worker uploads leaves a skewed pair with no recovery | see ledger | - |
| [#3892](https://github.com/Uuriko/project-room/issues/3892) | 2026-10-17 | [Medium] Claim-record deep-link path (revealClaimRecord) swallows reveal failure; the click path does not | stale (unverified since filing) | bug |
| [#3891](https://github.com/Uuriko/project-room/issues/3891) | 2026-10-17 | [Medium] Owner Cockpit renders the spend 'adjust' action as a Deny button POSTing an empty body to spend-allowance | see ledger | - |
| [#3890](https://github.com/Uuriko/project-room/issues/3890) | 2026-10-17 | [Medium] Owner Cockpit decision facts lack board_review entirely (age, consequence, label, sort); spend items share the invisible age | see ledger | - |
| [#3842](https://github.com/Uuriko/project-room/issues/3842) | 2026-10-17 | qa5-a11y-c-browser-check fails on main: #tasks-board-open (Board button) never visible, 0/6 tests | see ledger | - |
| [#3837](https://github.com/Uuriko/project-room/issues/3837) | 2026-10-17 | manual-owner-exercise-check fails on main: 'Save as result' action never visible in the return stage | stale (unverified since filing) | bug |
| [#3796](https://github.com/Uuriko/project-room/issues/3796) | 2026-10-16 | Join dialog stays open after a successful account creation — focus dropped to <body>, room reachable only after manually dismissing it | see ledger | - |
| [#3793](https://github.com/Uuriko/project-room/issues/3793) | 2026-10-16 | Board dialog drops focus to <body> on close (button and Escape) and on a refused claim; Account view opens with focus on <body> | see ledger | - |
| [#3779](https://github.com/Uuriko/project-room/issues/3779) | 2026-10-16 | Access review omits owner-delegate grants — highest-authority grant class invisible in /access-review | see ledger | - |
| [#3778](https://github.com/Uuriko/project-room/issues/3778) | 2026-10-16 | wakeUrl-only hosts never receive wake pings: deliverWakePing journals wakeUrl rows only as an adjunct to a subscription delivery | see ledger | - |
| [#3755](https://github.com/Uuriko/project-room/issues/3755) | 2026-10-16 | Reviewer load is invisible and unbounded: no queue depth surface, rota, or balancing for the scarcest resource | stale (unverified since filing) | bug |
| [#3753](https://github.com/Uuriko/project-room/issues/3753) | 2026-10-16 | [High] Delivered work is silently discarded when the 24h claim lease expires during review wait | see ledger | - |
| [#3741](https://github.com/Uuriko/project-room/issues/3741) | 2026-10-16 | Pending public-work reviews are invisible: no attention signal, Project panel says 'No tasks yet', Results buried 3 deep | superseded (frozen cut area) | cut |
| [#3740](https://github.com/Uuriko/project-room/issues/3740) | 2026-10-16 | Session-one (mobile): a human cannot claim public work — every offer ends at 'Take it to your agent' | superseded (frozen cut area) | cut |
| [#3731](https://github.com/Uuriko/project-room/issues/3731) | 2026-10-16 | Spec gap: undocumented escrow validation rules (self-claim, future deadline, verifier membership, band assignment, transfer layering) | superseded (frozen cut area) | cut |
| [#3729](https://github.com/Uuriko/project-room/issues/3729) | 2026-10-16 | Spec gap: keeper semantics — finalize/epoch behaviors no doc states (funded refunds, epoch keeper pass, no-op 422, post-ruling approval, split, reason codes) | superseded (frozen cut area) | cut |
| [#3728](https://github.com/Uuriko/project-room/issues/3728) | 2026-10-16 | Spec gap: approvalMode decides who may accept/reject but appears in no public doc; accept/reject docs promise verifier review unconditionally | stale (unverified since filing) | bug |
| [#3722](https://github.com/Uuriko/project-room/issues/3722) | 2026-10-16 | llms.txt never mentions the starter claim that room creation pre-claims for you (2h lease already ticking) | stale (unverified since filing) | bug |
| [#3720](https://github.com/Uuriko/project-room/issues/3720) | 2026-10-16 | llms.txt: board claim endpoint requires a JSON object body the doc never mentions (literal follower gets 400 invalid_json) | stale (unverified since filing) | bug |
| [#3718](https://github.com/Uuriko/project-room/issues/3718) | 2026-10-16 | Served-but-never-loaded client modules: pwa-install.js and push-ask.js ship in the manifest with no production importer | stale (unverified since filing) | bug |
| [#3717](https://github.com/Uuriko/project-room/issues/3717) | 2026-10-16 | EXECUTION-BRIEF decision #19d unimplemented: no shared scrubSecrets library — at least four divergent redaction implementations | stale (unverified since filing) | bug |
| [#3713](https://github.com/Uuriko/project-room/issues/3713) | 2026-10-16 | Premise-flagged claims stay claimable through the board ready queue while AvailableWork excludes them | stale (unverified since filing) | bug |
| [#3711](https://github.com/Uuriko/project-room/issues/3711) | 2026-10-16 | Board claims projected from work items oscillate in_progress <-> unclaimed under the lease sweep (expired item leases) | stale (unverified since filing) | bug |
| [#3710](https://github.com/Uuriko/project-room/issues/3710) | 2026-10-16 | Public-receipts consent copy never discloses search indexing or link-sharing reach | superseded (frozen cut area) | cut |
| [#3709](https://github.com/Uuriko/project-room/issues/3709) | 2026-10-16 | [launch-readiness] The neglect ladder pays junk at 35.6 cr/h under a passive operator; only reviewer diligence bounds it (bond + flake ladder: adversary net -6 cr when reviews happen) | stale (unverified since filing) | bug |
| [#3708](https://github.com/Uuriko/project-room/issues/3708) | 2026-10-16 | [launch-readiness] Rotation caps exist nowhere in code, and even perfectly enforced they leak: collusion ring extracted 31.6 cr (44% of float) at 17x the honest rate | stale (unverified since filing) | bug |
| [#3704](https://github.com/Uuriko/project-room/issues/3704) | 2026-10-16 | [launch-readiness] Fresh lanes are STANDARD band, not probation: the rail does not make FS-14 established-lane-only as the packet claims | stale (unverified since filing) | bug |
| [#3701](https://github.com/Uuriko/project-room/issues/3701) | 2026-10-16 | SKILL.md tells agents they will 'get paid' / 'start earning' — contradicts the product's own payment honesty | stale (unverified since filing) | bug |
| [#3700](https://github.com/Uuriko/project-room/issues/3700) | 2026-10-16 | Served OpenAPI inventory omits the entire public proof surface (receipts, proof pages, room pages, agent directory) | superseded (frozen cut area) | cut |
| [#3697](https://github.com/Uuriko/project-room/issues/3697) | 2026-10-16 | Work-session idempotency matcher ignores spendCents/rounds/toolCalls/budget: a retry with different usage figures is silently accepted as a duplicate | superseded (frozen cut area) | cut |
| [#3694](https://github.com/Uuriko/project-room/issues/3694) | 2026-10-16 | Reducer resolves channels by raw index: prototype names (toString) pass as existing channels in src/events.js | stale (unverified since filing) | bug |
| [#3693](https://github.com/Uuriko/project-room/issues/3693) | 2026-10-16 | bounty_finalize cannot pay out an approved bounty, its tool/doc copy promises it can, and the agent door has no payout path at all | superseded (frozen cut area) | cut |
| [#3689](https://github.com/Uuriko/project-room/issues/3689) | 2026-10-16 | Defect class: served contract drifts from gated sources — served-vs-source parity in the contract gate | stale (unverified since filing) | bug |
| [#3686](https://github.com/Uuriko/project-room/issues/3686) | 2026-10-16 | Defect class: one time constant, several semantic roles — time-constant registry with single-role lint | stale (unverified since filing) | bug |
| [#3682](https://github.com/Uuriko/project-room/issues/3682) | 2026-10-16 | Defect class: whole-tree checks judge PRs against a moving main — make shared checkers base-relative | stale (unverified since filing) | bug |
| [#3681](https://github.com/Uuriko/project-room/issues/3681) | 2026-10-16 | Defect class: checks that pass without checking — gate canaries for every CI gate | stale (unverified since filing) | bug |
| [#3680](https://github.com/Uuriko/project-room/issues/3680) | 2026-10-16 | Defect class: backup writers ship without a proven restore reader — writer↔reader registry + semantic round-trip gate | stale (unverified since filing) | bug |
| [#3678](https://github.com/Uuriko/project-room/issues/3678) | 2026-10-16 | Defect class: wall-clock timing assertions in tests — ban in unit suite, budgets only in the priced harness | stale (unverified since filing) | bug |
| [#3677](https://github.com/Uuriko/project-room/issues/3677) | 2026-10-16 | Defect class: cursor/walk semantics reinvented per surface — one walk + mutation-walk property test | stale (unverified since filing) | bug |
| [#3676](https://github.com/Uuriko/project-room/issues/3676) | 2026-10-16 | Defect class: idempotency scope/payload binding reinvented per surface — replay-matrix conformance gate | stale (unverified since filing) | bug |
| [#3675](https://github.com/Uuriko/project-room/issues/3675) | 2026-10-16 | [docs] RECEIPTS-PAGE names the public-receipts setting but never says how an owner records it — and 'publicly listed' silently means the public-page opt-in, not the directory listing | superseded (frozen cut area) | cut |
| [#3674](https://github.com/Uuriko/project-room/issues/3674) | 2026-10-16 | Defect class: publication/hiding policy is per-surface — one publication gate for all public reads | stale (unverified since filing) | bug |
| [#3673](https://github.com/Uuriko/project-room/issues/3673) | 2026-10-16 | Defect class: registration omissions — every registry needs a closure check, not hand registration | stale (unverified since filing) | bug |
| [#3672](https://github.com/Uuriko/project-room/issues/3672) | 2026-10-16 | agent-invites: legacy v1 invite codes — header comment contradicts codeHash; holders get a misleading 404 | stale (unverified since filing) | bug |
| [#3670](https://github.com/Uuriko/project-room/issues/3670) | 2026-10-16 | [docs] wants-work capabilities enum is unnamed at the front door — llms.txt shows the field, AGENT-START-HERE's example implies free text; server refuses anything but work/land/deploy | stale (unverified since filing) | bug |
| [#3669](https://github.com/Uuriko/project-room/issues/3669) | 2026-10-16 | Capacity finding (HUNT-LOAD): no load shedding under claim-fabric overload — congestion collapse + client-timed-out writes still applied ~60s later | stale (unverified since filing) | bug |
| [#3668](https://github.com/Uuriko/project-room/issues/3668) | 2026-10-16 | [docs] AGENT-START-HERE Step 6 names POST /api/access-requests with no body — the required shape exists only in SWARM-PLUG-IN | stale (unverified since filing) | bug |
| [#3666](https://github.com/Uuriko/project-room/issues/3666) | 2026-10-16 | work-sessions 'next' hint sends agents to POST /work-claims to register a work item — that never creates one (session then 404s work_not_found) | stale (unverified since filing) | bug |
| [#3664](https://github.com/Uuriko/project-room/issues/3664) | 2026-10-16 | Board claim leases: fixed 24h term, no expiry warning or renewal affordance in the claim flow (EXP-10 friction #1) | stale (unverified since filing) | bug |
| [#3660](https://github.com/Uuriko/project-room/issues/3660) | 2026-10-16 | Feature: Summon a mystery shopper — per-room cold-board friction report for owners | stale (unverified since filing) | bug |
| [#3659](https://github.com/Uuriko/project-room/issues/3659) | 2026-10-16 | Standing gate (design): new error codes must ship with an agent recovery and a human remedy (or an explicit waiver) | stale (unverified since filing) | bug |
| [#3658](https://github.com/Uuriko/project-room/issues/3658) | 2026-10-16 | Errors catalog integrity: 79 corrupted meaning rows, a shipped code missing (drift-guard blind spot), an HTTP 0 row, unreliable 'no mapped recovery' markers | stale (unverified since filing) | bug |
| [#3655](https://github.com/Uuriko/project-room/issues/3655) | 2026-10-16 | llms.txt served by a non-production deployment links the production origin for the full packet, MCP, and agent card | stale (unverified since filing) | bug |
| [#3654](https://github.com/Uuriko/project-room/issues/3654) | 2026-10-16 | AGENT-START-HERE's 'rehearse this verification right now' receipt 404s on every deployment except production | superseded (frozen cut area) | cut |
| [#3653](https://github.com/Uuriko/project-room/issues/3653) | 2026-10-16 | Receipts: no 'since this receipt was issued' line is possible today — post-issuance changes delete or rewrite the receipt instead of annotating it | superseded (frozen cut area) | cut |
| [#3651](https://github.com/Uuriko/project-room/issues/3651) | 2026-10-16 | Documented agent front-door path takes 7 calls to first receipt; the session-one contract budgets 6 | superseded (frozen cut area) | cut |
| [#3650](https://github.com/Uuriko/project-room/issues/3650) | 2026-10-16 | invalid_public_work 422 never names the refused fields its own hint tells the agent to fix | superseded (frozen cut area) | cut |
| [#3649](https://github.com/Uuriko/project-room/issues/3649) | 2026-10-16 | Public board advertises tasks as claimable while a live path fence makes every claim 409 — claimableCount ignores path fencing | stale (unverified since filing) | bug |
| [#3640](https://github.com/Uuriko/project-room/issues/3640) | 2026-10-16 | llms.txt: wake poll without hostId does not 422 for an agent with a registered host (doc inaccuracy, both revisions) | stale (unverified since filing) | bug |
| [#3639](https://github.com/Uuriko/project-room/issues/3639) | 2026-10-16 | [deploy] Rollback re-opens #3549 for share-link joins — the co_admin cap is join-time code, not a stored grant | stale (unverified since filing) | bug |
| [#3635](https://github.com/Uuriko/project-room/issues/3635) | 2026-10-16 | AGENT-START-HERE: the 428 proof-of-work step has prose math but no worked code snippet | stale (unverified since filing) | bug |
| [#3634](https://github.com/Uuriko/project-room/issues/3634) | 2026-10-16 | Agent front-door docs contradict themselves: query-parameter handling (silently ignored vs 422) and MCP tool counts (7 / ~23 / 7+4) | stale (unverified since filing) | bug |
| [#3626](https://github.com/Uuriko/project-room/issues/3626) | 2026-10-16 | Decision push class needs an interrupt budget + flood state (EEMUA 191) | stale (unverified since filing) | bug |
| [#3625](https://github.com/Uuriko/project-room/issues/3625) | 2026-10-16 | dr: no operator procedure for post-restore credential re-issue or first-tick verification (game-day steps had to be improvised) | stale (unverified since filing) | bug |
| [#3623](https://github.com/Uuriko/project-room/issues/3623) | 2026-10-16 | docs: BACKUP-DR.md state and RTO are stale after the #3409/#3324/#3325 closures (game-day measured restore 42.8s, mechanical RTO ~60s) | stale (unverified since filing) | bug |
| [#3618](https://github.com/Uuriko/project-room/issues/3618) | 2026-10-16 | Records: no incident linkage; performance rates not maintained as records (accountability R-10/R-12) | stale (unverified since filing) | bug |
| [#3617](https://github.com/Uuriko/project-room/issues/3617) | 2026-10-16 | Records: ceilings/ratification not stamped at action time; refusals mostly unrecorded (accountability R-7/R-8) | stale (unverified since filing) | bug |
| [#3616](https://github.com/Uuriko/project-room/issues/3616) | 2026-10-16 | Records: no auditor-grade decision-row export to customer custody (accountability R-5/R-11) | stale (unverified since filing) | bug |
| [#3615](https://github.com/Uuriko/project-room/issues/3615) | 2026-10-16 | Records: no subject-facing adverse-decision packet, and notices are not records (accountability R-4/R-6) | stale (unverified since filing) | bug |
| [#3614](https://github.com/Uuriko/project-room/issues/3614) | 2026-10-16 | Records: decision records have no retention class — declare ≥4y + legal hold (accountability R-3) | stale (unverified since filing) | bug |
| [#3613](https://github.com/Uuriko/project-room/issues/3613) | 2026-10-16 | Records: criteria-level outcomes and period-of-use stop at the bounty lane (accountability R-2) | superseded (frozen cut area) | cut |
| [#3612](https://github.com/Uuriko/project-room/issues/3612) | 2026-10-16 | Records: consequential records lack session-instance, stamped principal, and model/harness version (accountability R-1/R-9) | stale (unverified since filing) | bug |
| [#3608](https://github.com/Uuriko/project-room/issues/3608) | 2026-10-16 | Public-work offers: 100-per-room LIFETIME cap (all states counted) will wall the First Shift board program | superseded (frozen cut area) | cut |
| [#3606](https://github.com/Uuriko/project-room/issues/3606) | 2026-10-16 | [Medium] Public board pagination (claimableFirst + offer_id cursor) duplicates and silently drops tasks when claim state changes mid-walk | stale (unverified since filing) | bug |
| [#3603](https://github.com/Uuriko/project-room/issues/3603) | 2026-10-16 | Deletion retention policy never discloses backup retention / restore resurrection | stale (unverified since filing) | bug |
| [#3602](https://github.com/Uuriko/project-room/issues/3602) | 2026-10-16 | Feedback scrubber stores the product's own credentials (pri_/rak_/ga1.) verbatim | stale (unverified since filing) | bug |
| [#3601](https://github.com/Uuriko/project-room/issues/3601) | 2026-10-16 | Account deletion leaves a sole-owned room's public page, receipts, and sitemap entries live forever | superseded (frozen cut area) | cut |
| [#3596](https://github.com/Uuriko/project-room/issues/3596) | 2026-10-16 | Board actions leak raw 'Failed to fetch' on transport failure, with no outcome guidance or refresh | stale (unverified since filing) | bug |
| [#3592](https://github.com/Uuriko/project-room/issues/3592) | 2026-10-16 | Wakeability window (24h) contradicts declared heartbeat cadence (up to 7d): healthy slow-cadence agents read as not wakeable | stale (unverified since filing) | bug |
| [#3591](https://github.com/Uuriko/project-room/issues/3591) | 2026-10-16 | Bounty escrow: deadline/challenge boundaries are a race — accept-vs-finalize and dispute-vs-finalize outcomes depend on who pokes first | superseded (frozen cut area) | cut |
| [#3588](https://github.com/Uuriko/project-room/issues/3588) | 2026-10-15 | Activation funnel: 'saw board' stage is unmeasurable — no surface records a board view (with claimableCount) | stale (unverified since filing) | bug |
| [#3585](https://github.com/Uuriko/project-room/issues/3585) | 2026-10-15 | R2 backup target breaks at current size: writer buffers the whole export in DO memory, and no restore path can read an R2 backup | stale (unverified since filing) | bug |
| [#3584](https://github.com/Uuriko/project-room/issues/3584) | 2026-10-15 | [Bug][Ops] Stale instance lock wedges all future boots when the dead server's PID is reused by any live process | stale (unverified since filing) | bug |
| [#3579](https://github.com/Uuriko/project-room/issues/3579) | 2026-10-15 | Supply chain: sharp override drifts across Cloudflare pnpm files (0.35.4 vs 0.35.5); operator runbooks execute unpinned tools | stale (unverified since filing) | bug |
| [#3578](https://github.com/Uuriko/project-room/issues/3578) | 2026-10-15 | Supply chain: dependency install scripts execute during npm ci in secret-bearing workflows | stale (unverified since filing) | bug |
| [#3577](https://github.com/Uuriko/project-room/issues/3577) | 2026-10-15 | Supply chain: skill installer fetches auto-invoked agent instructions from mutable main via curl / sh | stale (unverified since filing) | bug |
| [#3545](https://github.com/Uuriko/project-room/issues/3545) | 2026-10-15 | Core work-claim leases have no fencing token: finish path is gated by owner identity only | stale (unverified since filing) | bug |
| [#3527](https://github.com/Uuriko/project-room/issues/3527) | 2026-10-15 | Best-of-N bounty attempts: spec first (attempt cap, loser visibility, dispute scope) | superseded (frozen cut area) | cut |
| [#3526](https://github.com/Uuriko/project-room/issues/3526) | 2026-10-15 | Public receipt gallery with clone-as-template for completed bounties | superseded (frozen cut area) | cut |
| [#3525](https://github.com/Uuriko/project-room/issues/3525) | 2026-10-15 | Promote a completed bounty run into a room Skill (human-gated, receipt-linked) | superseded (frozen cut area) | cut |
| [#3524](https://github.com/Uuriko/project-room/issues/3524) | 2026-10-15 | Bounty pricing guidance at post time from the room's own receipt history | superseded (frozen cut area) | cut |
| [#3523](https://github.com/Uuriko/project-room/issues/3523) | 2026-10-15 | Receipt replay front-end: render receipts as a readable work timeline | superseded (frozen cut area) | cut |
| [#3483](https://github.com/Uuriko/project-room/issues/3483) | 2026-10-14 | auditRecovery content digest canonicalizes BLOB cells byte-by-byte (~5.3s per MiB) — restore verification cost scales with attachment bytes | stale (unverified since filing) | bug |
| [#3460](https://github.com/Uuriko/project-room/issues/3460) | 2026-10-14 | [Low][docs] llms.txt work-claim board omits the claimed -> in_progress -> done ordering — a literal first close 422s | stale (unverified since filing) | bug |
| [#3437](https://github.com/Uuriko/project-room/issues/3437) | 2026-10-14 | Human UI has no surface for bounties or credit balances: the first-owner money journey is invisible to a human owner (H-J1 FAIL) | see ledger | - |
| [#3413](https://github.com/Uuriko/project-room/issues/3413) | 2026-10-14 | [Perf][Medium] Room/board reads are O(board) per request: 2,000-item board work view ~0.5 s median idle (10x small room), activation pack ~0.4 s | stale (unverified since filing) | bug |
| [#3408](https://github.com/Uuriko/project-room/issues/3408) | 2026-10-14 | [Perf] applyEvent deep-clones the entire room state per event: history replay (import / projection rebuild) is quadratic, and every live write gets slower as the room grows | stale (unverified since filing) | bug |
| [#3406](https://github.com/Uuriko/project-room/issues/3406) | 2026-10-14 | Double-served route: GET /api/rooms/{roomId}/access-requests legacy branch is shadowed by the route-table row | stale (unverified since filing) | bug |
| [#3401](https://github.com/Uuriko/project-room/issues/3401) | 2026-10-14 | Test/CI scratch leaks fill the 512 MB /tmp tmpfs on shared dev VMs (ENOSPC class) | stale (unverified since filing) | bug |
| [#3379](https://github.com/Uuriko/project-room/issues/3379) | 2026-10-14 | Invite redeem: mint-vs-link fork is unsignaled in the 201 response and undisclosed in llms.txt (silent duplicate identity) | see ledger | - |
| [#3378](https://github.com/Uuriko/project-room/issues/3378) | 2026-10-14 | Access-request approve silently discards the decider's note (decision_note written only on deny) | see ledger | - |
| [#3375](https://github.com/Uuriko/project-room/issues/3375) | 2026-10-14 | [Outfitter] App Store: curated catalog -> self-serve -> metered | stale (unverified since filing) | bug |
| [#3374](https://github.com/Uuriko/project-room/issues/3374) | 2026-10-14 | [Outfitter v0] Receipts: tools_used[] capture + 'Made with' rail | superseded (frozen cut area) | cut |
| [#3373](https://github.com/Uuriko/project-room/issues/3373) | 2026-10-14 | [Outfitter v0] Syndication freshness for seed listings | superseded (frozen cut area) | cut |
| [#3372](https://github.com/Uuriko/project-room/issues/3372) | 2026-10-14 | [Outfitter v0] Per-listing install snippets from the canonical origin constant | superseded (frozen cut area) | cut |
| [#3371](https://github.com/Uuriko/project-room/issues/3371) | 2026-10-14 | [Outfitter v0] /outfitter human page (thin, server-rendered) | stale (unverified since filing) | bug |
| [#3370](https://github.com/Uuriko/project-room/issues/3370) | 2026-10-14 | [Outfitter v0] Generated read surfaces: GET /catalog + GET /catalog.txt | stale (unverified since filing) | bug |
| [#3369](https://github.com/Uuriko/project-room/issues/3369) | 2026-10-14 | [Outfitter v0] scripts/catalog-check.mjs: catalog freshness/schema CI gate | stale (unverified since filing) | bug |
| [#3368](https://github.com/Uuriko/project-room/issues/3368) | 2026-10-14 | [Outfitter v0] Catalog source file: catalog/listings.json schema + seed listings | superseded (frozen cut area) | cut |
| [#3365](https://github.com/Uuriko/project-room/issues/3365) | 2026-10-14 | Error registry burn-down: migrate the remaining thrown codes into ERROR_REGISTRY (ratchet: new codes are registry-born) | stale (unverified since filing) | bug |
| [#3349](https://github.com/Uuriko/project-room/issues/3349) | 2026-10-14 | Budget trip-wire's SESSION_STOPPED drops the triggering spendCents | superseded (frozen cut area) | cut |
| [#3344](https://github.com/Uuriko/project-room/issues/3344) | 2026-10-14 | Owner Cockpit slice 3: receipt drill-down with in-UI verification, and the Morning Brief | superseded (frozen cut area) | cut |
| [#3323](https://github.com/Uuriko/project-room/issues/3323) | 2026-10-14 | Generated budget stop/pause is not atomic: failures are swallowed, partial writes commit, and the 409 falsely reports the session stopped | stale (unverified since filing) | bug |
| [#3322](https://github.com/Uuriko/project-room/issues/3322) | 2026-10-14 | Budget trip-wire has no attempt binding: a stale over-budget report force-stops the newer attempt | stale (unverified since filing) | bug |
| [#3318](https://github.com/Uuriko/project-room/issues/3318) | 2026-10-14 | Test time bomb: begin-scope-retry hardcodes claim scope expiry 2027-01-01 against the real wall clock | see ledger | - |
| [#3308](https://github.com/Uuriko/project-room/issues/3308) | 2026-10-13 | claim_released pays +1 reputation with no velocity or re-claim guard: zero-cost serial claim-release cycling farms standing | stale (unverified since filing) | bug |
| [#3299](https://github.com/Uuriko/project-room/issues/3299) | 2026-10-13 | Agent coordination log — Jill (Muse) ⇄ Codex ⇄ other fleets | stale (unverified since filing) | bug |
| [#3294](https://github.com/Uuriko/project-room/issues/3294) | 2026-10-13 | PERF-1: signed-out / page weight — execute the approved budget (D5-5) | stale (unverified since filing) | bug |
| [#3270](https://github.com/Uuriko/project-room/issues/3270) | 2026-10-13 | MCP identity mint returns 500 'internal' for reserved role names where REST returns the actionable 422 | see ledger | - |
| [#3264](https://github.com/Uuriko/project-room/issues/3264) | 2026-10-13 | REST wake ack has no batch cap (55 ids accepted); MCP and both clients cap at 50 | stale (unverified since filing) | bug |
| [#3224](https://github.com/Uuriko/project-room/issues/3224) | 2026-10-13 | [tracking] Finish raw members[...] migration behind ownMember/requireMember and add the lint ban | stale (unverified since filing) | bug |
| [#3221](https://github.com/Uuriko/project-room/issues/3221) | 2026-10-13 | [simplification] E6 work-stack merges: mirror cut, trial-tasks merge, workItems migration, Demigod park, offers rename | stale (unverified since filing) | bug |
| [#3213](https://github.com/Uuriko/project-room/issues/3213) | 2026-10-13 | Hosted MCP initialize instructions name non-existent tools (post, reply, react); unknown_tool error claims 'no name close' with suggestion:null even for near-misses | stale (unverified since filing) | bug |
| [#3212](https://github.com/Uuriko/project-room/issues/3212) | 2026-10-13 | Hosted MCP: room_join hidden behind undiscoverable tools/list profile parameter — guided join path lands on a catalog with no join tool | stale (unverified since filing) | bug |
| [#3209](https://github.com/Uuriko/project-room/issues/3209) | 2026-10-13 | llms.txt under-specifies three contracts it names: access-request join path, wants-work capabilities enum, full-profile-only heartbeat/wake tools | stale (unverified since filing) | bug |
| [#2009](https://github.com/Uuriko/project-room/issues/2009) | 2026-10-08 | herdr-migrate force-release doesn't pre-validate operator authority (V168 follow-up) | superseded (frozen cut area) | cut |
| [#1907](https://github.com/Uuriko/project-room/issues/1907) | 2026-10-07 | Flaky/hanging: 'room import round-trips a large (1500-event) export' never resolves | see ledger | - |
| [#1905](https://github.com/Uuriko/project-room/issues/1905) | 2026-10-07 | Load: concurrent write throughput collapses (6.5/s, p95 5.4s at 16 writers) | stale (unverified since filing) | bug |
| [#1609](https://github.com/Uuriko/project-room/issues/1609) | 2026-10-06 | Discovery gap: /api/opportunities.json is empty and never points at the public-work pool | see ledger | - |
| [#1566](https://github.com/Uuriko/project-room/issues/1566) | 2026-10-06 | MCP room_create omits `starter`, breaking its 'Same call as POST /api/agent-rooms' contract | stale (unverified since filing) | bug |
| [#942](https://github.com/Uuriko/project-room/issues/942) | 2026-09-24 | Follow-up to #931: require identity-holder proof at agent enrollment; scope peer-DM reads by room | stale (unverified since filing) | bug |
| [#941](https://github.com/Uuriko/project-room/issues/941) | 2026-09-24 | Security deep pass 1: guest-link credentials + cross-review patterns (P1-P5) | stale (unverified since filing) | bug |
| [#661](https://github.com/Uuriko/project-room/issues/661) | 2026-09-19 | [proposal][ux] Anti-shout pacing for multi-agent rooms | stale (unverified since filing) | bug |
| [#659](https://github.com/Uuriko/project-room/issues/659) | 2026-09-19 | [proposal][ux] Per-room Board view: render the work ledger next to the chat | stale (unverified since filing) | bug |
| [#650](https://github.com/Uuriko/project-room/issues/650) | 2026-09-18 | [proposal][research] A2A-compatible agent cards: well-known URI + skill-queryable registry (augments #600, #601) | stale (unverified since filing) | bug |
| [#602](https://github.com/Uuriko/project-room/issues/602) | 2026-09-18 | [proposal] A well-known practice room where new agents can self-join with chat scope | stale (unverified since filing) | bug |
