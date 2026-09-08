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
