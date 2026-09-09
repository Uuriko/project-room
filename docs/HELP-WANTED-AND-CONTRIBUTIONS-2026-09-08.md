# Explicit help and multiple contributions

## Evidence and ordering

Previous goal turn was progress: current contributed-draft return shipped locally
at51045a1, with587 core/182 browser checks and retained recovery evidence. Current
code still exposes one View latest draft link and one current-draft shortcut. A
second helper can post a different draft on the same revision, but latest is only
canonical ordering—not quality, agreement or human selection. Work discussion
already exposes all linked proposals through a bounded read; humans should have
an equally clear way to inspect alternatives before discovery invites more help.

Primary research inspected September8:

- [Paperclip issue API](https://docs.paperclip.ing/reference/api/issues/): readable
  issue discussion, responsible-user authority and run/checkout ownership are
  distinct. Borrow the separation, not default-open field mutations or wakeups.
- [GitLab resource groups](https://docs.gitlab.com/ci/resource_groups/): serializes
  concurrency-sensitive jobs. Room has coordination claims, not an execution
  scheduler; invitation must not be presented as external exclusion enforcement.
- [GitHub issue creation](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue):
  help-wanted labels and assignees are separate fields. A help signal should not
  erase accountability. No source code is reused.

A CSCW contributor-signals paper was located at
https://cmustrudel.github.io/papers/cscw19signals.pdf but full retrieval exceeded the
reader limit; do not claim its findings were reviewed or use it as acceptance evidence.

## Next complete slice: inspect alternatives

1. Preserve the single-draft path unchanged. With multiple linked proposals on a
   work item, reveal an opt-in “Drafts (n)” disclosure in the existing card. List
   newest first with posting identity, basis revision and a short text excerpt.
   Mark an older basis honestly; no ranking, auto-merge, winner or endorsement.
2. Reuse the current contribution shortcut. When its current eligible draft has
   alternatives, label “Drafts to inspect” / “View drafts” and reveal the existing
   work card with the disclosure opened. No result is preselected or adopted.
   Keep one attention row per work item, not one per contributor.
3. Each link opens its exact message through existing navigation. The accountable
   person may adopt a nonlatest draft; exact selected bytes, reporter, posting
   identity and reported producer remain separate. Independent reviewer remains
   distinct, with human approval still required where configured.
4. Test two separately scoped scripted producers submitting on one work revision,
   discovery via existing discussion pagination, human inspection of both, explicit
   adoption of the earlier proposal, and exact independent review. Desktop/touch,
   keyboard, enlarged text, no duplicate work, no marker movement and no console
   errors. Existing single-draft and stale-basis behavior must continue passing.
5. Shorten misleading “Pasted draft” to “Draft” since API-posted drafts are not
   necessarily pasted. Preserve revision and authorship qualification.

No new endpoint, schema, writer, tool, automatic invitation or agent dispatch is
needed for this slice. This is a prerequisite improvement, not implementation of
the future room-wide help-wanted capability below.

## Help-wanted contract to implement next

### Intent and ownership

- A room-visible, optional signal on one existing work record; off by default.
  No public listing, new task, assignment transfer, access grant or automatic run.
- The current accountable participant may create/revise/withdraw it under their
  operator authority. The human Room owner may withdraw it. Whether the owner may
  advertise help on another accountable participant’s behalf requires explicit
  consent; initial design should not silently assume that consent.
- Scope names a bounded requested contribution and expected output. Start with
  free in-room discussion/drafts, not promises of payment or external execution.
  Bounties/funding remain separate future contracts.

### Canonical facts and concurrency

- One active signal per work record, with immutable signal/event identity,
  independent signal revision, issuing actor, work basis revision, scope text,
  created/updated time and explicit expiry. No prose parsing or magic labels.
- Proposed states: open, withdrawn; derived unavailable states: expired,
  work-changed, work-closed, accountable-unavailable. Work changes suspend the old
  signal until explicitly reaffirmed; reopening work must not resurrect consent.
- Create/update/withdraw require exact work and signal revisions and stable retry
  identity. Unknown results retain exact inputs. A stale retry cannot silently
  update a replacement signal. Withdrawal stops new discovery but does not erase
  previous offers, conversations, drafts, obligations or attribution.
- Agent suggestions exclude closed/expired/inactive/independent-review-conflict
  cases. Discovery remains a read and may be unavailable on an older service.
  Absence must not be synthesized into “help wanted”.

### Offer and execution remain separate

- A candidate reads current work, scope, relevant discussion and prior requests,
  then sends one bounded explicit offer via the existing reply-request mechanism.
  They inspect the actual answer; answered is not necessarily accepted.
- No automatic acceptance, assignment, tool grant, repository claim or payout.
  Multiple offers are allowed; the accountable participant coordinates scope
  before overlapping execution. Existing room claims do not lock outside systems.
- Preserve multiple drafts and explicit attribution. A later submission cannot
  overwrite a previous contribution or become selected merely by arriving last.
- Decline and withdrawal remain respected. Rate/capacity limits need service-side
  enforcement; do not rely only on a model reading “do not spam”.

### UI, agents and recovery

- Human setup lives inside work details, with scope shown only while active.
  Agents get the same structured signal through selected context and opt-in work
  discovery, plus exact current permitted actions. No new global dashboard.
- Use a service-stamped semantic event, not an old message field interpreted
  differently by new clients. Existing schema12 writers must not be allowed to
  accept or replay unsupported semantics silently. Specify migration/writer fence,
  populated-data rollback, exact retries, old-client behavior and a compatible
  distinct fallback before enabling writes. A schema12 fallback is not assumed
  compatible with a future writer13 feature.
- Tests must include concurrent update/withdraw, late create retry, clock expiry,
  work revision change/reopen, membership revocation, independent reviewer conflict,
  partially paginated discovery, human unknown-save recovery and current authority
  after restoring a populated package. No live migration is authorized.

## Now / next / later

- Now: complete human/agent inspection and deliberate choice among contributions.
- Next: implement the explicit help signal across shared domain, service, agent
  discovery and contextual human setup, with migration/recovery as one release slice.
- Later: contribution non-adoption/scope reservations, bounty reward contracts,
  native-host acceptance and authorized hosted recovery. No retention lift claimed.

## Implemented draft-choice slice

Runtime `cf377f3ad4aba4dd1a31ccbd7691b3a7393c8f16` implements alternative inspection,
not the future help-wanted state machine. Single-draft navigation is unchanged.
Multiple proposals replace the single link with one closed-by-default Drafts (n)
disclosure; current contribution/catch-up routes open it without opening unrelated
work details. Links include posting identity, basis revision, an older-work label
when applicable, and a Unicode-safe 100-character excerpt. The whole excerpt is
clickable; keyboard focus keys identify exact messages. The list is newest first,
not a quality ordering. A current eligible latest proposal is still required to
surface a contribution shortcut; historical alternatives remain on the card.

Human return still counts one work record. Opening either shortcut merely focuses
choices; choosing a draft opens its exact conversation record. Adoption retains
the selected message and its producer/reporter distinctions, not whichever draft
arrived last. Conversation copy now says Draft, retaining revision/authorship
qualification. Cards index proposals once per render rather than rescanning all
messages for each task. This is a code-path improvement, not a measured latency claim.

Two distinct scripted producers and one scripted reviewer are exercised through
separate scoped MCP connections. The alternate receives an explicit synthetic
owner message requesting an alternative, reads selected work/discussion and posts
its own proposal. Both use the same work revision but post in a known sequence so
the human can deliberately select the earlier one. This is not a simultaneous
race test or native-model reasoning. Existing collision/lease tests remain separate.
Human behavior is simulated in desktop/touch browsers; no real-user preference
or retention effect is inferred.

### Findings and corrections

- Both new multi-contributor expectations failed against51045a1: the shortcut still
  offered one draft. Two before screenshots document the starting UI.
- The existing manual-return test expected View latest draft after adding a second
  proposal. It now verifies the one opt-in choice disclosure, selects the newest
  exact message and still checks both unrelated unsent drafts, cursor and work state.
  Its recovery assertions were preserved, not removed to get a green result.
- Initial navigation opened unrelated Details and left choices near the bottom
  of the mobile viewport. A shared draft-navigation function now opens only the
  relevant disclosure, focuses its summary and deliberately brings it into view.
  Catch-up and the main shortcut use the same route.
- The first enlarged-text screenshot did not show the target after resizing;
  the test now scrolls to the already focused summary before capture. Both 200%
  layouts have no horizontal overflow. Ordinary-sized navigation is also captured.
- Scoped touch-target sizing and wrapping apply only to the new disclosure and
  links. Before/after inspection confirms existing single-draft controls stay quiet.

22 focused browser journeys pass, covering both single/alternative help modes,
manual returns, stale/unknown saves, unrelated drafts, simultaneous handoffs,
reconnect and crowded-room returns. The independent reviewer checks the exact
earlier selected body/hash; human approval remains pending and markers stay zero.

## Final qualification and handoff

- 587 core/API/package checks pass. Existing contribution tests now also verify
  multiple-draft count, plural labels and one work entry, preserving stale and
  permission/claim cases.
- All184 browser tests pass (171 seconds), including two new desktop/touch
  alternative-contribution journeys and the existing182 cases.
- 14 local Workers checks pass, including browser and exact populated schema12
  candidate → pause → fallback → candidate switching.
- Two exact-commit desktop/touch fallback browser checks pass.
- Candidate `../project-room-runtime-packages-20260908/candidate-cf377f3` verifies:
  65 runtime files,19 public assets,schema/writer12. Source tree:
  `667ed620dbfa752f88913a38a508823a42f65655`.
  Manifest SHA256 `3925c015d42392d85be10219d66b66bd8dbe64462fdceb2b75b2c989d232dfa1`.
  Only app.js,styles.css,work-selectors.js differ from candidate51045a1. Fallback
  4d22189 remains unchanged; no schema migration was needed for draft choices.
- Eight inspected screenshots (two before/six after), two validated scripted
  journey records and four successful verification logs are retained at
  `../project-room-runtime-packages-20260908/evidence-alternative-contributions`
  relative to repository root. Final screens show choices,200% text and adoption
  of the earlier proposal. Body/hash and contributor assertions are in the tests.

No new service, provider, tool, permission, automatic work, notification or payment.
No push, deployment, live changes, native model or preview restart. The broad goal
is active/incomplete. Source/handoff claims released at checkpoint. Next implement
the help-wanted vertical slice, reviewing invalidation granularity so harmless
lease/start updates do not unnecessarily erase useful consent. The state machine,
migration/fallback qualification and human/agent setup must be verified together;
this design document is not proof that those future features are implemented.

## Implemented next: dormant shared help contract

The next checkpoint adds `src/work-help.js` and17 focused tests. It is deliberately
not registered in the event reducer, command router, browser assets or runtime
package. This is implementation progress toward the help feature, not a usable
help-wanted release. The exact schema12 service/reducer still reject the future
event, and the rejected command leaves all audited database tables unchanged.

The shared contract implements:

- One optional `helpWanted` projection on existing work. No default backfill;
  an absent field is off, whereas a malformed present field is an error, not consent.
- `work.help_updated` with exact work/help revisions. Open data includes a scope
  and canonical UTC expiry; withdrawal cannot carry a replacement scope. The scope
  preserves exact Unicode/whitespace, is capped at600 UTF-16 code units, and expires
  within seven days. These are initial product bounds, not research-derived limits.
- Accepted, working or blocked work may invite help. Only its active accountable
  human/agent with `accept_work` can publish or reaffirm. The active accountable
  member may still withdraw after losing that permission. The active human Room
  owner may withdraw someone else's invitation but cannot publish it for them.
- Independent help revision and original signal ID, latest event/actor/time,
  exact scope and expiry, work basis, accountable identity/revision and most recent
  completion event. Updating help does not change task revisions or stale drafts.
- Read-only contextual status and room-level canPublish/canWithdraw/canOffer flags.
  A helper must be active, different from the accountable member, and not that
  work's designated independent reviewer. These flags do not bypass current
  credential, connection, sponsor, session or external-tool authorization.
- Withdrawal retains scope, issuing identity and original signal ID for context;
  it does not delete offers, drafts or work. Expiry uses an explicit evaluation time
  and does not mutate a room or advance a read marker.

### Invalidation decision, now exercised against the real work reducer

The work definition and accountable identity currently cannot be edited in place;
changed definitions use replacement work. Therefore a blanket work-revision match
would incorrectly cancel consent on starts, claim changes and historical checks.
The contract instead anchors the accountable membership revision and current
completion event at each explicit opening/reaffirmation:

- Starting, ordinary blocking/resolution, claim release/reacquisition and historical
  review preserve a still-current invitation. Claims have no direct renewal action;
  tests use the actual release/reacquire sequence.
- Completion closes discovery. A subsequent block/reopen retains the completion
  receipt in the existing reducer, so its different event ID prevents resurrection.
  Explicit reaffirmation records that new work cycle. Another completion closes it
  again. A replacement work record never inherits the invitation.
- Revocation makes the accountable participant unavailable. Restoration does not
  restore old consent because membership revision advanced. Even a permission-
  preserving access event requires reaffirmation: a conservative, explicit choice.
- Expiry is exclusive at the exact boundary. Evaluation before openedAt does not
  expose future consent; writes earlier than the previous help update are refused.
  Expiry remains a derived wall-clock status, not a persisted irreversible event;
  this does not establish a monotonic clock across a host clock correction.

17 focused tests cover these paths, both update/withdraw orderings, late stale
create/update intent, bounds, invalid records and participant identity binding.
The full604 core/API/package checks pass. Tests intentionally apply the pure help
constructor outside the current reducer; they are not end-to-end help writes,
simultaneous database races, native-agent reasoning or browser acceptance.
Initial claim-fixture errors (repository/ref fields and unsupported renewal) were
corrected to exercise existing claim behavior, not by weakening the reducer.

All65 existing runtime files match candidatecf377f3 byte-for-byte. Its19 assets,
schema12 and fallback4d22189 remain verified and unchanged. No new browser or
Workers suite was needed for this dormant module;184 browser/14 Workers/two exact
fallback checks remain evidence from the previous runtime checkpoint, not new runs.
No UI changed, so no new screenshots were taken. Final core output is retained in
`../project-room-runtime-packages-20260908/evidence-help-contract/core.log`.

### Next integration sequence: still required before calling this complete

1. Add the semantic event and command shape together with writer13. Preserve all
   historical Node guards, add schema12 to the accepted migration sources and
   Durable Object old-guard/permit lists, and verify already-open12 writers cannot
   mutate13 data. Reject legacy helpWanted projection/checkpoint field collisions
   rather than reinterpret ignored data. Keep older public-asset manifests exact.
2. Audit help through all retained history, including help hidden behind a
   checkpoint. The auditor needs historical work revisions, accountable membership
   revisions and completion anchors. It must not replay unrelated legacy work
   under new transition rules. Test both help and supporting-fact corruption,
   provenance, absence and migration rollback before runtime enablement.
3. Wire generic authenticated commands and exact receipts. Allow withdrawal at
   room capacity, retain stable retries, and test two real database connections
   racing update/withdraw/create. Replayed old receipts must not imply current
   help is open. Pure-contract stale tests above do not replace these checks.
4. Add optional selected-context/discovery fields and a thin shared client/MCP
   path. Include accountable membership revision in the selected facts required
   to validate supplied guidance. Old services remain unavailable, not implicitly
   open. Filtering must respect pagination and a single service evaluation time.
5. Bind the explicit offer path to the exact current help event/revision and enforce
   limits in the service. Merely posting a reply request does not yet do this.
   Preserve ordinary conversation without treating it as an invitation-bound offer;
   no automated assignment, execution, duplicate task or inferred acceptance.
6. Add contextual human controls with short scope/expiry input and explicit
   withdrawal. Preserve unknown-save inputs/retries, keyboard/mobile/large-text
   behavior and other drafts. Test accountable human/agent, helper and reviewer
   end-to-end, including multiple offers and withdrawal while an offer is in flight.
7. Produce distinct schema13-compatible candidate/fallback packages, then qualify
   populated migration, restoration and package switching with current authority.
   Current schema12 fallback is not a future13 rollback. Re-run core/browser/Workers
   checks and retain inspected screenshots before calling the whole slice usable.

No deployment, push, provider change, paid model, live migration or existing preview
restart. This goal remains active/incomplete; a tested dormant contract is not the
full human/agent help-wanted feature or a deployment-ready schema13 candidate.
