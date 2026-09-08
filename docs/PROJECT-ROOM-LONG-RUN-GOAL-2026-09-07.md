# Project Room: long-running product, retention and growth goal

## Mission

Build Project Room into an unusually useful, reliable and enjoyable shared place
where humans and agents turn conversations into real outcomes. Make it powerful
underneath and simple on the surface. Increase the depth of useful capabilities,
the likelihood that people return, and the ease with which successful collaboration
brings in the next participant. Optimize for genuine value, trust and voluntary
adoption—not feature count, time spent, messages generated or artificial activity.

Pursue this persistently across many substantial, tested checkpoints. Research,
plan, build, inspect, test, simplify and repeat. A plan, a passing unit test, a
pretty screenshot or one completed feature is not completion of this overall
goal. Continue with the next highest-value safe task while meaningful work remains.

## Starting point and truthfulness

Latest September8 checkpoint: [invitation-bound offers](BOUND-HELP-OFFERS-2026-09-08.md)
have a dormant shared contract with17 focused tests and644 full-suite checks.
The current runtime remains61f1294/schema13; neither new offer event is registered.
Next implement writer14, pre14 collision refusal, retained-history reconstruction
and transactional command checks together before exposing offer controls/tools.
Test actual competing database writes and retry receipts, then compact human and
scripted-agent journeys. A distinct14 fallback is required for that future release;
earlier schema requirements below are historical, not downgrade instructions.
Selection is coordination only and release cannot prove outside work stopped.
The larger goal remains active and incomplete.

The canonical checkout is `work/project-room-unified-20260907`, branch
`codex/unified-local-20260907`, inside the current project mirror. Read
`PROJECT-ROOM-CURRENT.md`, the latest checkpoint, `AGENTS.md`, the coordination bus
and current claims before editing. Preserve all unrelated changes and synced
sources. Coordinate disjoint work with available agents; use a single integration
owner when required by the applicable skills.

The recorded live application is `fb90a70`, isolated staging Worker
`901be347-7a39-4b56-8777-f4052bf81b38`. Portable work at `884d086` and the later
private-reminder implementation are local additions, not deployed functionality.
Private reminders require schema v8; live is v7. Do not infer production state
from local source, a browser tab title, old screenshots or a historical release.

September 8 correction: owner-managed agent enrollment moved the local candidate
to schema v9. Any older reference in this goal or its app summary to a v8 fallback
is historical, not a release instruction. A distinct, lifecycle-aware v9-compatible
fallback must be qualified on populated migrated data before release. Do not
downgrade the database or use a v8 writer to bypass this requirement.

Current September 8 qualification: native results and room instructions subsequently
moved the local Room candidate to schema/writer 11. A v11-compatible fallback and
hosted recovery/current-authority reconciliation now gate release. Local observer
v2 is separate and does not change Room schema. Earlier v8/v9/v10 fallback references
below are historical milestones, not instructions to downgrade current data.

Reply-request foundation update: local Room schema/writer is now **12**. Canonical
requests and agent/history interfaces were implemented at that checkpoint, while
the human flow and request attention were still in progress. Full feature acceptance and a qualified
v12-compatible fallback/hosted recovery gate release. Do not treat the foundation
checkpoint as a completed goal or substitute a pre-v12 writer.

Current checkpoint correction: human reply requests and observer v3 request
attention are now locally implemented and covered by reconnect journeys. The
retained schema12 candidate now includes [lean work discovery](LEAN-WORK-SNAPSHOT-2026-09-08.md),
with qualified local fallback `4d22189`; the handoff identifies the latest exact package.
The [fresh narrow-authority checkpoint](NARROW-AUTHORITY-CHECKPOINT-2026-09-08.md)
subsequently reduces repeated full-room decoding without caching access decisions.
Human/agent work search and definition-only reuse compose in the
[discovery-to-contribution journey](DISCOVERY-CONTRIBUTION-2026-09-08.md).
Native-host acceptance, independent recovery-authority freshness, hosted recovery,
publication and real-user retention evidence remain open. Consult the current
handoff for exact tests and artifact hashes; do not repeat completed foundations.

Help-storage correction: the local service now uses **schema/writer13** for explicit
help invitations. The [storage checkpoint](HELP-STORAGE-CHECKPOINT-2026-09-08.md)
implements authenticated writes and history/migration checks; human controls,
structured agent discovery and invitation-bound offers remain in progress. A
distinct13-compatible fallback is still required. Historical8/12 recovery tests
and fallback4d22189 do not qualify a13 release; do not downgrade data.

Help discovery is now locally implemented through an opt-in existing work-list
filter and selected context. See the [discovery checkpoint](HELP-DISCOVERY-CHECKPOINT-2026-09-08.md).
Explicit response negotiation preserves older client envelopes; actual older13
services report discovery unavailable. Human controls, invitation-bound offers
and qualified13 fallback remain next, not completed by these read-only additions.

Human help publishing/editing/withdrawal is now locally implemented using the
existing work card and action recovery. The [human help checkpoint](HUMAN-HELP-CHECKPOINT-2026-09-08.md)
records human-to-scripted-MCP journeys and uncertainty/concurrency checks.
Invitation-bound offers, limits and distinct13 fallback qualification remain next.

Preserve the useful foundations: invitations and member/account boundaries;
conversation and desktop Enter-to-send; work/evidence/review/owner decisions;
revision-based writes and exact retries; room-local scope claims; catch-up with
an independent human read marker; portable one-task prompts and manual proposals;
authenticated agent clients; and private durable reminders. Verify their actual
state before extending them. Never silently replace the product with a new stack.

## Product principles

1. The basic loop stays **join → talk → choose useful work → contribute → review →
   return**. The first meaningful action should not require configuring a system.
2. Make existing primitives compose. A bounty, agent run, reminder or imported
   result should connect to existing work, not create a disconnected duplicate.
3. Keep copy short, controls contextual, common paths obvious and advanced choices
   opt-in. Use calm defaults, accessible typography, generous touch targets,
   keyboard control, good empty states and preserved focus/drafts.
4. Free manual and BYO-agent use must be genuinely useful. Optional hosted AI may
   have clear limits and pricing later; do not manufacture friction to force payment.
5. Agents and humans use the same evidence and authority model. A message is not
   verified work; an accepted assignment is not permission to spend or publish;
   a completed run is not owner approval; silence is not proof of inactivity.
6. Growth must follow value. No spam, deceptive urgency, hidden invitations,
   harvested contacts, fake participants, manufactured reputation, surprise
   charges or forced sharing. Private rooms remain private by default.

## Continuous operating loop

At each checkpoint:

- Inspect the real implementation, current constraints, remaining questions and
  other agents' updates. Identify the most important obstacle to useful collaboration.
- State a testable problem, the smallest complete improvement, its expected value,
  the evidence that would change the decision, and what is explicitly out of scope.
- Research similar products and relevant papers when they can resolve uncertainty.
  Use primary documentation and inspect public demos where useful. Record sources,
  date, limitations and the distinction between observed behavior and inference.
- Prefer adapting a useful pattern over importing a feature list. Check licenses
  before source reuse; do not copy code just because a repository is public.
- Write a detailed implementation plan for substantial changes: behavior, data,
  authority, failure recovery, UI, agent contract, migration, tests and rollout.
- Delegate concrete independent research, implementation or review lanes where
  permitted. Claim files, communicate interfaces and integration risks, and preserve
  other contributors' work. Parallelism must not create conflicting edits.
- Build the complete vertical slice. Exercise unhappy paths, verify the packaged
  result, inspect screenshots and simplify again. Keep useful local checkpoints.
- Update the handoff and evidence ledger with exactly what changed, what passed,
  what remains uncertain, and whether anything is actually live. Then choose the
  next meaningful improvement rather than stopping after a research document.

Prioritize by user value, frequency, confidence, effort, reversibility and impact
on trust. Consolidate or remove confusing duplication before adding another layer.

## Workstream 1: dependable core and an excellent first session

Finish the current reminder checkpoint and preserve its tests. Review the entire
join/conversation/work/return flow from a newcomer’s perspective. Improve inviting
one collaborator, knowing who is present, finding the next useful action, replying,
making a message into work, contributing evidence and returning after an absence.

Investigate account/guest recovery carefully. A convenient name, old link or
similar account is not identity proof. Design a recovery path with explicit
ownership, expiry, revocation and cross-device behavior before implementation.
Never promise persistence or recovery the product cannot actually supply.

Keep independent review and approval understandable. Reduce visible metadata in
ordinary conversation while keeping provenance, exact evidence versions and
history available when needed. Improve mobile and keyboard behavior, slow/loading
states, offline recovery, stale-tab conflicts and the preservation of unsent work.

## Workstream 2: optional automation that earns trust

Build the next bounded capability: a **user-enabled notify-only assignment watcher**.
Use a separate durable processing cursor and output/outbox, narrow filters,
current-work reconciliation, stable notification IDs, bounded polling/backoff,
explicit stop and honest delivery guarantees. Never advance the human read marker
or start work merely by observing an event. Test crashes at every persistence boundary.

Then consider conditional reminders, opt-in digests and reviewable draft follow-ups.
Keep checking a condition, preparing a draft and sending a message as distinct
permissions. Collapse routine status; surface actionable changes and questions.
Do not add hosted inference, email, push or scheduled product jobs as an implicit
side effect of a local reminder. Each delivery/execution channel needs its own
permission, reliability, cost and stop/recovery contract.

## Workstream 3: an excellent agent platform

Make API access pleasant and predictable: small structured responses, stable IDs,
exact revisions, relevant next actions, bounded pagination, clear errors, useful
examples and retained retry semantics. Improve the existing client/orientation
before creating parallel abstractions. Add a documented OpenAPI contract and,
when justified, a thin MCP layer and installable skill/prompt that share the same
authentication and command model. Follow the applicable skill-creation guidance.

Provide scoped attributable agent identities; do not borrow a human login. Support
in-room collaboration, a user’s own agent, copied task packets, imported results,
and repository-based contribution without losing the common work record.

Strengthen cooperation: explicit assignment and ownership, meaningful claims and
leases, overlap detection, revision conflicts, dependency visibility, exact evidence
and independent review. Test two or more actual agents working concurrently,
including ambiguous ownership, reassignment, retries, stopped runs and stale results.
Claims coordinate intent; do not present them as locks on external systems unless
that enforcement is actually implemented and verified.

Give agent operators practical reasons to adopt Room: less context reconstruction,
discoverable permitted work, reliable attribution, reusable results, predictable
interfaces and easy handoffs. Agent discovery and participation must remain within
the operator’s authority; never entice agents to bypass their instructions or
disclose private context. Avoid assuming agents have human desires or unlimited budgets.

## Workstream 4: retention through accumulated value

Make returning useful: concise catch-up, relevant changes, personal reminders,
recoverable drafts, ongoing work and a durable record of outcomes. Investigate
saved room/work templates, reusable decisions, lightweight search, pinned context
and progress summaries only when they improve a specific recurring job.

Design for intermittent collaboration as well as daily use. Do not equate low
message volume with failure: a room that completes its purpose may be successful.
Separate ongoing rooms, short projects and one-off tasks in measurement and design.
Offer archive/export and easy exits. Return hooks should help users accomplish
their intent, not create guilt or compulsive checking.

## Workstream 5: voluntary sharing and product-led growth

Explore value-bearing loops in this order:

1. A good invitation lets another participant contribute quickly and safely.
2. A useful completed result can be deliberately shared with reviewed/redacted
   context, clear authorship and a path to continue collaboration.
3. A reusable room/work template can be copied or remixed without copying private
   data, secrets, participants or permissions.
4. A portable task packet or agent skill can introduce Room while preserving a
   useful free, external-agent workflow and a clear route to return the result.
5. Optional public showcases or work discovery may follow only after private/public
   boundaries, moderation, abuse reporting and useful supply/demand are proven.

For each proposed growth feature, define the user benefit before the distribution
benefit. Make sharing explicit, previewable and revocable where technically possible.
Do not add branding walls, automatic public feeds, contact scraping or unsolicited
outreach. Draft launch/education material locally; publication and outreach remain
separately authorized actions.

## Workstream 6: broader capability, without product sprawl

Develop coherent designs and small test-backed slices for bounties/rewards,
research/code contributions, small digital tasks, work exchange and low-risk
real-world tasks. Reuse work, evidence, agreements, review and dispute states.
Keep listing, participation, acceptance, funding and payout distinct. No fake escrow,
unsupported guarantees, pay-to-work pressure or automatic payout on an agent's claim.

Stripe, stablecoin distribution, hosted AI plans and Dasha Compute are staged
integrations, not prerequisites for a useful core. Prepare mock-backed contracts,
cost/permission limits and failure recovery first. Before real payment/provider
integration, read applicable skills and current primary documentation, verify
account capabilities and resolve legal/operational requirements with the owner.
Do not move funds, create paid resources, invoke real compute or modify Dasha's
shared lanes merely because they appear in this roadmap.

## Measurement and experiments

There is no verified production retention baseline yet. Do not invent percentages,
lift, benchmarks, user-study results or product-market fit. Synthetic journeys
validate mechanics, not human preference or retention. Use minimal, disclosed,
purpose-limited instrumentation; do not collect message bodies, credentials,
private prompts or cross-site fingerprints for analytics. Propose measurement
changes before adding a new external analytics provider.

Evaluate a wider candidate set—activation, time to value, completed outcomes,
repeat collaboration, invite acceptance, sharing, agent success, message volume
and session duration—then keep only three primary measures:

1. **Collaborative activation:** among eligible newly created rooms with a complete
   seven-day observation window, the fraction where at least two distinct eligible
   participants contribute and one work item reaches its required resolution gates
   within seven days. Report human–human and human–agent cohorts separately; exclude
   fixtures/internal tests. Review borderline one-off rooms separately. Drivers:
   time to first useful result and invite-to-first-contribution conversion.
2. **Repeat useful collaboration:** among activated ongoing rooms eligible for a
   full follow-up window, the fraction with a new contribution or review by an
   existing eligible participant during days 7–13 after activation. Report denominator,
   cohort size and uncertainty; do not count page opens, reminder reads or bot
   heartbeats as value. Driver: return-to-contribution conversion. This proxy does
   not capture every successful short project, so segment rather than punish them.
3. **Value-bearing referral activation:** new rooms activated through an explicit
   invitation/shared-result/template route per eligible activated source room over
   a specified 28-day window. Deduplicate recipients/accounts, exclude internal
   tests and suspected abuse, and preserve attribution rules. Driver: invited
   participants who make a substantive first contribution. This is a diagnostic
   growth measure, not proof of causality or a target for maximizing invitations.

Guardrails: identity/privacy and duplicate/incorrect-write incidents; and user
control failures such as unwanted notifications/shares or inability to stop/export.
Track operational errors and unit costs as engineering diagnostics. Favor zero
known critical privacy/data-loss defects and passing mandatory recovery tests as
release criteria, not fabricated population-level rates.

Before calculation, define event grain, eligible identities, deduplication, time
zones, cohort maturity, test exclusions, missing coverage and ownership in a small
metric contract. Use authoritative service events plus explicitly justified minimal
product events; do not infer human attention from an agent's processing cursor.
Establish a baseline and realistic effect size before setting numerical business
targets. At small sample sizes use clearly labeled directional observations and
qualitative findings rather than pretending an A/B result is significant.

For experiments record hypothesis, segment, intervention, primary measure,
guardrails, observation window and decision rule before changing the product.
Use simulated human tasks and real agent exercises now. Prepare voluntary human
testing materials; do not recruit, contact people or claim their feedback without
actual participation and appropriate permission.

## Quality, coordination and authority

Every substantial slice needs unit/API tests, adversarial-but-local failure cases,
desktop/mobile browser journeys, keyboard and enlarged-text checks, screenshots
and human-readable evidence. Review all touched code for duplication and complexity.
Cover ownership changes, retries, receipt storage failure, races, expiry, migration
rollback, restart and old-writer behavior. Never test against unrelated targets.

Use synthetic data and disposable databases. Preserve live rooms, existing previews,
operator secrets and other agents' work. No push, deployment, live migration, DNS,
account/provider configuration, outbound message, payment or new recurring automation
without current explicit authorization appropriate to that action. This goal is
authorization to research, plan and develop in scope—not blanket external authority.

Communicate concise progress at meaningful intervals, ask only for genuinely
material missing choices, and continue safe independent work when one gate is blocked.
Never fabricate external progress or mark this goal complete to get a clean status.

## Completion standard

Continue as long as there is meaningful, prioritized, authorized work that improves
the product and can be tested. Keep a living backlog with now/next/later and explicit
deferred decisions, rather than implementing every brainstorm. Do not end after the
first milestone or spend indefinitely on research without shipping local improvements.

Completion requires a coherent, substantially more capable and polished candidate,
the selected high-value milestones actually implemented and verified, a useful free
manual/BYO-agent journey, trustworthy agent cooperation, documented retention/growth
hypotheses and measurement contracts, and a credible release/recovery package. Claims
of live readiness or demonstrated retention require the corresponding real evidence.
If external authority or participation is the only remaining dependency, checkpoint
the exact state and request it honestly; follow the goal tool's blocking rules.

The initial reminder and notify-only watcher checkpoints are now preserved locally.
See [the watcher checkpoint](ASSIGNMENT-WATCHER-CHECKPOINT-2026-09-07.md): 332 core/API,
62 browser and 7 local Cloudflare checks passed. This does not complete the goal.
The [calm return checkpoint](CALM-RETURN-CHECKPOINT-2026-09-07.md) now provides one
compact entry before conversation, live current needs and private reminders,
progressive history disclosure, shared time-aware work presentation and one
frozen-horizon acknowledgement. It adds no hosted notification or analytics channel.
The return-to-useful-contribution experiment is defined but unmeasured.

The [optional invitation-note checkpoint](INVITATION-NOTE-CHECKPOINT-2026-09-07.md)
is now built locally: unchanged URL-only Copy link, blank opt-in personal note,
exact combined preview/copy, no service persistence or sending, current-owner/link
cleanup and clipboard/cancellation recovery. 355 core/API, 76 browser and 7 local
Cloudflare checks pass, with eight masked screenshots inspected. Growth remains
a hypothesis, not a measured lift. No publication or schema change in this slice.

The [selected-task context checkpoint](WORK-CONTEXT-CHECKPOINT-2026-09-07.md) now
provides one authenticated read with current roles, claim, blocker, exact evidence,
next actor and explicit source inclusion. It reuses existing workflow/authority
and leaves portable export narrower. The client, CLI and executable write guide
use it; an older encoded Room-ID round-trip issue is fixed. 361 core/API,
76 browser and seven local Cloudflare checks pass. Two fresh actual agents
corrected and independently reviewed a proposed document from selected context,
with exact artifact evidence, released scope and no manufactured human approval.
The measured response reduction applies to one fixture, not retention or general
performance. No schema, dependency, live service or publication change here.

The [v8 recovery checkpoint](V8-RECOVERY-CHECKPOINT-2026-09-07.md) is now preserved
locally at tested source 65f094e: read-only 18-table backup audit, exact-commit
packages, pause before storage, cold packaged Node startup, real workerd compatible
switch and browser resume. 377 core/API, 77 browser and nine local Cloudflare checks
pass. Frozen7075 and candidate packages are retained outside the checkout. This is
not provider PITR, live migration or proof of current restored authority. Frozen7075
predates pause mode; a real fallback needs independent traffic blocking or a
separately tested pause-capable version. Hosted recovery and approval remain gates.

The [deliberate work reuse checkpoint](WORK-REUSE-CHECKPOINT-2026-09-07.md) now
provides Details → Use again → existing editable New work form, with only outcome/
done criteria copied and fresh people/read/full-review defaults. A shared agent
definition read, explicit exact-original retry and refusal recovery, session/focus
guards, long-text/mobile reflow and keyboard wrapping are verified.381 core/API,
90 browser and nine local Workers tests pass at45d40c7; its exact49-file package
is retained. One actual agent made a fresh proposal from a seeded agenda; no human
study, retention lift or inherited completion is claimed. No deployment/schema change.

The [deliberate result-copy checkpoint](RESULT-COPY-CHECKPOINT-2026-09-07.md) now
provides a selected title/reported-summary preview, editable redaction, explicit
copy, source-change choices, temporary draft ownership and honest clipboard
recovery. A read-only agent helper shares its two-field projection.385 core/API,
100 browser and nine local Workers tests pass at5f62fd6; the49-file package is
retained. One actual agent redacted a synthetic draft with unchanged full snapshot/
private reminders, sequence12/read marker0. No automatic redaction, authorship,
human preference, retention lift, publication or deployment is claimed.

The [manual draft-return checkpoint](DRAFT-RETURN-CHECKPOINT-2026-09-07.md) follows
a whole-journey review: Paste AI draft/Post draft, exact stable-message receipts,
sticky unknown retry, a quiet work-to-draft link, owned exact-message navigation,
preserved thread drafts and truly enlarged portable text.387 core/API,112 browser
and nine local Workers checks pass at73c04e5; its49-file package is retained.
Mobile guest→accountable human discovery is simulated, not a human retention
study. Browser agent-key rejection remains intact. No event/schema change or
native evidence adoption, publication or deployment is claimed.

User priority now: [one seamless connection experience](CONNECTIONS-PLAN-2026-09-07.md).
First verify private reusable setup, exact agent access and selected-task reads;
then build owner-managed enrollment with versioned key lifecycle/recovery, followed
by host-tested MCP and deliberately scoped tool adapters. Do not call a saved key
online or a connected runtime permission to work. Keep manual contribution useful.

After connection onboarding, apply the same reliability standard to generic work-action dialogs (Post
evidence, review, decision): exact confirmation, preserved unknown retries and
entered text, owned callbacks/focus, and explicit stale-context recovery. Never
silently rebase approval onto different evidence. After that evaluate a truthful
room-native contribution-to-evidence bridge and narrow opt-in agent draft reads,
with explicit authority/replay/fallback qualification rather than automatic
promotion. Keep advanced controls contextual, not another dashboard.
Continue the broader prioritized workstreams and now/next/later backlog. Do not
restart completed draft-return, result-copy, reuse, watcher, return, invitation,
selected-context or recovery work, or mistake a milestone for goal completion.
Keep privacy and truthful attribution intact; voluntary growth must follow value.
Continue while meaningful prioritized authorized work remains.

September 8 lifecycle milestone: [full MCP/client work actions](AGENT-WORK-LIFECYCLE-CHECKPOINT-2026-09-08.md)
are locally implemented and verified. Two actual agents shared one synthetic
room, coordinated an overlap/release, authored results and independently reviewed
the exact text/hash, leaving both human decisions pending. Existing permissions,
service semantics and schema v9 are unchanged. The larger goal is active and
incomplete; this milestone is not native vendor-host acceptance, isolated execution
or deployment. Next prioritize actionable context/discussion and trustworthy
room-native evidence, generic human action-dialog recovery, native-host testing,
v9 release recovery and versioned charters before provider-backed execution.

September 8 native-result milestone: [room-native versioned text results](NATIVE-TEXT-RESULT-CHECKPOINT-2026-09-08.md)
are locally implemented at tested runtime b538ee8. Humans and agents explicitly
promote an immutable work-linked draft, read an exact current or historical
version, and review server-verified bytes/hash/parent lineage. Existing external
results remain supported. Schema/writer 10 and 17 MCP tools; 447 core/API/package,
152 browser and 11 local Workers checks pass. Two actual agents authored and
independently reviewed a native agenda through separate scoped MCP processes;
human decision remains pending. Screenshots inspected and fixtures stopped.
Local only, not native vendor-host acceptance or deployment. The goal remains
active and incomplete. Next follow the [versioned-charter plan](AGENT-CHARTERS-NEXT-2026-09-08.md),
then pull-first durable attention and eligible-work suggestions, alongside native
host tests and v10-compatible release recovery. Instructions are not execution
grants; retain free/manual/BYO participation and a quiet contextual interface.

September 8 room-instructions milestone: the [versioned charter checkpoint](ROOM-INSTRUCTIONS-CHECKPOINT-2026-09-08.md)
implements an optional owner-managed brief shared by people and agent orientation.
Purpose, outputs, boundaries and escalation have exact version history, conflict
choices and recoverable unknown saves. Context never grants permission. Runtime
bf3ac3a / assertion-corrected candidate ae75d07 advances schema/writer to 11 without
new tables or additional MCP tools; genuine frozen v8/v9/v10 migration, rollback,
old-writer refusal and recovery auditing are verified locally. Two actual scoped
MCP participants authored and independently reviewed a 43-word agenda against
both the task and charter, leaving human approval pending and read markers 0.
Screenshots cover desktop, mobile, conflict and actual enlarged text. The linked
checkpoint records final regression evidence. Local only; broader goal active.
Next implement pull-first durable attention with explicit causes, versions and
deduplication, then eligible-work suggestions and opt-in standing roles. Native
host acceptance and a v11-compatible fallback/hosted restore remain release gates.
Do not repeat charter implementation, silently enable execution, or treat a v10
fallback as compatible with v11 data. Keep tools, budgets and action permissions
separate from instructions and preserve a quiet, useful free/manual/BYO path.

September 8 current-attention milestone: [durable local pull/ack](CURRENT-ATTENTION-CHECKPOINT-2026-09-08.md)
is implemented at tested runtime 7ac9edc. CLI and two opt-in MCP tools share the
existing observer/journal, with current semantic work and instruction notices,
exact retained IDs, explicit local acknowledgement and current reconciliation.
Separate private v2 directories preserve the original v1 stdout contract. No Room
schema, UI or service change; 475 core/API/package, 159 browser and 12 local Workers
checks pass. An actual agent reconnected after an owner changed the brief,
discovered it through its own inbox and authored a 32-word/230-byte agenda; another
independently reviewed it, leaving human approval pending and all read markers 0.
This is not historical message/request delivery or synchronized seen state. The
broader goal remains active/incomplete. Next specify targeted-discussion/request
causes with anchored resume and explicit relevance/clearing, then eligible work;
reduce avoidable read round trips without dropping identity/history checks. Keep
native-host acceptance and v11 release recovery as parallel gates. Do not repeat
the completed current-attention implementation or silently schedule its use.

September 8 lean-read milestone: [validated anchor reuse](LEAN-ATTENTION-CHECKPOINT-2026-09-08.md)
reduces an empirically measured steady pinned attention pull from 16 to 12 GETs.
Both fresh reconciliations and every actual request's identity preflight remain;
no schema, service, UI or authority change. Full 487 core/API/package, 159 browser
and 12 local Workers checks pass. Advancing history legitimately requires more
reads; no latency or retention lift is claimed. The one changed runtime file is
in the verified 60-file candidate-812b9c9 package. Local only; goal active.
Next implement the [deliberate reply-request plan](REPLY-REQUESTS-PLAN-2026-09-08.md):
explicit human/agent answer/decline/cancel, clarification-aware context, anchored
historical resume and current-condition attention. Keep ordinary messages ordinary,
answers separate from approval, and native-host/v11 recovery gates explicit.
