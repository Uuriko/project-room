# Claude handbook contribution, 2026-10-28

From: Claude (Opus, cloud seat), muse-room. For: project-room-living-handbook.md (Member 2, canonical editor).
Format: source / evidence / decision / next check. Status per entry: VERIFIED or PROPOSED.
Main at time of writing: aaa74906. Nothing below is deployed.

## 1. Main went red from the pairing schema stamp [VERIFIED, FIXED]
- Source: #4957 merge a6fc794c; fix #5131 (merged 594b44e1, 06:45Z).
- Evidence: bisect ca7fe6d4 = 0 fail, a6fc794c = 5 fail. A room stamped by the pre-fix deploy woke with 0 of 4 pairing tables; with the fix, 4 of 4.
- Decision: no deploy of main until #5131 landed; it never shipped.
- Next check: schema-stamp-coverage test guards it; new additive schema must join roomSchemaStamp.

## 2. Work items and Board claims store one unit of work twice [VERIFIED read; fix PROPOSED]
- Source: server/work-item-board.mjs (one-way sync, divergence monitor); src/board-ui.js:836 (second create form); server/owner-attention.mjs:153.
- Evidence: a person can see "something to do" in 10 places; Overview and Catch up read items, Decisions and the Board read claims.
- Decision: Jill filed it as the lead input for the typed-object phase; no build this wave.
- Next check: when chartered, claims become the only record and items a view of them.

## 3. Job-alarm write gate [VERIFIED; branch claude/arm-after-writes-on-5092 @ 7cae79d8, with Codex]
- Evidence: every request re-ran the alarm scheduler (21 ms and 3,000 rows at 3k claims). Write detection is now a read allowlist; the only statements that changed class are boot-time DDL. Authenticated needs-me polls do not re-arm (mutation-checked). Workerd jobs-alarm 10/10.
- Next check: Codex qualification at exact head.

## 4. Type scale [step 1 VERIFIED #5140; step 2 PROPOSED]
- Evidence: 11% of font-size declarations used tokens. #5140 moves 80 exact equals onto tokens with 0 computed-style differences across about 10,700 elements in 8 views.
- Decision (with Codex): sizes by role; 12 px floor for readable text; 11 px only for optional counters after zoom checks.
- Next check: area by area with screenshots, long names, dark and light, 200% text; Member 2's areas after their work lands.

## 5. Answer-credential stamp and ask_owner [VERIFIED; #5146, #5148 stacked]
- Evidence: a human's access key, identity secrets, API keys and agent sessions all resolve to the linked member, so terminalActorId cannot prove a person answered. Responses are now stamped answerCredential = account_session or room_credential, from server auth. ask_owner opens a reply request to the agent's accountable human and returns at once. Mutation-checked; unit-ci affected 1019/0.
- Decision (Codex): proves who answered, never permission to execute; v1 returns immediately; one open ask per agent.
- Next check: land #5146 then #5148; MCP twin after the catalog PRs settle; any UI is Member 2's call.

## 6. Room file quota [VERIFIED; #5149, Fo-verified]
- Evidence: Fo's 409s came from the uploader's 8 MiB byte cap with about 6 KB left, counting staged and DM files other members cannot see.
- Decision: the 409 now names the limit, used, max and remaining.
- Next check: product call for John or Codex: committed files never expire and cannot be deleted.

## 7. Presence refresh control [VERIFIED; #5135 then #5150, Fo's patch]
- Evidence: the control shows only when stale; a never-checked room offers refresh after 60 s. The people-rail check failed because its test held the wrong room's presence route, not the app.
- Next check: land #5135 then #5150.

## 8. First "@Room" ask makes no run (Fo, C10) [VERIFIED root cause; fix in Fo's patch]
- Evidence: the client routes the ask from a cached assistant status refreshed only by a poll; configuring the assistant emits no room event. Single-human rooms fail the same way. Confirmed independently by Fo.
- Decision: Fo's server-derived intent (claim fo-firstask-intent-server-20261028); #5064 keeps the 3 s poll until an assistant is connected.
- Next check: Jill pushes Fo's patch; exact-head review.

## 9. Production readiness flapping [OPEN, Codex's lane]
- Evidence: build ca37fee4 unchanged; DELTA 14:04Z 2 of 5 reads OK (1 s server-object timeouts); Fo 14:18Z 4 of 4 failed; claim-prs 40 failed triggers in a row.
- Next check: incident lane; per-room objects are the structural fix.

## Landing queue (green at head)
#5064 392b6de8, #5100 024df9fa, #5121 3b026172, #5135 4815725f, #5150 a5b8ec58 (on #5135), #5139 d10de5ce, #5140 846bbf50, #5146 58dfe47a, #5148 cc64312a (on #5146), #5149 f983d59a.
