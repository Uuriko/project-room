# Calm cooperation: product patterns to borrow

September 7, 2026. Follow-up research while implementing private reminders.

## Recommendation

Make Project Room a place to return to useful work—not another place demanding
attention. Keep conversation, accountable work and personal attention separate.
Apply progressive disclosure to agent tools as well as the human interface:
small relevant responses, explicit next actions, and more detail on request.

The current implementation is a narrow first step: personal reminders on existing
work, surfaced in Catch me up. A reminder neither instructs an agent nor changes
a team deadline. The next step should be a user-enabled, notify-only watcher,
not a general autonomous workflow builder.

These are design inferences from primary product documentation, not claims that
competitors proved a particular business outcome or solved our reliability needs.

## Products reviewed

| Product | Documented pattern | Useful adaptation for Room |
| --- | --- | --- |
| [Linear Inbox](https://linear.app/docs/inbox) | Issue reminders can be rescheduled or cancelled; unlike snoozed notifications, reminders do not hide the underlying issue. | Preserve the original work object and its visibility. Treat a reminder as personal attention, not work state. |
| [Basecamp 5](https://basecamp.com/5) | Bubble Up returns existing content later. Its optional notification sidebar stays beside work, and project tools can be added as needed. | Resurface the original work, without a duplicate task or new mandatory dashboard. Reveal capabilities in context. |
| [Basecamp CLI](https://github.com/basecamp/basecamp-cli) | Official CLI for agents and people, structured JSON with navigation breadcrumbs, stable errors, skills and MCP options. | Human UI and agent interface should share the same contract. Return enough structure to take the next permitted step; avoid giant context dumps. |
| [Things scheduling](https://culturedcode.com/things/support/articles/2803579/) | Separates when to work on something from the deadline for finishing it. Upcoming keeps future work distinct. | A private reminder must not become a room deadline. Keep future reminders behind Scheduled, with due reminders surfaced first. |
| [Superhuman follow-ups](https://help.superhuman.com/hc/en-us/articles/46005792082445-Follow-Up-Faster) | Conditional no-reply reminders and controls for automatic reminders; draft assistance is distinct from the user sending the follow-up. | Later offer explicit conditions such as “if there’s no reply.” Reminder, draft preparation and sending require separate permission. |
| [Plane agents](https://developers.plane.so/dev-tools/agents/overview) | Beta agent integration has identifiable bot users, mention triggers, tracked runs, waiting-for-input and stop/failure states. | A run is not a work item. Track its own lifecycle so a finished response is not mistaken for reviewed, approved work. Show questions and actionable outcomes instead of a constant activity feed. |
| [Vikunja bots](https://vikunja.io/docs/bot-users/) and [veans](https://vikunja.io/docs/veans/) | Human-owned, visibly marked token-only bots; an experimental JSON CLI with a claim/work/review workflow and session-orientation prompt. | Never ask an agent to impersonate its human. Provide a small reorientation response at session start, and preserve attribution when work returns. |

Vikunja also documents separate database and mail notification representations.
This supports separating durable attention records from delivery adapters, rather
than making email a prerequisite for useful reminders. That is architectural
inspiration, not copied source. [Notification architecture](https://vikunja.io/docs/notifications/).

## What this changes now

1. **No extra task object.** One private reminder is attached to an existing work
   item. Shared conversation, work status, review and read markers remain unchanged.
2. **One small entry point.** Work Details → Remind me. Common time choices first;
   a custom date appears only when selected. Show the resolved date and UTC offset.
3. **A quiet return.** Due reminders appear in Catch me up. Future reminders remain
   collapsed. Empty reminder chrome is hidden. No toast loop or notification prompt.
4. **Truthful delivery.** Explicit in-app-only wording. We do not promise an alert
   when the browser is closed or the person no longer has access.
5. **Recoverable uncertainty.** A lost response keeps the original request for
   retry, even if the task subsequently resolves. No silent “Saved” or fresh ID.
6. **Separate identities.** API clients can manage their own reminders using their
   own credential. Private human reminders are not copied into packets, orientation,
   shared snapshots, room events or an agent's context.

Reviewer findings sharpened the flow: freeze the displayed time before saving;
keep unknown-outcome reconciliation reachable after work resolves; restore keyboard
focus when the original reminder row disappears; refresh on opening Catch me up,
including when another device created the first reminder.

## What to build next, in order

### A. Notify-only assignment watcher

An explicitly started local process that reports relevant changes through its
configured output. No model, external execution, task completion or sending on
someone's behalf. Its durable checkpoint is independent of the human read marker.

Implementation shape:

- Configuration: fixed origin/room, dedicated actor, relevant member/work filters,
  poll interval, bounded retry/backoff, output destination and an explicit stop.
- State: configuration version, processing cursor, current work revision and
  durable notification outbox. Persist the notification before advancing the cursor.
- Reconcile: read current work before reporting an old event. Do not notify an
  obsolete assignment after it has been reassigned, resolved or superseded.
- Delivery: stable notification ID. A replay may re-deliver to a consumer that
  cannot deduplicate; state that guarantee rather than claiming exactly-once delivery.
- Failure: one useful status when action is needed. Silence or missing heartbeats
  cannot prove that an agent is inactive, failed or free to replace.
- Tests: restart after output commit but before cursor commit, expired/revoked
  credentials, stale work, overlapping watchers, inaccessible output, rate limits
  and explicit cancellation. Leave the room's human read cursor untouched.

### B. Better agent orientation

Extend the existing read-only orientation, without silently increasing authority:
include bounded relevant work, exact revisions, current next actions, and why an
action is unavailable. Add pagination before expanding context size. Provide
predictable errors and a compact contract document that an external agent can
re-read after losing context. MCP can wrap this same API later; it should not
introduce a second authorization model.

### C. Reviewable assistance, only after the watcher is trustworthy

Offer “prepare a follow-up” as a draft, scoped to one chosen thread. Sending is a
separate human action or separately granted automation permission. Keep run
completion distinct from evidence submission, independent review and owner approval.
Do not reproduce competitors' internal-reasoning feeds; expose concise progress,
tool outcomes and questions instead.

### D. Release and recovery first

Private reminders introduce schema v8. The live application is still v7. Before
hosted migration, prepare a v8-compatible fallback or roll-forward build, test
recovery, verify exact-source CI and get current release authorization. Older
Worker rollback instructions are not compatible with a migrated database.

## Questions that remain worth researching

- Do people think of “tomorrow” as a reminder or a deadline? Simulated tests cannot
  establish that; watch actual users explain the distinction in their own words.
- Is one reminder per work item enough for the pilot? Add multiple reminders only
  if real repeated use shows the simple model is insufficient.
- Which conditional event is unambiguous: no thread reply, no assignment
  acceptance, or no new evidence? Define each separately; don't infer “no progress.”
- Which agent status is directly measured, and which is self-reported? Present
  freshness and source without turning every heartbeat into room noise.
- What is the narrowest permission for a user's agent to help with personal
  attention? It should not require their login or expose unrelated private work.
- How do we suppress duplicate watcher output without hiding a materially changed
  result? Identity should include relevant work/evidence revision, not just title.
- When should a stopped run relinquish a claim? Stop requests, confirmed stop,
  process death and lease expiry are different observations.
- How can free users keep complete manual/BYO-agent workflows while hosted AI is
  limited? Charge for optional execution, not access to their own context or results.

## Research method and limits

Primary documentation was read on September 7, 2026. This is a focused product
comparison, not an exhaustive market survey, code audit or hands-on competitor
usability test. The browser evidence in this checkpoint is of our own synthetic
Room, not those products. Plane labels Agents Beta; Vikunja labels veans
experimental. Their workflow descriptions do not prove server-side enforcement
of review rules. No external code was imported and no service was purchased.

Main web discovery queries were:

- `site.linear.app/docs inbox reminders snooze`
- `site.todoist.com/help reminders automatic custom reminders`
- `site.basecamp.com features notification don't need to be constantly checking`

These were followed by direct primary-document reads above and an independent
reviewer’s adjacent-product search. Todoist results helped discovery but were not
needed to support the selected design decisions. The supplementary Stripe
Directory workflow was considered; its CLI was unavailable. **No directory query
or filter ran**, and no directory-backed result is claimed.
