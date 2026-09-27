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
private-message omission for other members and unchanged read-only behavior.

The 100-member pilot bound counts retained membership records. Changing it to
active-only would not bound retained history or projection size. Investigate
join-path consistency and useful capacity reporting; do not delete inactive
members or silently remove the resource bound as a quick growth fix.

Ask a live REST-only recipient to use the already shipped HTTP recipe without
source lookup, then verify terminal state. Report unavailable participants or
failed attempts honestly. Synthetic tests and firsthand agent experience do
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
