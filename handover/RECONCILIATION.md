# Reconciliation of Claude's 18 PRs and 3 branches against the total backlog

Main `aaa749065a`. Backlog `docs/backlog/project-room-total-backlog.json` captured 2026-10-18, 773 items. Read-only. Existing IDs come only from backlog url fields matching numbers the PR references. Candidate obligations are keyword matches on titles and are NOT verified. Overlaps come from the 2026-10-28 triage file lists (generated manifest excluded).

## Headline

- Existing obligation IDs found: 1 of 18 PRs. The backlog predates every PR except #3846, so most work has no backlog ID yet.
- Required checks green at head: 14 of 18.
- Conflicting with current main: #5120.

## PRs

### #5064 Human panel: refresh on room events, slow the fallback poll

- Head `392b6de83e6a`. Refs: none. Existing IDs: none.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: Fo verified at cf2a35c9 (seq 20234); re-verify at 392b6de8.
- Candidate obligations (unverified): EXE-10 (open) Preserve Retry-After minima, permanent-auth refusal and assistant_run_; GH-I-3413 (needs-verification) [Perf][Medium] Room/board reads are O(board) per request: 2,000-item b; GH-I-3640 (needs-verification) llms.txt: wake poll without hostId does not 422 for an agent with a re.
- Overlapping open PRs (candidates): #5044 [UNKNOWN] Preserve Share result drafts across closing and re (src/human-experience.js).
- Incomplete evidence: CI ran 4 commits behind main at triage time; re-run at composed head.

### #5100 room open: skip the redundant first-open room re-read

- Head `024df9fa6b34`. Refs: #4948. Existing IDs: none.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: none recorded.
- Candidate obligations (unverified): ADP-07 (open) Evaluate bounded speculative preparation on authorized read-only data ; API-02 (open) Provide field selection, conditional reads, stable pagination, resourc; API-03 (open) Add bounded parallel batch reads with declared watermark consistency a.
- Overlapping open PRs (candidates): #5120 [UNKNOWN] room open: defer panel-only reads until the startu (src/client.js, tests/client-recent-refresh.test.js, tests/client.test.js); #4868 [UNKNOWN] Drop the snapshot event log and append new posts (src/client.js, tests/client-recent-refresh.test.js, tests/client.test.js); #4857 [LANDED-ELSEWHERE] Window the default room load to the newest 50 mess (src/client.js, tests/client-recent-refresh.test.js, tests/client.test.js).
- Incomplete evidence: CI ran 25 commits behind main at triage time; re-run at composed head; no independent review record found.

### #5120 room open: defer panel-only reads until the startup burst drains (stacked on #5100)

- Head `6931eaf5a655`. Refs: #5100. Existing IDs: none.
- Prerequisites: #5100.
- Checks: test skipped, contract skipped, lint skipped, browser skipped, cloudflare skipped. Review: none recorded.
- Candidate obligations (unverified): ADP-07 (open) Evaluate bounded speculative preparation on authorized read-only data ; API-02 (open) Provide field selection, conditional reads, stable pagination, resourc; API-03 (open) Add bounded parallel batch reads with declared watermark consistency a.
- Overlapping open PRs (candidates): #4868 [UNKNOWN] Drop the snapshot event log and append new posts (src/app.js, src/client.js, tests/client-recent-refresh.test.js); #5100 [CANDIDATE] room open: skip the redundant first-open room re-r (src/client.js, tests/client-recent-refresh.test.js, tests/client.test.js); #4899 [UNKNOWN] Hide empty overview sections, skip caught-up brief (src/app.js, src/client.js, tests/client.test.js).
- Incomplete evidence: required checks not green at head: test=skipped, contract=skipped, lint=skipped, browser=skipped, cloudflare=skipped; CI ran 25 commits behind main at triage time; re-run at composed head; no independent review record found; conflicts with current main: scripts/CANDIDATE-MANIFEST.json.

### #5121 room screen: hide "Connected" while connected; one Invite entry in the sidebar (NEXT-6 slice)

- Head `3b026172e6ef`. Refs: #5085. Existing IDs: none.
- Prerequisites: manifest-only conflict with #5135 after either lands.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: none recorded.
- Candidate obligations (unverified): GH-I-3379 (needs-verification) Invite redeem: mint-vs-link fork is unsignaled in the 201 response and; GH-I-3672 (needs-verification) agent-invites: legacy v1 invite codes — header comment contradicts cod; GH-I-3794 (needs-verification) Creating an invite link never surfaces the new link's URL — the dialog.
- Overlapping open PRs (candidates): #5158 [CANDIDATE] Plainer account menu and Go to dialog copy (index.html, src/app.js); #5150 [CANDIDATE] presence: Refresh availability only when stale (Fo (index.html, src/app.js); #5135 [CANDIDATE] room sidebar: Members header with an avatar stack; (index.html, src/app.js).
- Incomplete evidence: CI ran 6 commits behind main at triage time; re-run at composed head; no independent review record found.

### #5135 room sidebar: Members header with an avatar stack; list who is around now (NEXT-6 slice)

- Head `4815725f077b`. Refs: #5121. Existing IDs: none.
- Prerequisites: manifest-only conflict with #5121.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: none recorded.
- Candidate obligations (unverified): API-09 (open) Complete cold agent onboarding through identity, first useful work, me; GH-I-3211 (needs-verification) AGENT-START-HERE ends at first public-work receipt: no route to room m; GH-I-3224 (needs-verification) [tracking] Finish raw members[...] migration behind ownMember/requireM.
- Overlapping open PRs (candidates): #5150 [CANDIDATE] presence: Refresh availability only when stale (Fo (index.html, src/app.js, src/conversation.js); #5094 [UNKNOWN] Add account-bound room requests and explicit first (index.html, src/app.js, src/styles.css); #4946 [RED] G4: Room UI design pass (index.html, src/app.js, src/styles.css).
- Incomplete evidence: CI ran 6 commits behind main at triage time; re-run at composed head; no independent review record found.

### #5150 presence: Refresh availability only when stale (Fo's patch, stacked on #5135)

- Head `a5b8ec584443`. Refs: #5135. Existing IDs: none.
- Prerequisites: #5135.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: Fo verified at a5b8ec58.
- Candidate obligations (unverified): PRO-05 (open) Define conversation-first navigation with one useful default assistant.
- Overlapping open PRs (candidates): #5135 [CANDIDATE] room sidebar: Members header with an avatar stack; (index.html, src/app.js, src/conversation.js); #5094 [UNKNOWN] Add account-bound room requests and explicit first (index.html, src/app.js, src/styles.css); #4946 [RED] G4: Room UI design pass (index.html, src/app.js, src/styles.css).
- Incomplete evidence: CI ran 6 commits behind main at triage time; re-run at composed head.

### #5139 rooms page: visible New room / Account disclosure rows; tidy Join room (NEXT-6)

- Head `d10de5ce5032`. Refs: #5121, #5135. Existing IDs: none.
- Prerequisites: manifest-only conflict.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: none recorded.
- Overlapping open PRs (candidates): #5159 [RED] Dim the room behind the phone menu drawer (src/styles.css); #5157 [CANDIDATE] Icons grow with the reader's text size (src/styles.css); #5150 [CANDIDATE] presence: Refresh availability only when stale (Fo (src/styles.css).
- Incomplete evidence: CI ran 6 commits behind main at triage time; re-run at composed head; no independent review record found.

### #5140 styles: use type-scale tokens where raw sizes already equal them (no visual change)

- Head `846bbf50b05b`. Refs: #5094, #5135, #5139. Existing IDs: none.
- Prerequisites: manifest-only conflict.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: none recorded.
- Candidate obligations (unverified): API-13 (open) Measure model turns, transport calls, bytes, tokens, total accepted-ta; CTX-12 (open) Measure retrieval accuracy, missing-evidence failures, context bytes/t; GH-I-3545 (needs-verification) Core work-claim leases have no fencing token: finish path is gated by .
- Overlapping open PRs (candidates): #5159 [RED] Dim the room behind the phone menu drawer (src/styles.css); #5157 [CANDIDATE] Icons grow with the reader's text size (src/styles.css); #5150 [CANDIDATE] presence: Refresh availability only when stale (Fo (src/styles.css).
- Incomplete evidence: CI ran 4 commits behind main at triage time; re-run at composed head; no independent review record found.

### #5146 reply requests: server stamps which credential answered (ask_owner part A)

- Head `58dfe47a2cc2`. Refs: none. Existing IDs: none.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: Codex review points addressed (Claude's claim); no independent LAND-READY record.
- Candidate obligations (unverified): CTX-09 (open) Track tool availability, version, workspace grants, credential readine; GH-I-3602 (needs-verification) Feedback scrubber stores the product's own credentials (pri_/rak_/ga1.; GH-I-3625 (needs-verification) dr: no operator procedure for post-restore credential re-issue or firs.
- Overlapping open PRs (candidates): #5148 [RED] ask_owner: one call to ask your owner, returns at  (client/reply-actions.mjs, client/work-actions.mjs, server/store.mjs); #4864 [STALE-CONFLICTING] Fix error codes, owner gates, and MCP room-key cop (client/reply-actions.mjs, client/work-actions.mjs, server/store.mjs); #5080 [RED] feat(native): expose identity-bound Room collabora (client/work-actions.mjs, server/store.mjs).
- Incomplete evidence: CI ran 4 commits behind main at triage time; re-run at composed head.

### #5148 ask_owner: one call to ask your owner, returns at once; read the outcome later (part B, stacked on #5146)

- Head `cc64312ae6db`. Refs: #5146. Existing IDs: none.
- Prerequisites: #5146.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: none recorded.
- Candidate obligations (unverified): ADP-12 (open) Measure sustained net improvement after evaluation, human oversight an; ART-04 (open) Preserve simultaneous human and agent edits; evaluate CRDTs for mergea; CTX-04 (open) Expose what work is using so humans can add, correct or exclude contex.
- Overlapping open PRs (candidates): #5094 [UNKNOWN] Add account-bound room requests and explicit first (docs/openapi.yaml, plugins/project-room/skills/project-room/references/errors-catalog.md, scripts/runtime-package.mjs); #4943 [RED] G9: Decision records (docs/openapi.yaml, plugins/project-room/skills/project-room/references/errors-catalog.md, scripts/runtime-package.mjs); #4942 [RED] G5: Agent front door and discovery (docs/openapi.yaml, plugins/project-room/skills/project-room/references/errors-catalog.md, scripts/runtime-package.mjs).
- Incomplete evidence: CI ran 4 commits behind main at triage time; re-run at composed head.

### #5149 room files: attachment_quota 409 names the limit, used, max and remaining

- Head `f983d59abbb6`. Refs: #5102. Existing IDs: none.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: Fo verified.
- Candidate obligations (unverified): ARC-14 (open) Measure unrelated files/domains touched, merge conflict burden and new; ART-06 (open) Distinguish local-only files from uploaded, durable shared artifacts a; COV-01 (open) Inventory active and archived Project Room chats, local session indexe.
- Overlapping open PRs (candidates): #5148 [RED] ask_owner: one call to ask your owner, returns at  (plugins/project-room/skills/project-room/references/errors-catalog.md, skills/project-room/references/errors-catalog.md, src/agent-error.mjs); #5094 [UNKNOWN] Add account-bound room requests and explicit first (plugins/project-room/skills/project-room/references/errors-catalog.md, skills/project-room/references/errors-catalog.md, src/agent-error.mjs); #5080 [RED] feat(native): expose identity-bound Room collabora (plugins/project-room/skills/project-room/references/errors-catalog.md, skills/project-room/references/errors-catalog.md, src/agent-error.mjs).

### #5157 Icons grow with the reader's text size

- Head `1208b8d0b832`. Refs: #5151. Existing IDs: none.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: John's Tab LAND-READY at 1208b8d0 (seq 21359).
- Candidate obligations (unverified): NATIVE-MAC01 (needs-verification) supportedOS/hardware/Intel-AppleSilicon matrix chosen from actualusers; UI-13 (open) Qualify keyboard, screen-reader, IME, reduced-motion, zoom, narrow/mob.
- Overlapping open PRs (candidates): #5159 [RED] Dim the room behind the phone menu drawer (src/styles.css); #5150 [CANDIDATE] presence: Refresh availability only when stale (Fo (src/styles.css); #5140 [CANDIDATE] styles: use type-scale tokens where raw sizes alre (src/styles.css).

### #5158 Plainer account menu and Go to dialog copy

- Head `223504c6a92d`. Refs: none. Existing IDs: none.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: John's Tab LAND-READY at 223504c6 (seq 21335).
- Overlapping open PRs (candidates): #5150 [CANDIDATE] presence: Refresh availability only when stale (Fo (index.html, src/app.js); #5135 [CANDIDATE] room sidebar: Members header with an avatar stack; (index.html, src/app.js); #5121 [CANDIDATE] room screen: hide "Connected" while connected; one (index.html, src/app.js).

### #5159 Dim the room behind the phone menu drawer

- Head `a85a0121f9ed`. Refs: none. Existing IDs: none.
- Checks: test failure, contract success, lint success, browser failure, cloudflare success. Review: Member 2 reviewed a85a0121 focus fix requests; no LAND-READY record.
- Candidate obligations (unverified): GH-I-3740 (needs-verification) Session-one (mobile): a human cannot claim public work — every offer e; GH-I-3744 (needs-verification) Mobile tap targets under 44px across public and owner surfaces (measur; UI-13 (open) Qualify keyboard, screen-reader, IME, reduced-motion, zoom, narrow/mob.
- Overlapping open PRs (candidates): #5150 [CANDIDATE] presence: Refresh availability only when stale (Fo (src/app.js, src/styles.css); #5135 [CANDIDATE] room sidebar: Members header with an avatar stack; (src/app.js, src/styles.css); #5094 [UNKNOWN] Add account-bound room requests and explicit first (src/app.js, src/styles.css).
- Incomplete evidence: required checks not green at head: test=failure, browser=failure.

### #5161 Mentions: a late ack clears a timed-out mention from the open list

- Head `17f1bd3c8a1e`. Refs: none. Existing IDs: none.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: Member 2 reviewed; ack-then-late-ack fix at 17f1bd3c not re-reviewed.
- Candidate obligations (unverified): GH-I-3948 (needs-verification) Agent inbox after-cursor silently loses messages: burst over limit is ; ADP-10 (open) Detect drift and regressions; retain policy versions, explanation, rol; API-09 (open) Complete cold agent onboarding through identity, first useful work, me.
- Overlapping open PRs (candidates): #5148 [RED] ask_owner: one call to ask your owner, returns at  (server/store.mjs); #5146 [CANDIDATE] reply requests: server stamps which credential ans (server/store.mjs); #5138 [CANDIDATE] Search coherence (Option A): newest-first ordering (server/store.mjs).

### #5167 Agent packet: enrollment before the setup pointer in the named-room section

- Head `d7d12acb79a3`. Refs: #4448, #5047, #5050, #5055. Existing IDs: none.
- Checks: test cancelled, contract None, lint None, browser cancelled, cloudflare None. Review: none recorded.
- Candidate obligations (unverified): GH-I-3209 (needs-verification) llms.txt under-specifies three contracts it names: access-request join; GH-I-3655 (needs-verification) llms.txt served by a non-production deployment links the production or; GH-I-3706 (needs-verification) llms-full.txt is smaller than llms.txt and is not a superset — the 'Fu.
- Incomplete evidence: required checks not green at head: test=cancelled, contract=None, lint=None, browser=cancelled, cloudflare=None; no independent review record found.

### #5013 ci: raise browser-shards timeout to 30 minutes

- Head `29bfe6fe5d9c`. Refs: none. Existing IDs: none.
- Checks: test success, contract success, lint success, browser success, cloudflare success. Review: none recorded.
- Candidate obligations (unverified): ADP-08 (open) Adapt concurrency, batching, retries and cache policies under stabilit; ADP-09 (open) Adapt context and memory policies with contradiction, deletion, freshn; ADP-11 (open) Prevent adaptive policies from granting themselves permissions or sile.
- Overlapping open PRs (candidates): #5062 [CANDIDATE] fix: isolate ineligible PR workflow concurrency (.github/workflows/test.yml); #5048 [CANDIDATE] docs(workflows): correct stale branch-protection c (.github/workflows/test.yml); #4951 [RED] Land green ready-to-land pull requests and deploy  (.github/workflows/test.yml).
- Incomplete evidence: CI ran 74 commits behind main at triage time; re-run at composed head; no independent review record found.

### #3846 Login font 140 KB -> 4.6 KB; document short merge-slot leases and code drops

- Head `7ad607c01c49`. Refs: #2833. Existing IDs: GH-PR-3846.
- Checks: test failure, contract success, lint success, browser success, cloudflare success. Review: none recorded.
- Candidate obligations (unverified): MAC-07 (open) Prove execution isolation before enabling automatic Mac agent actions;; NATIVE-MAC40 (needs-verification) launchatlogin optin and uninstall/logout do not leave unexplainedhelpe; NATIVE-MAC45 (needs-verification) localagent enrollment separatefromhumanlogin and membership..
- Overlapping open PRs (candidates): #4939 [RED] Treat the open-PR cap as a throughput signal (docs/ROOM-COORDINATION.md).
- Incomplete evidence: required checks not green at head: test=failure; CI ran 740 commits behind main at triage time; re-run at composed head; no independent review record found.

## Branches

### claude/train-planner @ `1b7eb748d84b`

- Read-only planner. Jill ruled advisory (seq 21696). Member 2 review: 3 fixes confirmed, zero-batch validation open (seq 21717).
- Candidate obligations (unverified): GH-I-3548 (needs-verification) Landing hero: collaboration front door (room, real receipt, live count; GH-I-4071 (needs-verification) Post-landing correction owed: PR #3953's three reviewed findings shipp.
- Incomplete evidence: zero-batch validation missing; never run against a composed CI result.

### claude/door-join-client @ `2432235c`

- door-join pack steps 1, 2, 3, 5 (workItemId design-2026-10-28-door-join). Prerequisites #5050, #5055, #5047 (pack step 0).
- Candidate obligations (unverified): GH-I-3796 (needs-verification) Join dialog stays open after a successful account creation — focus dro; GH-I-3209 (needs-verification) llms.txt under-specifies three contracts it names: access-request join; GH-I-3212 (needs-verification) Hosted MCP: room_join hidden behind undiscoverable tools/list profile .
- Incomplete evidence: pack §5.4 network trace (≤10 requests, ≤200 KB) not run; 113,371 B closure is above the 110 KB target; steps 4 and 6 not started.

### claude/arm-after-writes-on-5092 @ `7cae79d8`

- Job alarm re-arms only after writes. Composes with #5126 (manifest-only conflict).
- Candidate obligations (unverified): SCH-01 (open) Inventory existing jobs, alarms, heartbeats, watchers and manual autom; AUT-13 (open) Compare every automation with its manual/simple-rule baseline includin; GH-I-3980 (needs-verification) W-3 gate build 1: land.mjs polls job conclusion (not status) and refus.
- Incomplete evidence: combined tree with #5126 never qualified; no PR.
