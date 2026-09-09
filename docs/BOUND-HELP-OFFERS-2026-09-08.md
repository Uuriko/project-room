# Invitation-bound offers: research, decisions and contract

Update: the [storage checkpoint](HELP-OFFER-STORAGE-CHECKPOINT-2026-09-08.md)
now enables authenticated commands under writer14 with retained-history auditing.
The dormant status and qualification below describe the earlier contract milestone.
Human controls and dedicated agent offer context/tools remain next.

Previous goal turn was progress: humans can publish/edit/withdraw help and agents
can discover it. This slice implements a dormant shared offer contract and tests.
It is not yet a writable service/API/MCP/UI feature. The existing schema13 runtime
remains unchanged until writer, migration and retained-history support are ready.

## Research that changed the design

The [A2A task lifecycle](https://a2a-protocol.org/latest/topics/life-of-a-task/)
distinguishes stateless messages from tracked tasks and does not restart terminal
tasks. We borrow explicit stages and immutable terminal outcomes, not its execution
semantics or a claim of A2A compatibility. Ordinary answers stay conversation.

Reid G. Smith's [1980 Contract Net paper](https://www.reidgsmith.com/The_Contract_Net_Protocol_Dec-1980.pdf)
describes task negotiation and mutual selection. The relevant introduction and
negotiation sections support separating an announcement, an offer and a choice.
Our adaptation is a Room-owned coordination record, not an auction, payment
contract or automatic award. This was a targeted reading, not a full-paper audit.

[Temporal's idempotency guidance](https://docs.temporal.io/activity-definition)
explains why a lost completion report can lead to retries and why stable keys must
be enforced by the called service. Project Room already has that command ledger;
offer writes must reuse it. Observing one result is not proof that outside work
executed only once, and a record release is not proof that a worker stopped.

[GitHub's assignee documentation](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users)
shows explicit responsibility and supports multiple assignees. Project Room
retains one accountable member and treats selected helpers separately. One selected
helper per work is our initial coordination default, not a research-derived optimum.
Parallel ordinary drafts remain available; prose cannot prove nonoverlapping scope.

## Contract decisions

Request → offer → selected contribution → released coordination.
Offered may instead become declined or withdrawn. These states never imply task
assignment, external permission, execution, completion, verification or payment.
Declined, withdrawn and released records cannot reopen.

- Offer input pins work revision plus exact help revision/event identity and a
  short plan. Stored offers retain the immutable invitation scope, expiry and
  accountable consent; the helper's membership revision records willingness.
- Plans are immutable for a request version. Clarify through discussion rather
  than minting replacement offers. A new explicit invitation revision permits
  another offer; a declined/withdrawn offer cannot be bypassed with a new ID.
- Five currently applicable pending offers per work and per member across the
  Room bound attention. Five is an initial conservative product policy, not
  empirically validated. Historical offer capacity is500; cleanup remains possible.
  This is not a general anti-spam, rate-limit or Sybil-resistance claim.
- Only the current accountable participant may select, under current publishing
  permission and exact invitation/work/offer revisions. A human Room owner may
  decline or release for moderation, not choose on another accountable person's
  behalf. The designated independent reviewer cannot offer.
- Only one record may remain selected per work, across invitation versions.
  Another offer cannot be selected or newly opened while that record remains.
  Existing pending offers may still be explicitly declined or withdrawn.
- Expiry, withdrawal, consent changes, revoked/restored helper access and work
  completion/rework invalidate an old pending offer. Ordinary work progress does
  not. Time-based applicability is evaluated at the supplied service time; it
  is not a durable monotonic-clock expiration promise.
- A selected record does not silently disappear when its invitation changes.
  It becomes selection_needs_review and still occupies the coordination slot.
  Explicit release requires a reason and acknowledgement that external activity
  is unverified. Helper, accountable participant or human owner may release.
- Releasing the record never sends a stop command, confirms stopped work or
  permits overlapping outside operations. External scopes/claims and actual
  operator authority remain separate; this cannot guarantee no duplicate work.
- Shared helpers validate exact shape and scope references and return fresh
  copies. Reads do not mutate state. Pure transitions do not implement command
  idempotency, transactions, authentication or retained-history validation.

## Implemented, not enabled

`src/help-offers.js` provides strict input/projection validators, pure transitions,
offer availability and selected-offer context. It is deliberately absent from
event registration, service allowlists and runtime packages.

Tests cover scope/identity/revisions, helper roles, duplicate suppression through
terminal states, both selection orderings, pending/history bounds, ordinary
answers not selecting, expiry/withdrawal, membership restoration, rework,
backwards updates, immutable returned copies and malformed projections. The
capacity projection is explicitly synthetic, not a valid-history recovery proof.
Two orderings prove serial revalidation, not concurrent database correctness.
The current schema13 service is checked to reject both future event types without
changing the all-table audit hash.

## Implementation sequence to complete the real feature

The next implementation is storage and recovery, not more controls. Keep this
contract dormant until that entire boundary is verified together.

1. Register `work.help_offer_opened` and `work.help_offer_updated` with schema/
   writer14. Keep both outside WORK_REVISION_TYPES. Preserve all older guards,
   and atomically fence pre-open13 Node and Workers writers.
2. Detect pre14 collisions in current/checkpoint helpOffers fields and reserved
   event types. Never reinterpret ignored old message text or unknown fields as
   offers. Register no partial writes before this guard and history support.
3. Extend retained-history reconstruction with help-offer events, source
   invitations, helper/accountable member facts and selected-slot invariants.
   Compare current/checkpoint offer projections against replay. Do not infer
   safety from the last event tail or current projection alone.
4. Use the existing authenticated command transaction and exact receipt ledger.
   Validate opening/selection within the write transaction; constructors evaluated
   before acquiring it are insufficient. Test two actual database connections
   racing selection and the final pending slot, plus lost acknowledgements.
5. Permit declined/withdrawn/released cleanup at capacity, while refusing new
   offers and selections as appropriate. No expiry read should write history.
6. Add versioned authenticated offer reads and thin agent tools. Old services
   report unavailable. Validate returned scope and identities; never discover
   offers from message prose or a partial paginated event tail.
7. Add contextual human Offer / Choose / Decline / Release controls and offer
   summaries inside the existing help disclosure. Show who was selected and the
   exact plan; do not add a separate task dashboard or automatic dispatch.
8. Link discussion and drafts through existing work identity. Ordinary reply
   status stays independent: answered is not selected. Display explicit offers
   without manufacturing a second work assignment or silently deleting messages.
9. Test human-to-multiple-scripted-agent journeys, stale selection, withdrawal
   during negotiation, declined retries, explicit release, independent review,
   mobile/keyboard/large text and unknown-save recovery.
10. Qualify distinct14-compatible fallback/recovery on populated state and only
    then consider authorized publication. Existing schema13 packages are not a
    substitute for that gate; preserve them unchanged. Hosted/current-authority
    recovery and native-model reasoning remain separate evidence requirements.

No deployment, live migration, push, provider operation, paid model, external
execution or change to the existing preview is authorized by this plan.

## Qualification checkpoint

Seventeen focused contract checks and644 full core/API/package checks pass on
the final source, including future-helper-revision and missing-helper corruption
assertions. An initial sandboxed full run could not bind localhost (EPERM); the
successful full rerun used disposable local services with networking permitted.
The retained final log is
`../project-room-runtime-packages-20260908/evidence-bound-offer-contract/core-final.log`
relative to the repository root's parent arrangement (the evidence directory is
a sibling of this repository). No existing preview was used or restarted.

All67 runtime-file SHA256 values still match the frozen `human-help-61f1294`
manifest. New contract source is neither imported nor runtime-allowlisted.
No UI changed, so no new browser screenshots or browser qualification is claimed.
Two serial selection orders are tested, not simultaneous database transactions.
The goal is active/incomplete; storage/recovery integration is the next slice.
