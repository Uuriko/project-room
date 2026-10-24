# Calm return: implementation and experiment plan

## Problem and selected slice

At b989af6 the mobile Work list precedes the return panel and can grow without a
height limit. The collapsed panel reports reminders but not current responsibility
or unread activity. Open catch-up leads with event numbers and repeats work. Two
explicit acknowledgement controls have different horizons: conversation uses the
latest room sequence, while the brief uses its frozen history boundary.

Visual thesis: **one quiet entry above the conversation; people and useful next
steps first, accounting details on request.** Keep the established dark theme,
ordinary conversation and keyboard sending. No tour, modal-on-join, hero, new
navigation system or illustrations. Root is sole writer under the Sites skill;
three subagents provide read-only research and independent review.

Implement one structural improvement, not a new inbox product:

1. Move the existing native catch-up details element immediately after the room
   heading and before conversation, in DOM order on every viewport. Keep it closed
   by default. Remove the duplicate conversation acknowledgement control.
2. Show truthful compact summary signals from the currently owned room snapshot:
   current needs and unread updates; private due/save-uncertain reminders retain
   their separate owned signal. Never sum overlapping task counts. Zero, loading
   and failed refresh are not interchangeable.
3. On open, lead with private reminders and current next steps. Cap the first
   responsibility view at five, with explicit Show all / Show less preserving
   keyboard focus. Other ongoing work remains a secondary disclosure and excludes
   items already in Needs you. Work links open the latest record, not a command.
4. Share existing work selectors between server and browser rather than copying
   responsibility logic. Derive current items from live owned room state while
   history remains frozen. Reevaluate claim time boundaries while visible.
5. Keep Updates/history drillable and paginated, with event boundaries inside its
   disclosure. Use a compact accessible refresh control. One Mark caught up button
   acknowledges exactly the brief's displayed horizon; newer arrivals remain new.
   Loading/reconciliation failures disable acknowledgement; opening, scrolling,
   links, reminders and refresh do not acknowledge or mutate work.
6. Preserve invitation and portable-work flows. The next growth slice is an optional
   previewed invitation note/one small ask, keeping Copy link unchanged by default;
   do not mix that separate state machine into this implementation checkpoint.

## State, authority and failures

No schema, permissions, credentials, analytics vendor or dependency changes. Move
the existing selectors to a browser-safe shared module with the server path kept
as a re-export, retaining return JSON compatibility and immutable results. Add the
module to the exact hosted-asset allowlist/import test. No hidden hosted service.

The return controller owns asynchronous results by session/account/binding and
pagination chain. Preserve those checks. Remove the arbitrary acknowledgement
horizon parameter; its single source becomes brief.history.evaluatedThrough.
Preserve committed-but-not-refreshed recovery and in-flight close/reopen semantics.
Current-work rendering may progress without replacing historical H/C. Same-work
reminders and attention are two reasons, not two distinct tasks.

List disclosure is local presentation state only and resets at identity loss. Do
not clear private pending reminder retries or composer drafts on catch-up changes.
Keep focused work/control or a predictable visible fallback when lists disappear.
The existing reminder refresh and focus hooks retain their IDs. Local time-based
rechecks make no network writes and stop while hidden/signed out; actual work
authority still belongs to service validation.

## Evidence and research

Reviewed current source, watcher/first-use/reminder checkpoints, synthetic browser
screenshots and three independent source audits. No production analytics dataset
or verified retention baseline is provided. Existing event sequences can prove
commands/cursor changes, not that a person read, understood or benefited from them.

- [NN/g progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
  supports keeping frequent needs visible and clearly labelling secondary controls.
  Applying that here means relocating the existing entry, not burying it behind
  another menu. This is design guidance, not measured Project Room benefit.
- [Apple disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls)
  and [onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)
  inform contextual, nonessential-detail disclosure and learning through use.
  Primary indexed documentation and the research lane were reviewed; direct text
  opening of the disclosure page returned a JavaScript-only shell.
- [Basecamp's notifications sidebar](https://5.basecamp-help.com/article/1150-sidebar)
  separates new activity and intentionally revisited items with contextual access.
  Borrow the distinction, not a new multi-room sidebar.
- [W3C disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)
  informs keyboard-operable expansion and exposed state. Prefer native details.
- The read-only research lane reviewed [The Wikipedia Adventure, CSCW 2017](https://par.nsf.gov/servlets/purl/10039617):
  favorable tutorial ratings did not establish improved contributions in its
  experiment. Root's direct PDF open failed, so no numerical result from that
  paper is used here. Keep tutorial completion, clicks and contribution outcomes
  separate. Its Wikipedia context does not predict this product's results.

All sources accessed/reviewed September 7, 2026; no source code copied.

## Experiment contract (design, not an analysis result)

Decision: after voluntary human testing, retain or revise the prominent but
collapsed return entry. John owns the product decision; review after complete
observations rather than every click. Segment ongoing collaboration from one-off
rooms; exclude fixtures, staff smoke tests and automatic watcher reads.

Candidates considered: panel opens, clicks, dwell time, reminder views, task-open
speed, correctly understood next step, relevant contribution, repeat collaboration.
Reject opens/dwell/counts as success metrics: they can reward confusion. Prefer one
local experiment outcome aligned with the goal's repeat useful collaboration:

- **Primary: return-to-useful-contribution.** Among consenting eligible human
  return sessions with an existing unresolved role or chosen due reminder, fraction
  where the person contributes a relevant message/evidence/review during the session.
  Session begins at observed room return after a prior visit, ends on leaving or
  after 30 minutes; use one first eligible session per member/room/day. Relevance
  requires participant/inviter confirmation plus the existing work-linked event;
  a page open, cursor update or automatic event does not count. Report numerator,
  denominator, exclusions and missing observations. Useful but imperfect proxy:
  resolving a question without writing can also be success and must be noted.
- **Diagnostic:** time to correctly locating/explaining a current next step, observed
  with permission; report failures/censoring separately rather than only fast successes.
- **Guardrails:** unintended acknowledgement/authority/privacy changes, and first-use
  conversation friction (composer reachable, keyboard/touch path still works).

No numerical uplift target without a baseline. Start with counterbalanced
moderated scenarios and qualitative observations, then consider a randomized test
only with adequate traffic/consent and a predeclared duration/effect size. Required
human observation is currently unavailable: this path remains unmeasured, not a
reason to invent data or block local mechanics. No instrumentation is deployed.

Local acceptance decision now: ship locally only if all invariants hold, the panel
is discoverable before long Work on desktop/mobile, the ordinary composer remains
usable, all hidden items remain reachable, and screenshots show no reflow/focus
regression. These are engineering gates, not proof of retention or growth.

## Verification and next gates

Test fresh owner/guest first use, many assignments, overlapping due reminder,
current resolution/reopen with frozen history, clock-only expiry, all/less focus,
live updates preserving drafts/selection, H+1 arriving before acknowledgement,
failed paging/refresh, in-flight ack reopen, and stale account/session responses.
Extend existing tests instead of dropping the older differently-scoped ack case.
Use disposable local rooms; retain desktop/mobile/large-text screenshots.

Run core, full browser, Cloudflare/local asset packaging checks; inspect output.
Commit locally and update handoff/bus. No publication or live migration. Earlier
reminders still require v8-compatible fallback and recovery before release.
