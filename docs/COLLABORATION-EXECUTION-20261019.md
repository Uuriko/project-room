# Complete collaboration journey

## Outcome

Two people can start through chat, contribute and change a requirement, leave
and return, then inspect, use and discuss the exact result. Agents use the same
recorded work and permissions, with bounded ownership and resumable operations.
One person and one agent should require no additional management ceremony.

## Starting point

PR4260 (ab2e986b) is a draft above focused collaboration PR4244 and entry
PR4243. It is not deployed. Visible addressing, ordinary reply routing, compact
Work access, attributed contributions and draft recovery already exist. Agent
context, discussion, exact results, return briefs and claims also already exist.
Reuse these rather than introduce another task, memory or notification system.
Claude owns agent onboarding PR4258/4259. Release carrier4245 contains additional
account and invitation fixes; coordinate integration rather than overwrite it.

## Execution checklist

- [x] Read research, prompt, existing implementation and qualification.
- [x] Inspect exact-head hosted failures and coordinate overlapping ownership.
- [ ] Finish exact-text result use: copy, download, truthful feedback and retry.
- [ ] Keep loaded text pinned to its receipt, preserve formatting, fence late
  clipboard completions and deny actions after withdrawal/session changes.
- [ ] Connect result navigation where recorded provenance permits; ordinary
  assistant messages must not masquerade as verified stored results.
- [ ] Simplify repeated Work status and card copy without hiding questions,
  authorship, pending changes or recovery controls.
- [ ] Exercise the complete two-person/agent journey, including a changed
  requirement, disconnect, return, revision and duplicate response.
- [ ] Audit agent resume/context composition against that same scenario; repair
  demonstrated gaps without inventing inferred authorization or consensus.
- [ ] Resolve hosted browser failures: Inbox navigation, lazy workspace entry,
  unavailable Google and visual baseline. Inspect before changing assertions.
- [ ] Integrate onboarding/account carriers with their owners and preserve stack
  ancestry. Run required source qualification once the source is frozen.
- [ ] Merge through the coordinated release owner and deploy only the verified
  final revision; independently inspect production entry, assets and readiness.

## Acceptance

Copy and download preserve exact Unicode and whitespace, and fail visibly.
Drafts survive result reading and discussion. Keyboard navigation remains
nonmodal and restores origin focus; phone controls and both themes remain
usable. Stale requests cannot write into another room or reader. Conflicting
contributions remain attributed; explicit authorization remains authoritative.
Agent recovery uses the same command identity after uncertain delivery.

Local responsiveness is not server confirmation. Record actual test counts
and failures. Use bench:room only if covered storage/write/sync paths change.
Reuse unchanged-source evidence rather than repeat expensive suites by habit.

## Qualification and deferrals

At ab2e986b: full Node24 suite 11,375 passed,31 skipped; affected1,911 passed,
one skipped; lint passed with existing warnings. Hosted browser failures remain:
shard1 visual room-view1.10% differs (budget1%); shard6 Inbox collaboration,
lazy workspace navigation and unavailable Google; shard2 Inbox/room return
navigation. These are unresolved, not waived.

Simulations establish functional behavior, not real-human productivity.
Physical-device/provider qualification and public notarized Mac distribution
remain explicit limits. Developer ID is deferred. No recurring automation.

## Product boundary: email is deferred out of v1

John explicitly removed Inbox and email integrations from this release.
The app now mounts independent room navigation; email UI modules are archived
and excluded from public assets. Normal servers reject private Inbox/Gmail
endpoints. No production entrypoint enables the deferred server option, which
exists for isolated legacy backend fixtures. Email login/recovery, account
room navigation and the agent coordination inbox remain supported. Existing
stored data is preserved. The email-workspace browser suites are excluded from
the release command; new room-only checks cover the replacement experience.

## Current implementation and evidence

Exact result Copy text and Download text preserve the pinned body, including
Unicode and whitespace. Clipboard refusal reports a retryable error; pending
completion cannot populate a closed/replaced reader. Existing redacted summary
sharing remains distinct. Result reading/sharing/revision browser suite:33/33.

Returning to an already-open room now reuses the live session instead of entering
the destructive room-switch flow. Chooser navigation tests exercise actual room
selection. Initial navigation18 cases had16 passes and2 stale history
expectations; those2 now pass with the chooser destination explicitly asserted.
The private collaboration desktop/phone journeys also pass.

The long-room phone test reproduced a155px gap above the newest message. Multiple
layout changes invalidated the pin by changing its pixel offset. Pin ownership
now survives layout changes and is released by deliberate scrolling or focused
navigation. All3 relevant tests pass, including keeping read horizons unchanged
by layout and preserving Mark unread across reload.

The broader collaboration browser set passed37/37 (scripted humans and MCP
participants, not live-provider or real-human evidence). An earlier full unit
run was intentionally interrupted before the newly discovered return/pin fixes;
it is not a completed qualification. Final frozen-source qualification is now
running. Hosted visual baseline review and coordinated integration remain open.

After the scope change: room-only phone/desktop checks2/2 pass; chat and native
result smoke4/4 pass. The prior full-unit run was stopped on John's scope change,
not counted as qualification. The archived email UI is not a v1 acceptance gate.


### Email removal checkpoint

The v1 interface has no Inbox tab, email setup dialogs or mailbox modules.
Archived browser modules are not public assets. Default Node and Cloudflare
servers reject the private mailbox and Gmail OAuth routes; retained schema
and explicit compatibility fixtures preserve existing records and migration
coverage. The agent coordination inbox is unchanged.

Validation: room-only plus sign-in/recovery browser checks 22/22; account/start-room/layout browser checks 11/11; removal/coverage checks 11/11; room-roster/copy/walkthrough checks 16/16. Lint passes with 289 existing warnings. Initial broad runs exposed obsolete email assertions and historical package assumptions; repaired and being revalidated, not represented as a green release. Public deployment remains pending coordinated integration.


Final local removal checkpoint: affected suite 2165 pass, 1 skip, 2 cold-package failures; compatibility suite 46 pass, 1 cold-package failure. All three failures traced to empty entries left in the fixture asset list and pass in the corrected focused run (3/3). No other failures in these runs. Final room-only/accessibility browser run 7/7; runtime preflight passes. These are composed local receipts, not a claim of a fresh full-suite or hosted release pass. The earlier full suite (11331 pass, 43 fail, 31 skip) predates the metadata/packaging fixes and is superseded only for the explicitly rerun checks. No deploy performed.
