# Contribution follow-through

Local follow-up to native drafts at `5ed8e6b`. This is not a deployed release.

## Design choice

Two options considered: another personal contribution queue, or feedback on the
existing contribution. The latter keeps the conversation, original text and next
decision together without introducing another destination or attention counter.

Draft messages now reflect the exact current result: awaiting review, awaiting
decision, changes requested, a review finding, approval or completion. A short
**Feedback** disclosure contains the recorded note. The status links to the work
card; its existing actions and details remain authoritative.

Adopting a draft no longer hides alternatives from the work card. **Drafts**
remains a closed-by-default list with author, current disposition and text preview.
A previous adopted message says **Earlier result** after replacement; another
draft from the same person does not inherit approval or rejection.

## One source of truth

`draftFeedback` derives labels from the current permitted work projection and
immutable message identity, not body similarity, author identity alone or offer
selection. Review/decision feedback must match the current completion and evidence
version. Blocked-state findings must also identify the current blocker.

Reopening retires a current approval label. Resolving a blocker does not keep
requesting the previous change. Replacing the result removes its old note from
the current-feedback surface; existing historical records remain unchanged.

No new durable state, schema, task, agent tool, automatic assignment, alert,
helper fulfillment or release is added. Agents already read the underlying
result/review facts through the existing API/MCP. This UI adds no new authority.
Authorship remains unverified unless established by the existing mechanisms.

## Interaction continuity

Incoming feedback updates the status text and note without replacing the original
message body, status link or an existing feedback disclosure. Expanded feedback
and focused controls survive unrelated room updates. When a feedback disclosure
disappears, focus returns to that draft's work-status link.

The contribution journey retains unrelated chat drafts. Feedback is rendered as
literal text. Desktop/mobile routes use the existing Share draft, result adoption,
review and human-decision controls; an owner still resolves the blocker before
adopting another result.

## Evidence and limitations

Working-tree checks before the last alternative-label polish passed **687 core**
and **6 native-draft browser** checks. Committed reruns and broader browser
regressions are recorded in the retained evidence manifest, not inferred here.

New pure tests cover exact-message attribution, mismatched evidence, current
blocker selection, replacement and no fabricated approval. New desktop/mobile
journeys cover two drafts, adoption, independent scripted review, requested
changes, literal note rendering, focus/draft retention, owner resolution, a third
draft, re-review and approval. The selected helper remains reserved.

Screenshots show feedback in the conversation and the reviewed replacement.
These are simulated people and a separately credentialed scripted MCP reviewer,
not independent model reasoning, real human research or evidence of retention.

## Next

Move to the blueprint's synthetic Inbox/Rooms comparison and complete private
source → selected sharing → room contribution → reviewed result → reply.
Keep ordinary chat and direct replies useful without work, agents or money.
Do not expand this feedback slice into a second notification system.
