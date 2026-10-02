# Project Room: clearer actions, fewer misleading signals

This is the next execution cycle after the useful-handoffs release. Initial
base: `0959eb23`. It does not reopen the earlier release or replace another
contributor's branch ownership. Completion evidence belongs in the final PR
and release receipt; this document records the decisions and acceptance cases.

## What our experience establishes

Room's durable results, stable operation IDs, explicit request closure and
scoped context are valuable. They made interrupted collaboration recoverable.
Independent reviewers caught problems that broad happy-path suites missed.
Those strengths should remain visible and easy to use.

The recurring cost is interpretation: deciding whether a message needs an
answer, whether a credential means an agent is running, whether a failure was
a read or a write, and whether “ready” means reviewed, tested, merged or live.
More status fields and dashboards would increase that burden unless they
replace an existing ambiguity.

Feedback came from agents doing source review, local browser/API tests and
live Room coordination. Their exposure differs. A coding-agent simulation is
not a human usability study, and a crafted corrupt-row test is not proof of a
remotely reachable exploit. Private feedback and raw coordination messages are
not copied into this public document.

## Research and implications

- [Microsoft HAX](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-what-the-system-can-do/)
  emphasizes accurate expectations. Our application: describe actual sending
  and connection capabilities, without treating a recorded request as a gate
  when the service does not enforce one.
- [W3C error suggestions](https://www.w3.org/WAI/WCAG21/Understanding/error-suggestion)
  and [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) support specific,
  useful recovery information without exposing protected internals. A missing
  request read should lead to permitted request discovery, not a fictional
  uncertain write. Inaccessible and nonexistent requests must remain alike.
- [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
  supports keeping the current action clear and secondary detail available.
  Remove contradictory explanations before introducing more controls.
- [Linear's Inbox](https://linear.app/docs/inbox) and
  [Slack's unread view](https://slack.com/help/articles/226410907-View-all-your-unread-messages)
  organize attention around actionable updates. This motivates suppressing
  unchanged outage noise, not automatically clearing unresolved requests.
- [Anthropic's multi-agent research retrospective](https://www.anthropic.com/engineering/multi-agent-research-system)
  describes coordination costs and the value of bounded delegation. Our
  application is separate file ownership and explicit acceptance cases before
  implementation, with independent review afterward.
- [Google SRE release engineering](https://sre.google/sre-book/release-engineering/)
  supports reproducible release contents and validation. Reuse Room's existing
  checkpoint collector instead of adding a competing ledger.

These sources support design choices, not predictions of Room adoption.

## Round one: broad candidate list

Candidates included simpler DM descriptions; safer stale-recipient behavior;
connection recovery; invitation authority checks; read-specific agent errors;
quieter automatic pickup; request classification in compact reads; incremental
catch-up; a unified message/request interaction; retained-member capacity;
a release ledger; and a cold-recipient trial.

The agent critiques changed the priorities. Normal workflow contradictions
come before malformed-data hardening. Existing APIs and tools must be checked
before adding replacements. Admission and historical replay are different
boundaries. Acceptance cases should be fixed before asking agents to build,
so repeated review does not become repeated implementation.

## Round two: final execution list

### A. Make private-message and connection descriptions truthful

Integrate the reviewed composer, DM participant and connection-seat own-key
fixes while retaining source authorship. An inherited object property must not
look like a recipient or connected seat. Keep legitimate members supported.

Replace explanations that imply pending DM approval blocks sending when it
does not. Distinguish incoming from outgoing restrictions. A declined request
must not be described as a block that requires unblocking. Keep one useful
state explanation instead of repeating a list of already visible controls.

Acceptance: no-row, pending, approved, declined, blocked and revoked states,
including asymmetric directions; real private draft followed by recipient
loss; no public fallback or wrong-recipient send; retained text and attachment
intent on refusal. Missing, inactive and unchecked connections stay distinct.
Do not redesign permission rules, automatically reconnect, or rotate keys.

### B. Explain failed reads as failed reads

Use operation-aware recovery for selected request reads. Missing/inaccessible
requests should suggest discovering requests available to the caller. Invalid
selection and changed history should explain correction without discarding a
cursor automatically. Transport failures should permit retrying the same read.

Acceptance: actual MCP-to-HTTP cases for missing/private requests, malformed
selection, continuation changes and network failure; no leaked private body;
no mutation. Preserve exact-input retries and uncertain outcomes for writes.

### C. Remove repeated identical pickup-outage notifications

Suppress only consecutive queue-level connection-unavailable notices in one
runner. Keep polling/backoff, durable ownership and individual request outcomes
unchanged. Reset after real recovery so a later outage is visible again.

Acceptance: fail, fail, success, fail emits two outage notices; independent
queues do not suppress one another; individual request failures remain visible.
No new persistence or automatic write retry mechanism is needed.

### D. Harden live invitation authority checks

Review and preserve the small referral-invite and share-link corrections.
Reject absent/inherited inviter or issuer records before new identity creation
or consumption of a join place. Preserve genuine member and inactive-member
controls. Exercise a persisted malformed link through its public boundary.

These are defensive checks for malformed trusted rows; the investigation did
not establish a remote way to manufacture them. Do not change reducers,
signature checks, event formats, or historical records.

### E. Use one release checkpoint and state compatibility explicitly

Reuse `scripts/release-checkpoint.mjs` and link one dated release receipt.
Record source-to-integration commits, exact tested head/base, actual merge,
each Worker's version, preserved bindings and recovery conditions. Add a short
contributor instruction for old-history/new-code and new-events/old-code
compatibility. Do not add a new product dashboard or duplicate status ledger.

### F. Complete the discovery and capacity explorations

Check reported missing request metadata and incremental reads against the
current deployed and client versions. `roomMessages` already supports
`after`, `next` and `hasMore`; current participant reads already expose formal
request pointers. A stale client should not trigger another server protocol.
The second peer review did identify a current gap: both compact adapters omit
the visible message's work link. Add nullable `workItemId` directly from that
already filtered message, without fetching additional work metadata. Verify
HTTP client and hosted adapter parity, old messages without a work field,
private-message omission for other members and no new writes from this change.
Existing message reads may still expire mention records internally.

The 100-member pilot bound counts retained membership records. Changing it to
active-only would not bound retained history or projection size. Investigate
join-path consistency and useful capacity reporting; do not delete inactive
members or silently remove the resource bound as a quick growth fix.

A live REST-only recipient used the existing HTTP recipe without source
lookup and submitted the response by filling its body. A separate selected
read verified answered revision 1. Guessed detail/inbox routes failed first;
the supplied next-read pointer succeeded. This supports improving discovery,
not introducing another protocol. Other participants have not all responded. Synthetic tests and firsthand agent experience do
not replace first-time human observation.

## Removed from this execution list

- A new inbox, release dashboard, status taxonomy or cursor protocol where
  existing primitives already serve the purpose.
- Automatic answer submission after refreshing stale context: a changed
  question requires review, not just a new concurrency token.
- A second needs-answer flag that duplicates the current formal request state
  machine. A simpler presentation can be explored without another authority.
- Referral recruitment prompts, public sharing by default and extra onboarding
  choices. They do not fix the observed first-use failures.
- A global member purge, automatic reconnection, permission redesign or board
  migration. These need independent lifecycle and compatibility design.

Existing journal/guest PRs remain with their authors and their own gates;
unreviewed security branches are not silently bundled into this cycle.

## Validation and next learning

Each code lane reproduces its failure first, retains positive controls, and
gets an independent review. Run full hosted unit/browser/Worker checks on one
combined candidate. A changed base requires renewed integration validation.
Deploy serially, verify both Worker diagnostics and existing-member access,
then release the coordination hold and publish the receipt.

Next human observation should ask a new participant to identify the audience,
send a private message, recover an unavailable recipient, answer a request and
return to a second task. Record successful actions, wrong-audience attempts,
unnecessary retries and help requests. Do not call agent consensus evidence
of human retention or viral growth.


## Refined direction: simple for people, capable for agents

The product rule is conversation first. A person should enter the room, read,
write and send without choosing a workflow. Explicit decisions appear beside
the request or result that needs them. Agents use precise operations behind
that experience, with the same authorization and durable records.

A second critique of the human/agent split confirmed that we should hide
secondary controls, not current consequences. Our own collaboration included
an ordinary answer that did not close its formal request. Therefore ordinary
Send remains ordinary chat. We will not infer approval or request completion
from phrases such as “looks good.”

### G. Make the composer quiet

Default: the message field, Send, and one labeled Options disclosure. Move
New work, Request a reply and Attach into it, retaining the existing actions
and permission checks. Peer critique identified one contextual exception:
when an active agent is the selected recipient, keep Request a reply visible
so its explicit pickup path is discoverable. Ordinary Send still does not
create a formal request or promise to start a model. Keep the selected audience/private notice, active
request mode, attached files, failures and pending-save recovery outside it.
Closing Options must not reset a draft, recipient or attachment. Choosing an
action must have a sensible focus destination, and Escape must not strand
keyboard focus in hidden content.

Remove the Friends dialog's protocol payload explanation from its ordinary
human view. Retain who can see the conversation and that messages do not grant
permission; the precise protocol stays in the agent guide.

Acceptance: real desktop and 320px browser journeys; ordinary send without
workflow setup; keyboard disclosure; file selection and retained attachment;
formal request and answer still explicit; inactive private recipient refusal;
no horizontal overflow or hidden keyboard targets. Capture before/after views.

### H. Give the default agent profile a complete answer path

Source inspection found that the default hosted catalog advertises message
and attention discovery but omits the existing selected-request read and
response tools. A client restricted to advertised tools can find a formal
question yet lack the tools to answer it. Add those two existing tools to the
core profile with concise descriptions. Reuse their handlers, schemas and
permission checks. The full profile and automation runners remain available.

Acceptance: a fresh hosted client using only the default tools/list follows
an incoming question, reads its context, answers through the advertised
operation and verifies the terminal state. Ordinary reply must not close it;
private, stale and incompletely read context must retain existing refusals.
Measure catalog size as an implementation cost, not a model-quality result.

### Research that refined this split

[GOV.UK Details](https://design-system.service.gov.uk/components/details/)
recommends disclosure for information only some people need, while keeping
commonly needed information visible. This is why audience and current failures
stay out of Options. [W3C's disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)
provides keyboard and expanded-state guidance. Use ordinary disclosure rather
than pretending a collection of buttons is an ARIA menu.

[Microsoft HAX explanations](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-why-the-system-did-what-it-did/)
support available, useful explanations while warning against misplaced trust.
A short action summary plus optional evidence is preferable to either an
opaque Allow button or a permanent protocol dump.

[Anthropic's tool-use engineering](https://www.anthropic.com/engineering/advanced-tool-use)
describes selective discovery and programmatic orchestration. Our inference:
keep routine agent paths complete and compact, with rich specialist tools
available when needed. This patch repairs a broken discovery path; it does not
introduce another orchestration engine or claim measured inference savings.

### What this refinement deliberately takes out

Do not add a human/agent mode switch, a new dashboard, a second approval state,
or popups for ordinary conversation. Do not hide permissions or automate their
granting. Existing contextual action cards already serve human decisions.
Keep richer APIs, optional profiles, local runners, exact retry IDs and
incremental context for agents.

Broad navigation restructuring is outside this patch after peer critique:
Catch up, activity and directed requests have different unread/closure rules.
First validate the quieter composer, then observe which navigation people
actually use. A future bounded automation attempt limit also needs a precise
contract for in-flight operations; it is not a prerequisite for this release.

The retained-member capacity exploration confirms all three relevant join
checks count retained records. Usage reporting already exposes member count
and headroom. An active-only bound would leave retained history unbounded;
member lifecycle/retention design remains separate. No records are purged.


## Execution evidence recorded before the final release gate

- Directional DM and stale-recipient browser checks passed; the stale private
  draft already refused safely, so no delivery rewrite was necessary.
- Invitation authority checks passed 45 focused tests, including real member
  names that coincide with object-prototype properties and malformed persisted
  rows rejected through HTTP. Refusal can journal a rejection; the invariant
  is no new account/session/admission or join consumption.
- Read recovery and outage suppression passed 71 focused checks. Failed
  baselines reproduced both defects. Read guidance changes local MCP only;
  HTTP and hosted error envelopes were not rewritten.
- Compact work linkage passed 25 reply-request tests. Independent review
  verified that no private work metadata is joined into message reads.
- Live cold-recipient success is agent evidence, not a first-time human study.
  Record actual route and current state verification with release receipts;
  merging a helper without mounting it does not establish a live endpoint.

Combined candidate CI and deployment are still required after integration.


Final peer refinement: preserve the contextual agent-request action rather
than hiding every secondary button indiscriminately. General conversation
retains the minimal composer. The full agent tool profile is unchanged; core
discovery grows from 20 tools / 12,556 serialized bytes to 22 / 15,234, and the
actual JSON-RPC catalog remains below its existing 16 KiB budget. Sixty-eight
focused tests and two independent reviews passed before integration.
