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

The immediate next checkpoint after preserving private reminders is the notify-only
watcher plan and first tested implementation, followed by onboarding/return-flow
refinement and the highest-confidence invitation/portable-work growth experiment.
