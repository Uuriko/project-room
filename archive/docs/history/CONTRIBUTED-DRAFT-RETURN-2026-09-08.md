# Returning to a contributed draft

## Problem and decision

Previous goal turn made progress: qualified the voluntary-help flow, fixed tall
mobile-message navigation and retained actual scripted MCP/human-browser evidence.
The remaining return gap is visible in code: contributionSteps considers only
work lifecycle handoffs and explicit requests. A current draft on accepted work
still leads to “Ready to start”; on working work it creates no useful return step.
The existing work card has View latest draft, but requires finding the work first.

[Linear Inbox](https://linear.app/docs/inbox) groups relevant work attention;
[Slack Activity](https://slack.com/help/articles/19693583638803-Get-your-work-done-from-the-Activity-view)
supports acting from the attention view. Primary documentation inspected September
8, 2026. Borrow the direct route to relevant content, not a notification system or
an assumption that unread messages are unresolved work. No source code is copied.

## Bounded plan

1. Reproduce the gap in the existing helper journey: human reloads after a helper
   posts the agreed draft; no task completion, approval or human read-marker change.
2. Derive one draft-return step per work item in the existing contribution selector.
   Choose only the latest canonical work-linked proposal, based on the exact
   current work revision, where the accountable viewer can currently submit a
   result according to existing workActions. Missing permissions/claims, proposed,
   blocked, completed and retired work retain their existing lifecycle behavior.
   Do not skip a newer stale draft to silently promote an older one.
3. Replace an existing start step rather than count it twice. Working work with a
   current actionable draft gains one step. Label “Draft to inspect”, button
   “View draft”; explicit questions and final result reviews remain higher priority.
4. Reuse the existing shortcut and catch-up list. Open the exact message, not a
   submission dialog. Ordinary messages, read markers and viewing cannot complete
   work. Preserve keyboard focus, current-state reconciliation and other drafts.
5. Test latest ordering, stale/future basis, permissions, write-claim expiry, other
   viewers, working work, adoption/removal and duplicate counts. Extend desktop/touch
   actual scripted MCP journeys with reload, catch-up and keyboard/message selection.
   Inspect screenshots before and after, rerun regression tests, retain a package.

No new controls, persistent state, endpoint, tool, schema, notification, dismissal,
execution, analytics or provider integration. Agent lifecycle nextWorkStep remains
unchanged: a draft is conversation until deliberately adopted. This human return
hint is not a new watcher notification or agent assignment. Historical/older drafts
remain accessible through the existing card even when not offered as current work.

## Now / next / later

- Now: returning to current actionable contributions through existing controls.
- Next: explicit help-wanted opt-in and contribution scope before broad discovery;
  multiple outstanding helpers and changed work while an offer is pending.
- Later: native-host acceptance, independent hosted recovery and authorized release.
  Real user/retention evidence remains unmeasured; local simulations prove mechanics.

## Implementation and findings

Runtime `51045a125342fe5ed419a587d4453236c3af0cdb` changes only the human-facing
contribution derivation and return rendering. Latest proposals are indexed in
canonical message order, not untrusted timestamps. A matching revision and the
existing currently permitted completion action are required for the shortcut.
Accepted work replaces its start suggestion; working work gains one return row.
The same work is excluded from “Other open work”. Result review and explicit
requests retain priority; stable work keys preserve existing focus handling.

Opening a draft reveals its exact message and focuses it. No form opens, no work
state changes and no read marker advances. Work-card lifecycle status and the
existing View latest draft link remain truthful and available separately. This is
presentation-only; agent nextWorkStep, watcher notices, service authority and
storage contracts are unchanged. The selector uses maps rather than repeatedly
scanning the growing task list for every contributed draft.

Both new browser expectations failed against runtime856940c: after reload the
shortcut stayed “Ready to start”. Two before screenshots are retained. With the
change, desktop returns to accepted work and touch returns to explicitly started
work. Each sees one “Draft to inspect” catch-up row, no duplicate ongoing row,
then opens the exact message using Enter on the existing shortcut. The original
flow continues through accountable adoption with contributor attribution and
independent scripted review, leaving human approval pending and all markers zero.

Three new pure tests cover current/working drafts, canonical ordering, newer stale
proposals, older/future/missing basis, ordinary messages, acceptance, blockers,
completion, replacement, permissions, write claims/expiry and other viewers.
Eight focused browser journeys pass: helper return, simultaneous attention,
reconnect and crowded reconnect in desktop/touch modes. An initial targeted
command named a nonexistent standalone simultaneous-attention file; only its two
helper tests ran. The corrected command uses reconnect-collaboration-browser-check,
where those scenarios actually live, and all eight pass. No coverage is inferred
from a requested but unmatched filename.

Two before and six after return screenshots were visually inspected: shortcut,
expanded catch-up and focused draft. The touch before image used accepted work;
the final touch journey additionally starts work, so it is not an otherwise
identical state comparison. Desktop before/after isolates the accepted-work label
and destination change. Enlarged-text adoption/review remains covered by the
extended helper journey and existing regression cases.

No user study, native model, retention lift, push, deployment, live migration,
provider change, new automation or existing preview restart is claimed.

## Remaining design questions

- A viewed draft remains unresolved contribution context, not an unread badge.
  Should there be an explicit “not using this draft” decision? Do not infer it
  from reading, acknowledging catch-up or an agent returning no answer. Explore
  this with multi-helper workflows before adding another dismissal state.
- A room-wide help-wanted signal needs a named owner, bounded contribution scope,
  current revision and clear withdrawal/expiry behavior. It must not make every
  assigned task a public job, replace assignment or imply permission to execute.
- Multiple helpers may propose different drafts on one revision. This shortcut
  navigates to the latest canonical proposal, not the best-ranked proposal; it
  does not endorse the author or choose a winner. A comparison path may become
  useful, but should be triggered by actual competing contributions.
- “Pasted draft” in existing conversation copy is narrower than the supported
  scripted-agent and human contribution routes. Consider shortening it to “Draft”
  during the next copy pass while preserving revision and attribution context.

## Final qualification

- 587 core/API/package checks pass, including three new selector tests.
- All 182 browser tests pass at the frozen runtime (179 seconds), including the
  expanded accepted/working helper returns and existing mobile/keyboard/large-text,
  permission-loss, stale-session, focus and exact-evidence scenarios.
- 14 local Workers checks pass, including browser and populated schema12 exact
  candidate → pause → fallback → candidate recovery.
- Two exact-commit desktop/touch fallback browser journeys pass.
- Candidate verifies at `../project-room-runtime-packages-20260908/candidate-51045a1`
  relative to repository root: 65 runtime files, 19 public assets, schema/writer12.
  Source tree: `46fca490106a73fb4b8432cc93d86910549e8343`.
  Manifest SHA256: `44e006155a06cadeeef90d661de1cdb203e71f40dea46dafa91d22ac8340f359`.
  Only `src/app.js` and `src/work-selectors.js` differ from candidate856940c.
  Fallback4d22189 is unchanged. An initial package CLI invocation omitted required
  arguments and created nothing; corrected exact-commit packaging then verified.
- Eight inspected screenshots (two before/six after), two validated final journey
  JSON records and four successful full verification logs are retained at
  `../project-room-runtime-packages-20260908/evidence-contributed-return`.
  Screenshots/JSON were retained after the successful targeted eight-case run;
  the later full-suite log independently covers the same frozen runtime/journeys.

The candidate is committed locally, not pushed or deployed. Source and handoff
claims are released at checkpoint. Broader goal remains active and incomplete;
native-host acceptance, hosted recovery and real-user evidence are not inferred.
