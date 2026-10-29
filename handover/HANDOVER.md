# Claude (cloud seat) handover to Codex, 2026-10-28

## Update, 02:25Z on 2026-10-29: final and complete

Everything Claude did after the first handover is listed here, and Codex owns all of it. Claude holds no claims, leases, branches or open tasks, and will not push to any branch below unless Codex asks.

| Item | Current head / file | State | Codex's next decision |
|---|---|---|---|
| Planner `claude/train-planner` | `f39f14a189094904717b2386bf2261539fd0801f` | Batch size and CLI validated; boundary tests 7/7; JSON `handoff` gives exact base, ordered heads, regenerate list, simulated tree. Member 2 reviewed f39f14a (21803): zero-batch finding closed. Limits: the five-check filter is advisory; later batch bases are symbolic until batch N is really composed. | Whether Grok's gate consumes `handoff[0]` (recommendation in `planner-zero-batch-and-lander-recommendation.txt`). Jill still holds `merge-queue-worker.mjs` undecided. |
| #5159 `claude/drawer-scrim` | `beda400664e91adf57bf98a85d95688e8f191a4c` (Codex's fix on top of Claude's) | Claude reviewed beda4006 (21774): no blocker. | Land when green. |
| #5167 | `d7d12acb` | Failing shard 6/6: `chat-suggestions-browser-check` "the tap posted an ordinary message". Passes 2/2 locally at main and at head: likely flake. | Rerun the browser job. |
| First batch proposal | `release-readiness-reconciliation.txt` | #5157, #5158, #5161, #5064, #5149: all green at head, no prerequisites, compose on aaa74906 with zero conflicts (git merge-tree). #5161 adds one column via a registered ensure helper. | Give to Grok, or reject. |
| Readiness suspect | `readiness-suspect.txt`, `readiness-source-findings.txt` | A full room read is now 12+ MB. Browser tabs do a full read after 24 windowed refreshes. `room.request` logs exist (path only, so tell views apart by appMs). Not proven; no load experiment was run, per Codex. | Instinct-3 owns the incident; correlate `room.request` with /api/ready failures. |
| Journey gap | `journey-gap-review.txt` (sent to Member 2, 21782) | By default, work a human asks for has no reviewer: the card says "Completed" and Updates says "Nothing needs you". Proposed: default the asking human as decision maker. | Owner for the workflow/Updates change. |
| Review of #5169 | `review-5169.txt` | No blocker; badge width note. | None. |
| Offer to Grok (21827) | | Claude offered post-landing main verification. Withdrawn: it moves to Codex with everything else. | Whether you want it. |
| Fleet sync from Jill (21821) | | Claude answered that all work is Codex's. | None. |

John asked Claude to hand over all its Project Room work to Codex. This file is the full list. Main is `aaa749065a` (no merges since 08:00Z). Production is `ca37fee4`. Nothing below is merged or deployed.

Room seat: `ai_QjkNRXDiuvQ9Q86G`. All work items below have no open claims held by Claude; the claims are closed or never opened.

## 1. Open PRs (all `ready-to-land`, green at head unless noted)

| PR | Head | What | Notes |
|---|---|---|---|
| #5064 | 392b6de8 | Human panel refreshes on room events; idle poll stays 3 s until an assistant is connected | C10-safe; Fo verified |
| #5100 | 024df9fa | Room open skips a redundant first-open read | #5120 stacks on it |
| #5120 | 6931eaf5 | Defer panel-only reads until the startup burst drains | stacked on #5100 |
| #5121 | 3b026172 | Sidebar: hide "Connected" while connected; one Invite entry | manifest-only conflict with #5135 |
| #5135 | 4815725f | Members header with avatar stack | #5150 stacks on it |
| #5150 | a5b8ec58 | Presence refresh only when stale (Fo's patch) | stacked on #5135; Fo verified |
| #5139 | d10de5ce | Rooms page disclosure rows | manifest-only conflict |
| #5140 | 846bbf50 | 80 font sizes onto type-scale tokens, 0 computed-style diffs | manifest-only conflict |
| #5146 | 58dfe47a | Reply requests: server stamps which credential answered | #5148 stacks on it |
| #5148 | cc64312a | `ask_owner` route: agent asks its accountable human | stacked on #5146 |
| #5149 | f983d59a | attachment_quota 409 names limit, used, max, remaining | Fo verified |
| #5157 | 1208b8d0 | Icons scale with text size | John's Tab: LAND-READY at this head |
| #5158 | 223504c6 | "Signed in until 7:01 PM"; Go to dialog title | John's Tab: LAND-READY at this head |
| #5159 | a85a0121 | Phone drawer scrim; focus returns to menu button | Member 2 reviewed |
| #5161 | 17f1bd3c | A late ack clears a timed-out mention (new `late_acknowledged_at` column via additive ensure) | Member 2 found and Claude fixed the ack-then-late-ack gap |
| #5167 | d7d12acb | Agent packet: enrollment before the setup pointer (door-join step 7) | no prerequisites |
| #5013 | 29bfe6fe | CI browser-shards timeout to 30 min | older |
| #3846 | 7ad607c0 | Login font 140 KB to 4.6 KB | older |

Closed by Claude today: #5151 (phone header; superseded by Member 2's local header).

## 2. Branches without PRs

- `claude/train-planner` @ `1b7eb748`: read-only merge-train planner (`scripts/train-plan.mjs`, `tests/train-plan.test.js`). Changes nothing on GitHub. Member 2 reviewed it; three fixes confirmed; one open item: zero-batch validation. Jill ruled it read-only and advisory; `merge-queue-worker.mjs` and landing machinery are untouched and undecided.
- `claude/door-join-client` @ `2432235c`: door-join pack steps 1, 2, 3, 5 (no focus grab on load, refresh-proof drafts, lazy `client.js` so the static JS closure goes 548,132 B to 113,371 B, honest `/rooms/<id>` copy). PR waits for #5050, #5055, #5047 per pack step 0. Steps 4 and 6 not started (4 waits for #5050/#5055 to leave `join.html`; 6 waits for #5061).
- `claude/arm-after-writes-on-5092` @ `7cae79d8`: job alarm re-arms only after writes. Diff `d5512d86..7cae79d8 --binary` sha256 `db3b4ac44e033d289533138abdb95d2486108b831c55c2965347721bba7df4a8`. Composes with #5126 (manifest-only conflict). Never qualified as a combined tree.

## 3. Assignments to hand back to Jill for re-routing

Jill routed four door packs to Claude (packs on `jill/design-packs-1028` @ `d7ad90b1`): door-auth-entry (blocked on Codex's step-0 fence), door-join (steps 1, 2, 3, 5, 7 done as above), door-landing (not started), door-invites client steps 3-4 (not started; waits on Codex's server steps). Ten further packs are held unassigned by Jill.

## 4. Research and findings (files in this folder)

- `pr-triage-REPORT.md`, `pr-triage.csv`: read-only triage of all 504 open PRs. The `CANDIDATE-MANIFEST.json` file is in 83 of 158 conflicts; 8 `cleanup/gN-combined` PRs replay 59 open PRs; 54 red PRs fail the same unit+test pair.
- `train-plan-output.*`: planner run at `aaa74906`. 374 considered, 213 green candidates, 154 fit 16 clean batches, 59 need rebase.
- `CLAUDE-HANDBOOK-CONTRIBUTION-1028.md`: nine verified findings for the living handbook (already folded into Member 2's Work Plan per Member 2).
- Flow plan (Claude Doc, John can share): problems with fixes; living-doc measurement (21 references in 2,090 room messages over 7 days; ETH AGENTS.md study); merge-train build plan borrowing from Prow Tide, bors, marge-bot and Zuul; GitHub's native merge queue needs an org-owned repo, this repo is owned by a personal account.

## 5. Open items and decisions waiting on John

1. Move the repo to a free GitHub org for the native merge queue, or approve a batch train on `merge-queue-worker.mjs`.
2. Room file quota: full room-wide; committed files never expire.
3. #4951 merge-queue ruleset: review hold, John's call.
4. Member 2 found a privacy gap in #3621 (account delete leaves the lot visibility mirror on); Claude's recommended first batch included #3621, so drop it from that batch.

## 6. Habits that worked

Read the agent inbox before every step (`GET /api/rooms/muse-room/agent-inbox?after=<cursor>`), answer with `replyToId` so the mention closes, claim exact files before editing, and push a branch as soon as shared files change.
